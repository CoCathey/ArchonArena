const { Server } = require('socket.io');
const Socket = require('./socket.js');
const jwt = require('jsonwebtoken');
const _ = require('underscore');

const logger = require('./log');
const PendingGame = require('./pendinggame');
const GameRouter = require('./gamerouter');
const ServiceFactory = require('./services/ServiceFactory');
const DeckService = require('./services/DeckService');
const UserService = require('./services/UserService');
const ConfigService = require('./services/ConfigService');
// ARCHON: native tournaments create/report lobby games automatically
const TournamentService = require('./services/tournament/TournamentService');
const tournamentEvents = require('./services/tournament/tournamentEvents');
// ARCHON: Quick Match matchmaking queue (Amber-based pairing)
const MatchmakingService = require('./services/matchmaking/MatchmakingService');
const RatingService = require('./services/rating/RatingService');
const User = require('./models/User');
const { sortBy } = require('./Array');

// ARCHON: game formats a player can queue for in Quick Match.
const MATCHMAKING_FORMATS = [
    'normal',
    'sealed',
    'reversal',
    'adaptive-bo1',
    'alliance',
    'unchained'
];

class Lobby {
    constructor(server, options = {}) {
        this.sockets = {};
        this.socketsByName = {};
        this.users = {};
        this.games = {};
        this.configService = options.configService || new ConfigService();
        this.messageService = options.messageService || ServiceFactory.messageService();
        this.cardService = options.cardService || ServiceFactory.cardService(options.configService);
        this.userService = options.userService || new UserService(options.configService);
        this.deckService =
            options.deckService || new DeckService(this.configService, this.cardService);
        this.router = options.router || new GameRouter(this.configService);

        this.router.on('onGameClosed', this.onGameClosed.bind(this));
        this.router.on('onGameRematch', this.onGameRematch.bind(this));
        this.router.on('onGameRematchWithNewDecks', this.onGameRematchWithNewDecks.bind(this));
        this.router.on('onPlayerLeft', this.onPlayerLeft.bind(this));
        this.router.on('onWorkerTimedOut', this.onWorkerTimedOut.bind(this));
        this.router.on('onNodeReconnected', this.onNodeReconnected.bind(this));
        this.router.on('onWorkerStarted', this.onWorkerStarted.bind(this));

        // ARCHON: tournament engine integration - auto-created table
        // games per pairing and auto-reported results (Phase 7 inc. 2)
        this.tournamentService = options.tournamentService || new TournamentService();
        this.router.on('onGameWin', this.onTournamentGameWin.bind(this));
        tournamentEvents.on('roundPaired', this.onTournamentRoundPaired.bind(this));
        tournamentEvents.on('ensureMatchGame', this.onTournamentEnsureMatchGame.bind(this));

        // ARCHON: Quick Match matchmaking - queue players and pair them by Amber.
        this.ratingService = options.ratingService || new RatingService(this.configService);
        this.matchmaking = options.matchmaking || new MatchmakingService();
        // Re-attempt pairings periodically so waiting players match as their
        // Amber tolerance widens, even when nobody new joins. Unref'd so it
        // never keeps the process (or a test runner) alive on its own.
        this.matchmakingSweep = setInterval(() => this.runMatchmaking(), 3000);
        if (this.matchmakingSweep && this.matchmakingSweep.unref) {
            this.matchmakingSweep.unref();
        }

        // Automatic inactive-player rating decay. Ticks hourly but only applies
        // as often as the admin-configured cadence (decay.autoApplyHours), and
        // is a no-op while decay is disabled. applyDecay is idempotent (it
        // writes absolute ratings gated by LastDecayAt), so a tick with nothing
        // due - or one overlapping another lobby instance - is harmless.
        this.lastDecayRunMs = 0;
        this.decaySweep = setInterval(() => this.runDecaySweep(), 60 * 60 * 1000);
        if (this.decaySweep && this.decaySweep.unref) {
            this.decaySweep.unref();
        }

        this.userService.on('onBlocklistChanged', this.onBlocklistChanged.bind(this));

        this.io =
            options.io ||
            new Server(server, {
                perMessageDeflate: false,
                pingTimeout: 30000
            });
        this.io.use(this.handshake.bind(this));
        this.io.on('connection', this.onConnection.bind(this));

        this.messageService.on('messageDeleted', (messageId, user) => {
            for (let socket of Object.values(this.sockets)) {
                if (socket.user === user || (socket.user && socket.user.hasUserBlocked(user))) {
                    continue;
                }

                if (
                    socket.user &&
                    socket.user.permissions &&
                    socket.user.permissions.canModerateChat
                ) {
                    socket.send('removemessage', messageId, user.username);
                } else {
                    socket.send('removemessage', messageId);
                }
            }
        });

        setInterval(() => this.clearStalePendingGames(), 60 * 1000); // every minute
        setInterval(() => this.clearOldRefreshTokens(), 2 * 60 * 60 * 1000); // every 2 hours
    }

    // Periodic (hourly-checked) automatic rating decay, gated by the
    // admin-configured cadence. See the constructor for why this is safe.
    async runDecaySweep() {
        if (!this.ratingService) {
            return;
        }

        try {
            const decay = this.ratingService.getConfig().decay || {};
            const hours = decay.enabled ? decay.autoApplyHours || 0 : 0;

            if (hours <= 0) {
                return;
            }

            const now = Date.now();
            if (now - this.lastDecayRunMs < hours * 60 * 60 * 1000) {
                return;
            }

            this.lastDecayRunMs = now;
            const result = await this.ratingService.applyDecay(now);

            if (result && result.decayed > 0) {
                logger.info(`Rating decay auto-applied to ${result.decayed} rating(s)`);
            }
        } catch (err) {
            logger.error('Rating decay sweep failed', err);
        }
    }

    async init() {
        // pre cache card list so the first user to the site doesn't have a slowdown
        await this.cardService.getAllCards();
        this.cardService.subscribeToUpdates(() => {
            logger.info('Card data updated by fetchdata, clearing cache');
            this.cardService.clearCache();
        });
    }

    // External methods
    getStatus() {
        return this.router.getNodeStatus();
    }

    disableNode(nodeName) {
        return this.router.disableNode(nodeName);
    }

    enableNode(nodeName) {
        return this.router.enableNode(nodeName);
    }

    debugDump() {
        let games = Object.values(this.games).map((game) => {
            let players = Object.values(game.players).map((player) => {
                return {
                    name: player.name,
                    left: player.left,
                    disconnected: player.disconnected,
                    id: player.id
                };
            });

            let spectators = Object.values(game.spectators).map((spectator) => {
                return {
                    name: spectator.name,
                    id: spectator.id
                };
            });

            return {
                name: game.name,
                players: players,
                spectators: spectators,
                id: game.id,
                started: game.started,
                node: game.node ? game.node.identity : 'None',
                startedAt: game.createdAt
            };
        });

        let nodes = this.router.getNodeStatus();

        return {
            games: games,
            nodes: nodes,
            socketCount: Object.values(this.sockets).length,
            userCount: Object.values(this.users).length
        };
    }

    // Helpers
    findGameForUser(user) {
        return Object.values(this.games).find((game) => {
            if (game.spectators[user]) {
                return true;
            }

            let player = game.players[user];

            if (!player || player.left) {
                return false;
            }

            return true;
        });
    }

    getUserList() {
        let userList = Object.values(this.users).map((user) => {
            return user.getShortSummary();
        });

        userList = sortBy(userList, (user) => {
            return user.name.toLowerCase();
        });

        return userList;
    }

    handshake(ioSocket, next) {
        const token = ioSocket.handshake.auth?.token || ioSocket.handshake.query?.token;
        if (token && token !== 'undefined') {
            jwt.verify(token, this.configService.getValue('secret'), (err, user) => {
                if (err) {
                    ioSocket.emit('authfailed');
                    return;
                }

                this.userService
                    .getUserById(user.id)
                    .then((dbUser) => {
                        let socket = this.sockets[ioSocket.id];
                        if (!socket) {
                            logger.error(
                                'Tried to authenticate socket for %s but could not find it',
                                dbUser?.username || user?.username || user?.id
                            );
                            return;
                        }

                        if (!dbUser) {
                            logger.error(
                                'Tried to authenticate socket for %s but user lookup returned no result',
                                user?.username || user?.id
                            );
                            ioSocket.emit('authfailed');
                            ioSocket.disconnect();
                            return;
                        }

                        if (dbUser.disabled) {
                            ioSocket.disconnect();
                            return;
                        }

                        ioSocket.request.user = dbUser.getWireSafeDetails();
                        socket.user = dbUser;
                        this.users[dbUser.username] = socket.user;
                        this.socketsByName[dbUser.username] = socket;

                        this.doPostAuth(socket);
                    })
                    .catch((err) => {
                        logger.error(err);
                    });
            });
        }

        const serverVersion = process.env.VERSION;
        const clientVersion = ioSocket.handshake.auth?.version || ioSocket.handshake.query?.version;
        if (serverVersion && clientVersion && serverVersion !== clientVersion) {
            ioSocket.emit(
                'banner',
                'Your client version is out of date, please refresh or clear your cache to get the latest version'
            );
        }

        next();
    }

    // Actions
    mapGamesToGameSummaries(games) {
        return _.chain(games)
            .map((game) => game.getSummary())
            .sortBy('createdAt')
            .sortBy('started')
            .reverse()
            .value();
    }

    broadcastGameMessage(message, games) {
        if (!Array.isArray(games)) {
            games = [games];
        }

        for (let socket of Object.values(this.sockets)) {
            if (!socket) {
                continue;
            }

            let filteredGames = Object.values(games).filter((game) =>
                game.isVisibleFor(socket.user)
            );
            let gameSummaries = filteredGames.map((game) => game.getSummary());

            socket.send(message, gameSummaries);
        }
    }

    broadcastGameList(socket) {
        let sockets = {};

        if (socket) {
            sockets[socket.id] = socket;
        } else {
            sockets = this.sockets;
        }

        for (let socket of Object.values(sockets)) {
            if (!socket) {
                continue;
            }

            let filteredGames = Object.values(this.games).filter((game) =>
                game.isVisibleFor(socket.user)
            );
            let gameSummaries = this.mapGamesToGameSummaries(filteredGames);

            socket.send('games', gameSummaries);
        }
    }

    sendUserListFilteredWithBlockList(socket, userList) {
        let filteredUsers = userList;

        if (socket.user) {
            filteredUsers = userList.filter((user) => {
                return !socket.user.hasUserBlocked(user);
            });
        }

        socket.send('users', filteredUsers);
    }

    broadcastUserMessage(user, message) {
        for (let socket of Object.values(this.sockets)) {
            if (socket.user === user || (socket.user && socket.user.hasUserBlocked(user))) {
                continue;
            }

            socket.send(message, user.getShortSummary());
        }
    }

    sendGameState(game) {
        if (game.started) {
            return;
        }

        for (let player of Object.values(game.getPlayersAndSpectators())) {
            if (!this.sockets[player.id]) {
                logger.info(`Wanted to send to ${player.id} but have no socket`);
                continue;
            }

            this.sockets[player.id].send('gamestate', game.getSummary(player.name));
        }
    }

    clearGamesForNode(nodeName) {
        for (let game of Object.values(this.games)) {
            if (game.node && game.node.identity === nodeName) {
                delete this.games[game.id];
            }
        }

        this.broadcastGameList();
    }

    async clearStalePendingGames() {
        const timeout = 15 * 60 * 1000;
        let staleGames = Object.values(this.games).filter(
            (game) => !game.started && !game.tournament && Date.now() - game.createdAt > timeout
        );

        for (let game of staleGames) {
            logger.info(`closed pending game ${game.id} due to inactivity`);
            delete this.games[game.id];
        }

        // ARCHON: tournament tables wait much longer for their players,
        // but disappear once their match is decided (TO award, forfeit)
        // or the round has moved on.
        const tournamentGames = Object.values(this.games).filter(
            (game) => !game.started && game.tournament
        );

        for (let game of tournamentGames) {
            const age = Date.now() - game.createdAt;
            let stale = age > 6 * 60 * 60 * 1000;

            if (!stale && age > 60 * 1000) {
                try {
                    stale = !(await this.tournamentService.isMatchOpen(
                        game.tournament.tournamentId,
                        game.tournament.matchId
                    ));
                } catch (err) {
                    logger.error('Failed to check tournament match state', err);
                }
            }

            if (stale) {
                logger.info(`closed tournament pending game ${game.id} (match resolved or stale)`);
                delete this.games[game.id];
                staleGames.push(game);
            }
        }

        if (staleGames.length > 0) {
            this.broadcastGameMessage('removegame', staleGames);
        }
    }

    clearOldRefreshTokens() {
        logger.info('Starting refresh token cleanup...');

        this.userService.cleanupRefreshTokens().then(() => {
            logger.info('Refresh token cleanup completed.');
        });
    }

    sendFilteredMessages(socket) {
        this.messageService
            .getLastMessagesForUser(socket.user)
            .then((messages) => {
                let messagesToSend = this.filterMessages(messages, socket);
                socket.send('lobbymessages', messagesToSend.reverse());
            })
            .catch((err) => {
                logger.error('Unable to send lobby messages', err);
                socket.send('lobbymessages', []);
            });
    }

    filterMessages(messages, socket) {
        if (!socket.user) {
            return messages;
        }

        return messages.filter((message) => {
            return !socket.user.hasUserBlocked(message.user);
        });
    }

    // Events
    onConnection(ioSocket) {
        let socket = new Socket(ioSocket, { configService: this.configService });

        socket.registerEvent('chat', this.onPendingGameChat.bind(this));
        socket.registerEvent('clearsessions', this.onClearSessions.bind(this));
        socket.registerEvent('connectfailed', this.onConnectFailed.bind(this));
        socket.registerEvent('getnodestatus', this.onGetNodeStatus.bind(this));
        socket.registerEvent('getsealeddeck', this.onGetSealedDeck.bind(this));
        socket.registerEvent('joingame', this.onJoinGame.bind(this));
        socket.registerEvent('joinqueue', this.onJoinQueue.bind(this));
        socket.registerEvent('leavegame', this.onLeaveGame.bind(this));
        socket.registerEvent('leavequeue', this.onLeaveQueue.bind(this));
        socket.registerEvent('lobbychat', this.onLobbyChat.bind(this));
        socket.registerEvent('motd', this.onMotdChange.bind(this));
        socket.registerEvent('newgame', this.onNewGame.bind(this));
        socket.registerEvent('removegame', this.onRemoveGame.bind(this));
        socket.registerEvent('restartnode', this.onRestartNode.bind(this));
        socket.registerEvent('selectdeck', this.onSelectDeck.bind(this));
        socket.registerEvent('startgame', this.onStartGame.bind(this));
        socket.registerEvent('togglenode', this.onToggleNode.bind(this));
        socket.registerEvent('watchgame', this.onWatchGame.bind(this));

        socket.on('authenticate', this.onAuthenticated.bind(this));
        socket.on('disconnect', this.onSocketDisconnected.bind(this));

        this.sockets[ioSocket.id] = socket;

        if (socket.user) {
            this.users[socket.user.username] = socket.user;
            this.socketsByName[socket.user.username] = socket;

            this.broadcastUserMessage(socket.user, 'newuser');
        }

        this.sendUserListFilteredWithBlockList(socket, this.getUserList());
        this.sendFilteredMessages(socket);
        this.broadcastGameList(socket);

        this.messageService
            .getMotdMessage()
            .then((message) => {
                if (message) {
                    socket.send('motd', message);
                }
            })
            .catch((err) => {
                logger.error(err);
            });

        if (!socket.user) {
            return;
        }

        let game = this.findGameForUser(socket.user.username);
        if (game && game.started) {
            this.sendHandoff(socket, game.node, game.id);
        }
    }

    doPostAuth(socket) {
        let user = socket.user;

        if (!user) {
            return;
        }

        this.broadcastUserMessage(user, 'newuser');
        this.sendFilteredMessages(socket);
        this.sendUserListFilteredWithBlockList(socket, this.getUserList());

        this.broadcastGameList(socket);

        let game = this.findGameForUser(user.username);
        if (game && game.started) {
            this.sendHandoff(socket, game.node, game.id);
        }
    }

    onAuthenticated(socket, user) {
        if (socket.user) {
            return;
        }

        this.userService
            .getUserById(user.id)
            .then((dbUser) => {
                if (!dbUser) {
                    logger.error(
                        'Tried to authenticate socket for %s but user lookup returned no result',
                        user?.username || user?.id
                    );
                    socket.send('authfailed');
                    socket.disconnect();
                    return;
                }

                this.users[dbUser.username] = dbUser;
                this.socketsByName[dbUser.username] = socket;

                socket.user = dbUser;

                this.doPostAuth(socket);
            })
            .catch((err) => {
                logger.error(err);
            });
    }

    onSocketDisconnected(socket, reason) {
        if (!socket) {
            return;
        }

        delete this.sockets[socket.id];

        if (!socket.user) {
            return;
        }

        this.matchmaking?.dequeue(socket.user.username);

        this.broadcastUserMessage(socket.user, 'userleft');

        delete this.users[socket.user.username];
        delete this.socketsByName[socket.user.username];

        logger.info(`user '${socket.user.username}' disconnected from the lobby: ${reason}`);

        let game = this.findGameForUser(socket.user.username);
        if (!game) {
            return;
        }

        game.disconnect(socket.user.username);

        if (game.isEmpty() && !game.tournament) {
            this.broadcastGameMessage('removegame', game);
            delete this.games[game.id];
        } else {
            this.broadcastGameMessage('updategame', game);
            this.sendGameState(game);
        }
    }

    // ARCHON: Quick Match - enter the matchmaking queue for a format. We look
    // up the player's Amber for that format's pool so pairing favours opponents
    // of a similar rating, then try to pair immediately.
    async onJoinQueue(socket, details) {
        if (!socket.user) {
            return;
        }

        const username = socket.user.username;

        if (this.findGameForUser(username)) {
            socket.send('matchmaking', {
                status: 'error',
                message: 'Leave your current game before finding a match'
            });

            return;
        }

        const format =
            details && MATCHMAKING_FORMATS.includes(details.gameFormat)
                ? details.gameFormat
                : 'normal';
        const amber = await this.getMatchmakingAmber(username, format);

        this.matchmaking.enqueue({ username, format, amber, joinedAt: Date.now() });
        socket.send('matchmaking', {
            status: 'searching',
            format,
            queued: this.matchmaking.size(format)
        });

        this.runMatchmaking();
    }

    // Tell everyone still waiting how many players are in their format's queue,
    // so the "searching…" UI can show a live count. Runs after each sweep.
    broadcastQueueSizes() {
        if (!this.matchmaking) {
            return;
        }

        for (const entry of this.matchmaking.list()) {
            const socket = this.socketsByName[entry.username];
            if (socket) {
                socket.send('matchmaking', {
                    status: 'searching',
                    format: entry.format,
                    queued: this.matchmaking.size(entry.format)
                });
            }
        }
    }

    onLeaveQueue(socket) {
        if (!socket.user) {
            return;
        }

        this.matchmaking.dequeue(socket.user.username);
        socket.send('matchmaking', { status: 'idle' });
    }

    async getMatchmakingAmber(username, format) {
        try {
            const pool = this.ratingService.normalizePool(format);
            const ratings = await this.ratingService.getRatingsForUsername(username);
            const entry = (ratings || []).find((rating) => rating.pool === pool);

            return entry ? entry.rating : MatchmakingService.DEFAULT_AMBER;
        } catch (err) {
            logger.error('Failed to look up matchmaking Amber', err);

            return MatchmakingService.DEFAULT_AMBER;
        }
    }

    runMatchmaking() {
        if (!this.matchmaking) {
            return;
        }

        const canPair = (a, b) => {
            const socketA = this.socketsByName[a.username];
            const socketB = this.socketsByName[b.username];

            if (!socketA || !socketB) {
                return false;
            }

            if (this.findGameForUser(a.username) || this.findGameForUser(b.username)) {
                return false;
            }

            // Respect block-lists in both directions.
            return (
                !socketA.user.hasUserBlocked(socketB.user) &&
                !socketB.user.hasUserBlocked(socketA.user)
            );
        };

        for (const [a, b] of this.matchmaking.collectMatches(Date.now(), canPair)) {
            this.createMatchedGame(a, b);
        }

        this.broadcastQueueSizes();
    }

    createMatchedGame(a, b) {
        const socketA = this.socketsByName[a.username];
        const socketB = this.socketsByName[b.username];

        const requeue = (entry, socket) => {
            if (socket) {
                this.matchmaking.enqueue({
                    username: entry.username,
                    format: entry.format,
                    amber: entry.amber,
                    joinedAt: Date.now()
                });
            }
        };

        // A player may have disconnected or entered another game between
        // pairing and creation; requeue whoever is still available.
        if (!socketA || !socketB) {
            requeue(a, socketA);
            requeue(b, socketB);

            return;
        }

        const game = new PendingGame(socketA.user, {
            allowSpectators: true,
            gameFormat: a.format,
            name: `Quick Match: ${a.username} vs ${b.username}`,
            quickMatch: true
        });

        game.newGame(socketA.id, socketA.user, null, true);
        const joinError = game.join(socketB.id, socketB.user);

        if (joinError) {
            logger.info(`Quick Match join failed (${a.username} vs ${b.username}): ${joinError}`);
            requeue(a, socketA);
            requeue(b, socketB);

            return;
        }

        socketA.joinChannel(game.id);
        socketB.joinChannel(game.id);
        this.games[game.id] = game;

        this.sendGameState(game);
        this.broadcastGameMessage('newgame', game);

        socketA.send('matchmaking', { status: 'matched', gameId: game.id });
        socketB.send('matchmaking', { status: 'matched', gameId: game.id });

        logger.info(
            `Quick Match created ${game.id}: ${a.username} (${a.amber}) vs ${b.username} (${b.amber})`
        );
    }

    onNewGame(socket, gameDetails) {
        // Creating a game means leaving any matchmaking queue.
        this.matchmaking?.dequeue(socket.user.username);

        if (!socket.user.permissions.canManageTournaments || !gameDetails.tournament) {
            let existingGame = this.findGameForUser(socket.user.username);
            if (existingGame) {
                return;
            }
        }

        if (gameDetails.quickJoin) {
            let sortedGames = sortBy(Object.values(this.games), (game) => game.createdAt);
            let gameToJoin = sortedGames.find(
                (game) =>
                    !game.started &&
                    !game.tournament &&
                    game.gameFormat === gameDetails.gameFormat &&
                    Object.values(game.players).length < 2 &&
                    !game.password &&
                    !game.gamePrivate &&
                    game.isVisibleFor(socket.user)
            );

            if (gameToJoin) {
                let message = gameToJoin.join(socket.id, socket.user);
                if (message) {
                    socket.send('passworderror', message);

                    return;
                }

                socket.joinChannel(gameToJoin.id);

                this.sendGameState(gameToJoin);
                this.broadcastGameMessage('updategame', gameToJoin);

                return;
            }
        }

        let game = new PendingGame(socket.user, gameDetails);
        game.newGame(socket.id, socket.user, gameDetails.password, true);
        socket.joinChannel(game.id);

        this.sendGameState(game);

        this.games[game.id] = game;
        this.broadcastGameMessage('newgame', game);
    }

    onJoinGame(socket, gameId, password) {
        // Joining a game means leaving any matchmaking queue.
        this.matchmaking?.dequeue(socket.user.username);

        let existingGame = this.findGameForUser(socket.user.username);
        if (existingGame) {
            return;
        }

        let game = this.games[gameId];
        if (!game) {
            return;
        }

        let message = game.join(socket.id, socket.user, password);
        if (message) {
            socket.send('passworderror', message);

            return;
        }

        socket.joinChannel(game.id);

        this.sendGameState(game);
        this.broadcastGameMessage('updategame', game);

        // ARCHON: joining your tournament table auto-selects your
        // registered deck and starts the game once both players are in.
        if (game.tournament) {
            const deckId = game.tournament.decks?.[socket.user.username];
            const selection = deckId
                ? this.applyDeckSelection(game, socket.user.username, deckId, false)
                : Promise.resolve();

            selection
                .catch((err) => logger.error('Failed to auto-select tournament deck', err))
                .then(() => this.startTournamentGameIfReady(game));
        }
    }

    onStartGame(socket, gameId) {
        let game = this.games[gameId];

        if (!game || game.started) {
            return;
        }

        // ARCHON: KeyForge is a two-player game - starting solo used to be
        // allowed and stranded the owner in a board with no opponent.
        if (Object.values(game.getPlayers()).length < 2) {
            socket.send('gameerror', 'You need an opponent before the game can start');
            return;
        }

        if (
            Object.values(game.getPlayers()).some((player) => {
                return !player.deck;
            })
        ) {
            return;
        }

        if (!game.isOwner(socket.user.username)) {
            return;
        }

        let gameNode = this.router.startGame(game);
        if (!gameNode) {
            socket.send('gameerror', 'No game nodes available. Try again later.');
            return;
        }

        game.node = gameNode;
        game.started = true;

        this.broadcastGameMessage('updategame', game);

        for (let player of Object.values(game.getPlayersAndSpectators())) {
            let socket = this.sockets[player.id];

            if (!socket || !socket.user) {
                logger.error(`Wanted to handoff to ${player.name}, but couldn't find a socket`);
                continue;
            }

            this.sendHandoff(socket, gameNode, game.id);
        }
    }

    sendHandoff(socket, gameNode, gameId) {
        let user = socket.user.getWireSafeDetails();
        let authToken = jwt.sign(user, this.configService.getValue('secret'), { expiresIn: '5m' });

        const handoffData = {
            authToken: authToken,
            gameId: gameId,
            name: gameNode.identity,
            port: gameNode.port,
            protocol: gameNode.protocol,
            user: user
        };

        if (gameNode.address) {
            handoffData.address = gameNode.address;
        }

        socket.send('handoff', handoffData);
    }

    onWatchGame(socket, gameId, password) {
        let existingGame = this.findGameForUser(socket.user.username);
        if (existingGame) {
            return;
        }

        let game = this.games[gameId];
        if (!game) {
            return;
        }

        let message = game.watch(socket.id, socket.user, password);
        if (message) {
            socket.send('passworderror', message);

            return;
        }

        socket.joinChannel(game.id);

        if (game.started) {
            this.router.addSpectator(game, socket.user.getDetails());
            this.sendHandoff(socket, game.node, game.id);
        } else {
            this.sendGameState(game);
        }
    }

    onLeaveGame(socket) {
        let game = this.findGameForUser(socket.user.username);
        if (!game) {
            return;
        }

        game.leave(socket.user.username);
        socket.send('cleargamestate');
        socket.leaveChannel(game.id);

        // ARCHON: leaving a *started* game over the lobby socket is the fallback
        // escape hatch when a player's game-node socket is dead (they were
        // stranded at a rendered-but-unresponsive board). The node still
        // believes the player is present, so once every player has left from the
        // lobby's authoritative view, force the node to tear the game down —
        // otherwise the finished game lingers as a ghost in the lobby list until
        // the node's stale-game sweep, or forever if the dead socket never
        // times out. When the opponent is still playing we only broadcast the
        // update and let the node keep running the live game.
        if (game.started && !game.tournament) {
            if (game.isEmpty()) {
                if (game.node && game.node.identity) {
                    this.router.closeGame(game);
                }
                delete this.games[game.id];
                this.broadcastGameMessage('removegame', game);
            } else {
                this.broadcastGameMessage('updategame', game);
            }
            return;
        }

        if (game.isEmpty() && !game.tournament) {
            delete this.games[game.id];
            this.broadcastGameMessage('removegame', game);
        } else {
            this.sendGameState(game);
            this.broadcastGameMessage('updategame', game);
        }
    }

    onPendingGameChat(socket, message) {
        let game = this.findGameForUser(socket.user.username);
        if (!game) {
            return;
        }

        game.chat(socket.user.username, message);
        this.sendGameState(game);
    }

    async onLobbyChat(socket, message) {
        if (
            Date.now() - socket.user.registered <
            this.configService.getValue('minLobbyChatTime') * 1000
        ) {
            socket.send('nochat');
            return;
        }

        let chatMessage = {
            message: message.substring(0, Math.min(512, message.length)),
            time: new Date()
        };
        let newMessage = await this.messageService.addMessage(chatMessage, socket.user);
        newMessage.user = socket.user.getShortSummary();

        for (let s of Object.values(this.sockets)) {
            if (s.user && s.user.hasUserBlocked(socket.user)) {
                continue;
            }

            s.send('lobbychat', newMessage);
        }
    }

    onGetSealedDeck(socket, gameId) {
        let game = this.games[gameId];
        if (!game) {
            return;
        }

        Promise.all([
            this.cardService.getAllCards(),
            this.deckService.getSealedDeck(game.expansions)
        ])
            .then((results) => {
                let [cards, deck] = results;

                for (let card of deck.cards) {
                    card.card = cards[card.id];
                }

                deck.status = {
                    basicRules: true,
                    extendedStatus: [],
                    flagged: false,
                    noUnreleasedCards: true,
                    officialRole: true,
                    usageLevel: 0,
                    verified: true
                };

                game.selectDeck(socket.user.username, deck);

                this.sendGameState(game);
            })
            .catch((err) => {
                logger.info(err);

                return;
            });
    }

    onSelectDeck(socket, gameId, deckId, isStandalone) {
        let game = this.games[gameId];
        if (!game) {
            return;
        }

        return this.applyDeckSelection(game, socket.user.username, deckId, isStandalone)
            .then(() => {
                // ARCHON: tournament tables launch as soon as both
                // players are seated with decks.
                if (game.tournament) {
                    this.startTournamentGameIfReady(game);
                }
            })
            .catch((err) => {
                logger.info(err);

                return;
            });
    }

    /**
     * ARCHON: deck loading/status logic shared by manual selection and
     * tournament auto-selection (which has a username but no socket).
     */
    applyDeckSelection(game, username, deckId, isStandalone) {
        return Promise.all([
            this.cardService.getAllCards(),
            isStandalone
                ? this.deckService.getStandaloneDeckById(deckId)
                : this.deckService.getById(deckId)
        ]).then((results) => {
            let [cards, deck] = results;

            for (let card of deck.cards) {
                let house = card.house;

                card.card = cards[card.id];
                if (house) {
                    card.house = house;
                }
            }

            let deckUsageLevel = 0;
            if (
                deck.usageCount >
                this.configService.getValueForSection('lobby', 'lowerDeckThreshold')
            ) {
                deckUsageLevel = 1;
            }

            if (
                deck.usageCount >
                this.configService.getValueForSection('lobby', 'middleDeckThreshold')
            ) {
                deckUsageLevel = 2;
            }

            if (
                deck.usageCount >
                this.configService.getValueForSection('lobby', 'upperDeckThreshold')
            ) {
                deckUsageLevel = 3;
            }

            let hasEnhancementsSet = true;
            if (deck.cards.some((c) => c.enhancements && c.enhancements[0] === '')) {
                hasEnhancementsSet = false;
            }

            if (isStandalone) {
                deck.verified = true;
            }

            deck.status = {
                basicRules: hasEnhancementsSet,
                extendedStatus: [],
                noUnreleasedCards: true,
                officialRole: true,
                usageLevel: deckUsageLevel,
                verified: !!deck.verified,
                impossible: isStandalone && deck.id >= 5
            };

            deck.usageCount = 0;

            if (game.gameFormat === 'alliance') {
                deck.name = 'Alliance Deck';
            }

            game.selectDeck(username, deck);

            this.sendGameState(game);
        });
    }

    onConnectFailed(socket) {
        let game = this.findGameForUser(socket.user.username);
        if (!game) {
            return;
        }

        logger.info("user '%s' failed to handoff to game server", socket.user.username);
        this.router.notifyFailedConnect(game, socket.user.username);
    }

    onRemoveGame(socket, gameId) {
        if (!socket.user.permissions.canManageGames) {
            return;
        }

        let game = this.games[gameId];
        if (!game) {
            return;
        }

        logger.info(`${socket.user.username} closed game ${game.id} (${game.name}) forcefully`);

        if (!game.started) {
            delete this.games[game.id];
        } else {
            this.router.closeGame(game);
        }

        this.broadcastGameMessage('removegame', game);
    }

    onGetNodeStatus(socket) {
        if (!socket.user.permissions.canManageNodes) {
            return;
        }

        socket.send('nodestatus', this.router.getNodeStatus());
    }

    onToggleNode(socket, node) {
        if (!socket.user.permissions.canManageNodes) {
            return;
        }

        this.router.toggleNode(node);

        socket.send('nodestatus', this.router.getNodeStatus());
    }

    onRestartNode(socket, node) {
        if (!socket.user.permissions.canManageNodes) {
            return;
        }

        this.router.restartNode(node);

        socket.send('nodestatus', this.router.getNodeStatus());
    }

    onMotdChange(socket, motd) {
        if (!socket.user.permissions.canManageMotd) {
            return;
        }

        let newMotd =
            motd && motd.message
                ? {
                      message: motd.message,
                      motdType: motd.motdType,
                      type: 'motd',
                      time: new Date()
                  }
                : {};

        this.messageService
            .setMotdMessage(newMotd, socket.user)
            .then(() => {
                this.io.emit('motd', { message: newMotd.message, motdType: newMotd.motdType });
            })
            .catch((err) => {
                logger.error(err);
            });
    }

    // router Events
    onGameClosed(gameId) {
        let game = this.games[gameId];

        if (!game) {
            return;
        }

        this.broadcastGameMessage('removegame', game);
        delete this.games[gameId];
    }

    // ARCHON: tournament engine integration ---------------------------------
    // Online events get their table games created automatically per
    // pairing; GAMEWIN results flow back into the tournament service;
    // best-of series spin up their next game.

    findTournamentGame(matchId) {
        return Object.values(this.games).find(
            (game) => game.tournament && game.tournament.matchId === matchId
        );
    }

    async onTournamentRoundPaired({ tournamentId }) {
        try {
            const matches = await this.tournamentService.getMatchesNeedingGames(tournamentId);

            for (const matchInfo of matches) {
                await this.ensureTournamentGame(matchInfo);
            }
        } catch (err) {
            logger.error(`Failed to create games for tournament ${tournamentId}`, err);
        }
    }

    async onTournamentEnsureMatchGame({ tournamentId, matchId }) {
        try {
            const matches = await this.tournamentService.getMatchesNeedingGames(tournamentId);
            const matchInfo = matches.find((entry) => entry.matchId === matchId);

            if (matchInfo) {
                await this.ensureTournamentGame(matchInfo);
            }
        } catch (err) {
            logger.error(`Failed to open game for tournament match ${matchId}`, err);
        }
    }

    async onTournamentGameWin(gameSave) {
        if (!gameSave || !gameSave.tournament) {
            return;
        }

        try {
            const result = await this.tournamentService.recordGameWin(gameSave);

            if (result?.handled && result.matchComplete === false && result.nextGameNumber) {
                // Series continues: put the next game up right away so
                // the players find their table when they leave this one.
                const matches = await this.tournamentService.getMatchesNeedingGames(
                    gameSave.tournament.tournamentId
                );
                const matchInfo = matches.find(
                    (entry) => entry.matchId === gameSave.tournament.matchId
                );

                if (matchInfo) {
                    await this.ensureTournamentGame(matchInfo);
                }
            }
        } catch (err) {
            logger.error('Failed to process tournament game result', err);
        }
    }

    /**
     * Create the lobby game for a tournament pairing unless one is
     * already up. Players who are online and idle are seated
     * immediately with their registered decks; everyone else joins
     * from the lobby or the event page. The game starts itself once
     * both players are seated with decks.
     */
    async ensureTournamentGame(matchInfo) {
        const existing = this.findTournamentGame(matchInfo.matchId);

        if (
            existing &&
            (!existing.started || existing.tournament.gameNumber === matchInfo.gameNumber)
        ) {
            return;
        }

        const users = await Promise.all(
            matchInfo.players.map((player) => this.userService.getUserByUsername(player.username))
        );

        if (users.some((user) => !user)) {
            logger.error(
                `Tournament match ${matchInfo.matchId}: could not load players ${matchInfo.players
                    .map((player) => player.username)
                    .join(', ')}`
            );

            return;
        }

        const tableLabel = matchInfo.table ? ` T${matchInfo.table}` : '';
        const seriesLabel = matchInfo.bestOf > 1 ? ` (game ${matchInfo.gameNumber})` : '';
        const name =
            `${matchInfo.tournamentName} R${matchInfo.round}${tableLabel}: ${matchInfo.players[0].username} vs ${matchInfo.players[1].username}${seriesLabel}`.slice(
                0,
                255
            );

        const game = new PendingGame(users[0], {
            allowSpectators: true,
            gameFormat: matchInfo.gameFormat,
            gameTimeLimit: matchInfo.gameTimeLimit || undefined,
            useGameTimeLimit: !!matchInfo.gameTimeLimit,
            hideDeckLists: matchInfo.hideDecklists,
            muteSpectators: true,
            name: name,
            showHand: false,
            previousWinner: matchInfo.previousWinner || undefined,
            tournament: {
                tournamentId: matchInfo.tournamentId,
                matchId: matchInfo.matchId,
                gameNumber: matchInfo.gameNumber,
                bestOf: matchInfo.bestOf,
                round: matchInfo.round,
                table: matchInfo.table,
                players: matchInfo.players.map((player) => player.username),
                decks: Object.fromEntries(
                    matchInfo.players.map((player) => [player.username, player.deckId])
                )
            }
        });

        // ARCHON: pre-assigned chains (SAS handicap / Chainbound accrual)
        // ride the pending game into the engine's setup phase.
        if (matchInfo.startingChains) {
            game.startingChains = matchInfo.startingChains;
        }

        this.games[game.id] = game;

        await this.tournamentService.attachGame(
            matchInfo.tournamentId,
            matchInfo.matchId,
            matchInfo.gameNumber,
            game.id
        );

        // Seat everyone who is online and not busy in another game.
        for (const player of matchInfo.players) {
            const socket = this.socketsByName[player.username];

            if (!socket || this.findGameForUser(player.username)) {
                continue;
            }

            const joinError = game.join(socket.id, socket.user);

            if (joinError) {
                continue;
            }

            socket.joinChannel(game.id);

            if (player.deckId) {
                try {
                    await this.applyDeckSelection(game, player.username, player.deckId, false);
                } catch (err) {
                    logger.error(
                        `Failed to auto-select deck ${player.deckId} for ${player.username}`,
                        err
                    );
                }
            }
        }

        this.broadcastGameMessage('newgame', game);
        this.sendGameState(game);

        logger.info(`Created tournament game ${game.id} for match ${matchInfo.matchId} (${name})`);

        this.startTournamentGameIfReady(game);
    }

    /**
     * Tournament games skip the owner-driven start: as soon as both
     * paired players are seated with decks, the game launches and both
     * players are handed off to the game node.
     */
    startTournamentGameIfReady(game) {
        if (!game || game.started || !game.tournament) {
            return;
        }

        const players = Object.values(game.getPlayers());

        if (players.length < 2 || players.some((player) => !player.deck)) {
            return;
        }

        const gameNode = this.router.startGame(game);

        if (!gameNode) {
            logger.error(`No game nodes available for tournament game ${game.id}`);

            return;
        }

        game.node = gameNode;
        game.started = true;

        this.broadcastGameMessage('updategame', game);

        for (const player of Object.values(game.getPlayersAndSpectators())) {
            const socket = this.sockets[player.id];

            if (!socket || !socket.user) {
                logger.error(`Wanted to handoff to ${player.name}, but couldn't find a socket`);
                continue;
            }

            this.sendHandoff(socket, gameNode, game.id);
        }
    }

    onGameRematch(oldGame) {
        let gameId = oldGame.gameId;
        let game = this.games[gameId];

        if (!game) {
            return;
        }

        this.broadcastGameMessage('removegame', game);
        delete this.games[gameId];

        let newGame = new PendingGame(game.owner, {
            adaptive: game.adaptive,
            gameFormat: game.gameFormat,
            gameTimeLimit: game.gameTimeLimit,
            hideDeckLists: game.hideDeckLists,
            showHand: game.showHand,
            allowSpectators: game.allowSpectators,
            spectators: game.spectators,
            swap: oldGame.swap,
            useGameTimeLimit: game.useGameTimeLimit
        });
        newGame.rematch = true;
        newGame.previousWinner = oldGame.winner;

        let owner = game.getPlayerOrSpectator(game.owner.username);
        if (!owner) {
            logger.error("Tried to rematch but the owner wasn't in the game");
            return;
        }

        let socket = this.socketsByName[owner.name];
        if (!socket) {
            logger.error("Tried to rematch but the owner's socket has gone away");
            return;
        }

        this.games[newGame.id] = newGame;
        newGame.newGame(socket.id, socket.user);

        socket.joinChannel(newGame.id);
        this.sendGameState(newGame);
        this.broadcastGameMessage('newgame', newGame);

        const ownerDeck =
            owner.deck || (oldGame.players || []).find((x) => x.name === owner.name)?.deck;

        if (!ownerDeck || !ownerDeck.id) {
            logger.error(`Tried to rematch but ${owner.name} has no deck selected`);
            return;
        }

        let promises = [
            this.onSelectDeck(
                socket,
                newGame.id,
                ownerDeck.id,
                ownerDeck.isStandalone || ownerDeck.is_standalone
            )
        ];

        for (let player of Object.values(game.getPlayers()).filter(
            (player) => player.name !== owner.username && !player.left
        )) {
            let socket = this.socketsByName[player.name];

            if (!socket) {
                logger.warn(
                    `Tried to add ${player.name} to a rematch but couldn't find their socket`
                );
                continue;
            }

            const playerDeck =
                player.deck || (oldGame.players || []).find((x) => x.name === player.name)?.deck;

            if (!playerDeck || !playerDeck.id) {
                logger.warn(`Tried to rematch but ${player.name} has no deck selected`);
                continue;
            }

            newGame.join(socket.id, player.user);
            promises.push(
                this.onSelectDeck(
                    socket,
                    newGame.id,
                    playerDeck.id,
                    playerDeck.isStandalone || playerDeck.is_standalone
                )
            );
        }

        for (let player of Object.values(game.getPlayers())) {
            let oldPlayer = oldGame.players.find((x) => x.name === player.name);

            if (oldPlayer && oldPlayer.wins) {
                if (!newGame.players[player.name]) {
                    logger.warn(
                        `Tried to set ${player.name} wins but couldn't find them in the game`
                    );
                    continue;
                }

                newGame.players[player.name].wins = oldPlayer.wins;
            }
        }

        for (let spectator of game.getSpectators()) {
            let socket = this.socketsByName[spectator.name];

            if (!socket) {
                logger.warn(
                    `Tried to add ${spectator.name} to spectate a rematch but couldn't find their socket`
                );
                continue;
            }

            newGame.watch(socket.id, spectator.user);
        }

        // Set the password after everyone has joined, so we don't need to worry about overriding the password, or storing it unencrypted/hashed
        newGame.password = game.password;

        Promise.all(promises).then(() => {
            this.onStartGame(socket, newGame.id);
        });
    }

    onGameRematchWithNewDecks(oldGame) {
        let gameId = oldGame.gameId;
        let game = this.games[gameId];

        if (!game) {
            return;
        }

        this.broadcastGameMessage('removegame', game);
        delete this.games[gameId];

        let newGame = new PendingGame(game.owner, {
            adaptive: game.adaptive,
            gameFormat: game.gameFormat,
            gameTimeLimit: game.gameTimeLimit,
            hideDeckLists: game.hideDeckLists,
            showHand: game.showHand,
            allowSpectators: game.allowSpectators,
            spectators: game.spectators,
            swap: false,
            useGameTimeLimit: game.useGameTimeLimit
        });
        newGame.rematch = true;
        newGame.previousWinner = oldGame.winner;

        let owner = game.getPlayerOrSpectator(game.owner.username);
        if (!owner) {
            logger.error("Tried to rematch but the owner wasn't in the game");
            return;
        }

        let socket = this.socketsByName[owner.name];
        if (!socket) {
            logger.error("Tried to rematch but the owner's socket has gone away");
            return;
        }

        this.games[newGame.id] = newGame;
        newGame.newGame(socket.id, socket.user);

        socket.joinChannel(newGame.id);
        this.sendGameState(newGame);
        this.broadcastGameMessage('newgame', newGame);

        const ownerDeck =
            owner.deck || (oldGame.players || []).find((x) => x.name === owner.name)?.deck;

        if (!ownerDeck || !ownerDeck.id) {
            logger.error(`Tried to rematch with new decks but ${owner.name} has no deck selected`);
            return;
        }

        this.onSelectDeck(
            socket,
            newGame.id,
            ownerDeck.id,
            ownerDeck.isStandalone || ownerDeck.is_standalone
        );

        for (let player of Object.values(game.getPlayers()).filter(
            (player) => player.name !== owner.username && !player.left
        )) {
            let socket = this.socketsByName[player.name];

            if (!socket) {
                logger.warn(
                    `Tried to add ${player.name} to a rematch but couldn't find their socket`
                );
                continue;
            }
            player.deck = [];

            newGame.join(socket.id, player.user);
            socket.joinChannel(newGame.id);
        }

        for (let player of Object.values(game.getPlayers())) {
            let oldPlayer = oldGame.players.find((x) => x.name === player.name);

            if (oldPlayer && oldPlayer.wins) {
                if (!newGame.players[player.name]) {
                    logger.warn(
                        `Tried to set ${player.name} wins but couldn't find them in the game`
                    );
                    continue;
                }

                newGame.players[player.name].wins = oldPlayer.wins;
            }
        }

        for (let spectator of game.getSpectators()) {
            let socket = this.socketsByName[spectator.name];

            if (!socket) {
                logger.warn(
                    `Tried to add ${spectator.name} to spectate a rematch but couldn't find their socket`
                );
                continue;
            }

            newGame.watch(socket.id, spectator.user);
        }

        // Set the password after everyone has joined, so we don't need to worry about overriding the password, or storing it unencrypted/hashed
        newGame.password = game.password;

        this.sendGameState(newGame);
        this.broadcastGameMessage('updategame', newGame);
    }

    onPlayerLeft(gameId, player) {
        let game = this.games[gameId];

        if (!game) {
            return;
        }

        game.leave(player);

        if (game.isEmpty()) {
            this.broadcastGameMessage('removegame', game);
            delete this.games[gameId];
        } else {
            this.broadcastGameMessage('updategame', game);
        }
    }

    onBlocklistChanged(user) {
        const updatedUser = this.users[user.username];

        if (!updatedUser) {
            return;
        }

        const socket = this.socketsByName[user.username];
        if (!socket) {
            updatedUser.blockList = user.blockList;
            return;
        }

        const oldBlockList = updatedUser.blockList || [];
        const newBlockList = user.blockList || [];

        const added = newBlockList.filter((entry) => !oldBlockList.includes(entry));
        const removed = oldBlockList.filter((entry) => !newBlockList.includes(entry));

        // Snapshot game visibility before the update
        let gameVisibilityBefore = {};
        for (let game of Object.values(this.games)) {
            gameVisibilityBefore[game.id] = game.isVisibleFor(updatedUser);
        }

        updatedUser.blockList = user.blockList;

        // Send targeted removals for newly blocked users
        for (let blockedName of added) {
            let blockedUser = Object.values(this.users).find(
                (u) => u.username.toLowerCase() === blockedName
            );
            if (blockedUser) {
                socket.send('userleft', blockedUser.getShortSummary());
            }
        }

        // Send targeted additions for newly unblocked users
        for (let unblockedName of removed) {
            let unblockedUser = Object.values(this.users).find(
                (u) => u.username.toLowerCase() === unblockedName
            );
            if (unblockedUser) {
                socket.send('newuser', unblockedUser.getShortSummary());
            }
        }

        // Send targeted game removals/additions based on visibility changes
        let gamesToRemove = [];
        let gamesToAdd = [];
        for (let game of Object.values(this.games)) {
            let wasVisible = gameVisibilityBefore[game.id];
            let isVisible = game.isVisibleFor(updatedUser);

            if (wasVisible && !isVisible) {
                gamesToRemove.push(game);
            } else if (!wasVisible && isVisible) {
                gamesToAdd.push(game);
            }
        }

        if (gamesToRemove.length > 0) {
            socket.send(
                'removegame',
                gamesToRemove.map((game) => game.getSummary())
            );
        }

        if (gamesToAdd.length > 0) {
            socket.send(
                'newgame',
                gamesToAdd.map((game) => game.getSummary())
            );
        }
    }

    onWorkerTimedOut(nodeName) {
        this.clearGamesForNode(nodeName);
    }

    onWorkerStarted() {}

    onClearSessions(socket, username) {
        this.userService.clearUserSessions(username).then((success) => {
            if (!success) {
                logger.error(`Failed to clear sessions for user ${username}`);
                return;
            }

            let game = this.findGameForUser(username);

            if (game) {
                logger.info(
                    `closed game ${game.id} (${game.name}) forcefully due to clear session on ${username}`
                );

                if (!game.started) {
                    delete this.games[game.id];
                } else {
                    this.router.closeGame(game);
                }
            }

            let socket = Object.values(this.sockets).find((socket) => {
                return socket.user && socket.user.username === username;
            });

            if (socket) {
                socket.disconnect();
            }
        });
    }

    onNodeReconnected(nodeName, games) {
        for (let game of Object.values(games)) {
            let owner = game.players[game.owner];

            if (!owner) {
                logger.error("Got a game where the owner %s wasn't a player", game.owner);
                continue;
            }

            let syncGame = new PendingGame(new User(owner.user), {
                spectators: game.allowSpectators,
                name: game.name
            });
            syncGame.adaptive = game.adaptive;
            syncGame.createdAt = game.startedAt;
            syncGame.gameFormat = game.gameFormat;
            syncGame.gamePrivate = game.gamePrivate;
            syncGame.id = game.id;
            syncGame.node = this.router.workers[nodeName];
            syncGame.password = game.password;
            syncGame.started = game.started;

            for (let player of Object.values(game.players)) {
                syncGame.players[player.name] = {
                    id: player.id,
                    name: player.name,
                    owner: game.owner === player.name,
                    user: new User(player.user)
                };
            }

            for (let player of Object.values(game.spectators)) {
                syncGame.spectators[player.name] = {
                    id: player.id,
                    name: player.name,
                    user: new User(player.user)
                };
            }

            this.games[syncGame.id] = syncGame;
        }

        for (let game of Object.values(this.games)) {
            if (
                game.node &&
                game.node.identity === nodeName &&
                Object.values(games).find((nodeGame) => {
                    return nodeGame.id === game.id;
                })
            ) {
                this.games[game.id] = game;
            } else if (game.node && game.node.identity === nodeName) {
                delete this.games[game.id];
            }
        }

        this.broadcastGameList();
    }
}

module.exports = Lobby;
