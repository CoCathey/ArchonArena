const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const Sentry = require('@sentry/node');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');
const jsondiffpatch = require('jsondiffpatch').create({
    objectHash: (obj, index) => {
        return obj.uuid || obj.name || obj.id || obj._id || '$$index:' + index;
    }
});

const { detectBinary } = require('../util');
const logger = require('../log');
const GameSocket = require('./gamesocket');
const Game = require('../game/game');
const Socket = require('../socket');
const ConfigService = require('../services/ConfigService');
const HealthServer = require('./healthserver.js');

class GameServer {
    constructor() {
        this.configService = new ConfigService();
        const sentryDsn = this.configService.getValue('sentryDsn');

        if (sentryDsn) {
            Sentry.init({ dsn: sentryDsn, release: process.env.VERSION || 'Local build' });
        }

        this.games = {};
        this.protocol = 'https';

        try {
            var privateKey = fs
                .readFileSync(this.configService.getValueForSection('gameNode', 'keyPath'))
                .toString();
            var certificate = fs
                .readFileSync(this.configService.getValueForSection('gameNode', 'certPath'))
                .toString();
        } catch (e) {
            this.protocol = 'http';
        }

        this.host =
            process.env.HOST ||
            this.configService.getValueForSection('gameNode', 'host') ||
            undefined;

        this.gameSocket = new GameSocket(
            this.configService,
            this.host,
            this.protocol,
            process.env.VERSION || 'Local build'
        );
        this.gameSocket.on('onStartGame', this.onStartGame.bind(this));
        this.gameSocket.on('onSpectator', this.onSpectator.bind(this));
        this.gameSocket.on('onGameSync', this.onGameSync.bind(this));
        this.gameSocket.on('onFailedConnect', this.onFailedConnect.bind(this));
        this.gameSocket.on('onCloseGame', this.onCloseGame.bind(this));
        this.gameSocket.on('onCardData', this.onCardData.bind(this));
        this.gameSocket.on('onRestartRequested', this.onRestartRequested.bind(this));
        this.gameSocket.on('onLobbyReconnected', this.onLobbyReconnected.bind(this));

        var server = undefined;

        if (!privateKey || !certificate) {
            server = http.createServer();
        } else {
            server = https.createServer({ key: privateKey, cert: certificate });
        }

        const socketioPort = this.configService.getValueForSection('gameNode', 'socketioPort');

        server.listen(process.env.PORT || socketioPort, '0.0.0.0');

        let options = {
            perMessageDeflate: false,
            pingTimeout: 15000
        };

        const nodeIdentity =
            process.env.SERVER || this.configService.getValueForSection('gameNode', 'name');
        if (nodeIdentity) {
            options.path = '/' + nodeIdentity + '/socket.io';
        }

        const corsOrigin = this.configService.getValueForSection('gameNode', 'origin');
        if (corsOrigin) {
            options.cors = { origin: corsOrigin, credentials: true };
        } else if (this.configService.getValue('env') !== 'production') {
            // In local/dev environments the lobby and game node commonly run on different ports.
            // Allow localhost/127.0.0.1 origins so Socket.IO polling responses include CORS headers.
            options.cors = {
                origin: (origin, callback) => {
                    if (!origin) {
                        callback(null, true);
                        return;
                    }

                    try {
                        const parsedOrigin = new URL(origin);
                        const host = parsedOrigin.hostname.toLowerCase();
                        const isLocalHost = host === 'localhost' || host === '127.0.0.1';

                        callback(null, isLocalHost);
                    } catch (err) {
                        callback(null, false);
                    }
                },
                credentials: true
            };
        }

        logger.info(
            `Listening on 0.0.0.0:${process.env.PORT || socketioPort}/${
                process.env.SERVER || nodeIdentity
            }/socket.io`
        );

        this.io = new Server(server, options);
        this.io.use(this.handshake.bind(this));

        this.io.on('connection', this.onConnection.bind(this));

        setInterval(() => this.clearStaleAndFinishedGames(), 30 * 1000);

        this.healthServer = new HealthServer(this);
        this.healthServer.start();

        if (process.env.SCENARIO) {
            require('../devtools/scenario/host.js').install(this, process.env.SCENARIO);
        }
    }

    debugDump() {
        const games = Object.values(this.games).map((game) => {
            const players = Object.values(game.playersAndSpectators).map((player) => {
                return {
                    name: player.name,
                    left: player.left,
                    disconnected: !!player.disconnectedAt,
                    id: player.id,
                    spectator: game.isSpectator(player)
                };
            });

            return {
                name: game.name,
                players: players,
                id: game.id,
                started: game.started,
                startedAt: game.startedAt
            };
        });

        return {
            games: games,
            gameCount: Object.values(this.games).length
        };
    }

    /**
     * @param {import("../game/game")} game
     * @param {Error} e
     */
    handleError(game, e) {
        if (game.errorHandling) {
            logger.error('Error during error handling, suppressing to avoid loop:', e);
            return;
        }

        game.errorHandling = true;

        try {
            logger.error(e);

            let debugData = /** @type {Record<string, any>} */ ({});

            try {
                let gameState = game.getState();

                if (e.message.includes('Maximum call stack')) {
                    debugData.badSerializaton = detectBinary(gameState);
                } else {
                    debugData.game = gameState;
                    debugData.game.players = undefined;

                    debugData.messages = game.getPlainTextLog();
                    debugData.game.messages = undefined;

                    for (const player of game.getPlayers()) {
                        debugData[player.name] = player.getState(player);
                    }
                }
            } catch (diagnosticError) {
                logger.error('Failed to collect diagnostic data:', diagnosticError);
            }

            Sentry.withScope((scope) => {
                scope.setExtra('extra', debugData);
                Sentry.captureException(e);
            });

            try {
                if (game) {
                    game.addMessage(
                        'A Server error has occurred processing your game state, apologies.  Your game may now be in an inconsistent state, or you may be able to continue.  The error has been logged.'
                    );
                }
            } catch (messageError) {
                logger.error('Failed to add error message to game:', messageError);
            }
        } finally {
            game.errorHandling = false;
        }
    }

    /**
     * @param {import("../game/game")} game
     */
    closeGame(game) {
        // ARCHON (N1): deliver anything a broadcast delay is still holding
        // before the sockets go, so a delayed spectator sees the end of the
        // game rather than the board freezing a minute short of it.
        this.clearSpectatorDelay(game);

        for (const player of Object.values(game.getPlayersAndSpectators())) {
            if (player.socket) {
                player.socket.tIsClosing = true;
                player.socket.disconnect();
            }
        }

        delete this.games[game.id];
        this.gameSocket.send('GAMECLOSED', { game: game.id });
    }

    clearStaleAndFinishedGames() {
        const timeout = 20 * 60 * 1000;

        const staleGames = Object.values(this.games).filter(
            (game) => game.finishedAt && Date.now() - game.finishedAt > timeout
        );
        for (const game of staleGames) {
            logger.info(`closed finished game ${game.id} due to inactivity`);
            this.closeGame(game);
        }

        const emptyGames = Object.values(this.games).filter((game) => game.isEmpty());
        for (const game of emptyGames) {
            logger.info(`closed empty game ${game.id}`);
            this.closeGame(game);
        }

        // Check for player inactivity in active games. Piggybacks on the
        // existing 30s sweep to set the forcePassAvailable flag.
        for (const game of Object.values(this.games)) {
            if (game.finishedAt) {
                continue;
            }
            if (game.checkInactivity()) {
                this.runAndCatchErrors(game, () => {
                    game.continue();
                    this.sendGameState(game);
                });
            }
        }
    }

    /**
     * @param {import("../game/game")} game
     * @param {{ (): void }} func
     */
    runAndCatchErrors(game, func) {
        try {
            func();
        } catch (e) {
            this.handleError(game, e);

            try {
                this.sendGameState(game);
            } catch (sendError) {
                logger.error('Failed to send game state after error:', sendError);
            }
        }
    }

    /**
     * @param {string} username
     */
    findGameForUser(username) {
        return Object.values(this.games).find((game) => {
            const player = game.playersAndSpectators[username];

            if (!player || player.left) {
                return false;
            }

            return true;
        });
    }

    /**
     * @param {import("../game/game")} game
     */
    sendGameState(game) {
        // ARCHON: record the board for the replay viewer at the same moment the
        // live clients are updated - the one point where the state is known to
        // be settled. The call self-throttles to log advances and is wrapped so
        // a recording failure can never interrupt a live game.
        try {
            game.recordBoardSnapshot();
        } catch {
            // Deliberately swallowed; the recording is best-effort.
        }

        for (const player of Object.values(game.getPlayersAndSpectators())) {
            this.deliverStateTo(game, player);
        }
    }

    /**
     * Deliver one player their current state, honouring the spectator delay.
     *
     * ARCHON (N1): optional broadcast delay. Spectators - and only spectators -
     * can be held back by a configured number of seconds so an event can be
     * streamed without the stream becoming a side channel back to the table.
     * The two players are never delayed.
     */
    deliverStateTo(game, player) {
        if (player.left || player.disconnectedAt || !player.socket) {
            return;
        }

        const state = game.getState(player.name);
        const delayMs = Math.max(0, Number(game.spectatorDelaySeconds) || 0) * 1000;

        if (delayMs > 0 && game.isSpectator(player)) {
            this.queueDelayedState(game, player.name, state, delayMs);

            return;
        }

        this.sendStateTo(game, player, state);
    }

    /**
     * Send one player their state, diffed against what they were last sent.
     *
     * Split out of sendGameState so the delayed path shares it: the diff base
     * (`jsonForUsers`) must only advance when a state is actually delivered,
     * otherwise a delayed spectator would be sent diffs against a position they
     * have not seen yet and their board would desynchronise.
     */
    sendStateTo(game, player, state) {
        // ARCHON: say on the wire whether this is a complete snapshot or a
        // delta. The diff baseline is per player and is reset whenever they
        // connect, reconnect, disconnect or leave, so both go down the same
        // event and the two are not distinguishable by inspection.
        //
        // Clients used to infer it - "I am holding no board, so this must be a
        // full one" - and that inference is wrong precisely when the reset
        // happened on this side of the connection: a second tab or the phone
        // app connecting as the same user resets the baseline for a client that
        // still holds a board. Handing a whole game state to a delta patcher
        // does not fail loudly; jsondiffpatch@0.4 loops forever on the first
        // string it meets, which locks the browser tab outright. See
        // docs/design/game-state-sync.md.
        const full = !game.jsonForUsers[player.name];
        const stateToSend = full
            ? state
            : jsondiffpatch.diff(game.jsonForUsers[player.name], state);

        player.socket.send('gamestate', stateToSend, { full });

        game.jsonForUsers[player.name] = jsondiffpatch.clone(state);
    }

    /**
     * Hold a spectator's state until the broadcast delay has elapsed.
     *
     * The state is captured now and delivered later, rather than recomputed on
     * a timer - what a delayed viewer must see is the position as it was
     * `delayMs` ago, not a stale render of the position as it is.
     */
    queueDelayedState(game, playerName, state, delayMs) {
        if (!game.spectatorDelayQueue) {
            game.spectatorDelayQueue = [];
        }

        game.spectatorDelayQueue.push({
            playerName,
            state: jsondiffpatch.clone(state),
            dueAt: Date.now() + delayMs
        });

        this.scheduleDelayedFlush(game);
    }

    scheduleDelayedFlush(game) {
        if (game.spectatorDelayTimer || !game.spectatorDelayQueue?.length) {
            return;
        }

        const wait = Math.max(0, game.spectatorDelayQueue[0].dueAt - Date.now());

        game.spectatorDelayTimer = setTimeout(() => {
            game.spectatorDelayTimer = null;
            this.flushDelayedStates(game);
        }, wait);

        if (game.spectatorDelayTimer.unref) {
            game.spectatorDelayTimer.unref();
        }
    }

    /**
     * Deliver every queued spectator state whose delay has elapsed. `force`
     * delivers the lot regardless, which is what a finished or closing game
     * needs so the tail of the game is not simply dropped on the floor.
     */
    flushDelayedStates(game, { force = false } = {}) {
        const queue = game.spectatorDelayQueue;

        if (!queue || queue.length === 0) {
            return;
        }

        const now = Date.now();

        while (queue.length > 0 && (force || queue[0].dueAt <= now)) {
            const entry = queue.shift();
            const player = game.playersAndSpectators[entry.playerName];

            // A spectator who left in the meantime simply misses it.
            if (player && !player.left && !player.disconnectedAt && player.socket) {
                try {
                    this.sendStateTo(game, player, entry.state);
                } catch (err) {
                    logger.error('Failed to send delayed spectator state', err);
                }
            }
        }

        this.scheduleDelayedFlush(game);
    }

    /** Stop a game's delay timer and deliver anything still held. */
    clearSpectatorDelay(game) {
        if (game.spectatorDelayTimer) {
            clearTimeout(game.spectatorDelayTimer);
            game.spectatorDelayTimer = null;
        }

        this.flushDelayedStates(game, { force: true });
    }

    /**
     * @param {import("socket.io").Socket} socket
     * @param {() => void} next
     */
    handshake(socket, next) {
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;
        if (token && token !== 'undefined') {
            jwt.verify(token, this.configService.getValue('secret'), function (err, user) {
                if (err) {
                    return;
                }

                socket.request.user = user;
            });
        }

        next();
    }

    /**
     * @param {import("../game/game")} game
     * @param {string} reason
     * @param {import("../game/player")} winner
     */
    gameWon(game, reason, winner) {
        // ARCHON: remembered so the result can be re-delivered if the lobby was
        // not listening when it was first sent. See onLobbyReconnected.
        game.reportedWin = { winner: winner.name, reason: reason };

        this.gameSocket.send('GAMEWIN', {
            game: game.getSaveState(),
            winner: winner.name,
            reason: reason,
            // ARCHON: recorded play-by-play for the replay viewer.
            replay: game.getReplay()
        });
    }

    /**
     * The node was told to restart. Drain first: the games in progress here have
     * no other home, so they are played out before the process exits and the
     * container's restart policy brings it back.
     */
    onRestartRequested() {
        if (!this.healthServer) {
            logger.error('Restart requested before the health server was ready');

            return;
        }

        this.healthServer.startDraining();
    }

    /**
     * The lobby has just come up. Re-deliver the results of any finished game it
     * may not have received.
     *
     * ARCHON: node -> lobby messages go over Redis pub/sub, which has no
     * buffering - anything published while the lobby's subscriber is down is
     * dropped on the floor, with no ack and no retry. For most commands that
     * costs nothing (the HELLO that follows resyncs the game list anyway), but a
     * GAMEWIN lost this way is a game that finished and was then never recorded:
     * no Games row, no replay, no rating. A lobby restart during a rebuild is
     * exactly when it happens, and it is silent.
     *
     * A finished game stays in memory here for 20 minutes before
     * clearStaleAndFinishedGames closes it, so the result is still available to
     * send again. Everything downstream is idempotent by construction - update()
     * is plain UPDATEs, saveReplay() is ON CONFLICT DO NOTHING, rating is
     * guarded by RatingHistory and tournament reporting by `WinnerId IS NULL` -
     * so a duplicate costs a few queries and changes nothing.
     */
    onLobbyReconnected() {
        const finished = Object.values(this.games).filter((game) => game.reportedWin);

        for (const game of finished) {
            logger.info(`Re-reporting the result of finished game ${game.id} to the lobby`);

            this.gameSocket.send('GAMEWIN', {
                game: game.getSaveState(),
                winner: game.reportedWin.winner,
                reason: game.reportedWin.reason,
                replay: game.getReplay()
            });
        }
    }

    /**
     * @param {import("../game/game")} game
     */
    rematch(game) {
        this.gameSocket.send('REMATCH', { game: game.getSaveState() });

        for (let player of Object.values(game.getPlayersAndSpectators())) {
            if (player.left || player.disconnectedAt || !player.socket) {
                continue;
            }

            player.socket.send('cleargamestate');
            player.socket.leaveChannel(game.id);
            player.left = true; // So they don't get game state sent after the /rematch command is issued
        }

        delete this.games[game.id];
    }

    /**
     * ARCHON: hand a finished tournament table back so the match can continue.
     *
     * Structurally a rematch - the players are cleared out and the node lets
     * the game go - but the lobby's handler is entirely different: rather than
     * building a fresh game, it seats both players at the table the event has
     * already opened for the next game of this match.
     *
     * @param {import("../game/game")} game
     */
    tournamentNextGame(game) {
        this.gameSocket.send('TOURNAMENTNEXTGAME', { game: game.getSaveState() });

        for (let player of Object.values(game.getPlayersAndSpectators())) {
            if (player.left || player.disconnectedAt || !player.socket) {
                continue;
            }

            player.socket.send('cleargamestate');
            player.socket.leaveChannel(game.id);
            // So no further game state is sent to somebody the lobby is about
            // to seat somewhere else.
            player.left = true;
        }

        delete this.games[game.id];
    }

    /**
     * @param {import("../game/game")} game
     */
    rematchWithNewDecks(game) {
        this.gameSocket.send('REMATCHWITHNEWDECKS', { game: game.getSaveState() });

        for (let player of Object.values(game.getPlayersAndSpectators())) {
            if (player.left || player.disconnectedAt || !player.socket) {
                continue;
            }

            player.socket.send('cleargamestate');
            player.socket.leaveChannel(game.id);
            player.left = true;
        }

        delete this.games[game.id];
    }

    /**
     * @param {import("../pendinggame")} pendingGame
     */
    onStartGame(pendingGame) {
        let game = new Game(pendingGame, { router: this, cardData: this.cardData });

        game.on('onTimeExpired', () => {
            this.sendGameState(game);
        });
        this.games[pendingGame.id] = game;

        game.started = true;
        for (let player of Object.values(pendingGame.players)) {
            let playerName = player.name;
            game.setWins(playerName, player.wins);

            if (
                (pendingGame.gameFormat === 'reversal' || pendingGame.swap) &&
                !(pendingGame.gameFormat === 'reversal' && pendingGame.swap)
            ) {
                let otherPlayer = game.getOtherPlayer(player);
                if (otherPlayer) {
                    playerName = otherPlayer.name;
                }
            }

            game.selectDeck(playerName, player.deck);
        }

        game.initialise();
        if (pendingGame.rematch) {
            game.addAlert('info', 'The rematch is ready');
        }
    }

    /**
     * @param {import("../pendinggame")} pendingGame
     * @param {any} user
     */
    onSpectator(pendingGame, user) {
        const game = this.games[pendingGame.gameId];
        if (!game) {
            return;
        }

        game.watch('TBA', user);

        this.sendGameState(game);
    }

    onGameSync(callback) {
        const gameSummaries = Object.values(this.games).map((game) => {
            var retGame = game.getSummary(undefined, { fullData: true });
            retGame.password = game.password;

            return retGame;
        });

        logger.info(`syncing ${gameSummaries.length} games`);

        callback(gameSummaries);
    }

    /**
     * @param {string} gameId
     * @param {string} username
     */
    onFailedConnect(gameId, username) {
        const game = this.findGameForUser(username);
        if (!game || game.id !== gameId) {
            return;
        }

        game.failedConnect(username);

        if (game.isEmpty()) {
            delete this.games[game.id];

            this.gameSocket.send('GAMECLOSED', { game: game.id });
        }

        this.sendGameState(game);
    }

    /**
     * @param {string} gameId
     */
    onCloseGame(gameId) {
        let game = this.games[gameId];
        if (!game) {
            return;
        }

        for (let player of Object.values(game.getPlayersAndSpectators())) {
            player.socket.send('cleargamestate');
            player.socket.leaveChannel(game.id);
        }

        delete this.games[gameId];
        this.gameSocket.send('GAMECLOSED', { game: game.id });
    }

    onCardData(cardData) {
        this.cardData = cardData;
    }

    onConnection(ioSocket) {
        if (!ioSocket.request.user) {
            logger.info('socket connected with no user, disconnecting');
            ioSocket.disconnect();

            return;
        }

        let game = this.findGameForUser(ioSocket.request.user.username);
        if (!game) {
            logger.info(`No game for ${ioSocket.request.user.username} disconnecting`);
            ioSocket.disconnect();
            return;
        }

        let socket = new Socket(ioSocket, { configService: this.configService });

        let player = game.playersAndSpectators[socket.user.username];
        if (!player) {
            return;
        }

        // ARCHON: a player holds one socket and one diff baseline, both keyed by
        // name, so a second live connection for the same user takes over both -
        // another tab, the phone app, or a reconnect that beat the old socket's
        // ping timeout. The displaced client was left holding an open socket
        // that would never be sent anything again: its board silently stopped
        // updating and only a refresh brought it back. Close it instead, so it
        // sees a disconnect and can reconnect or say that it is offline.
        const supersededSocket = player.socket;

        player.lobbyId = player.id;
        player.id = socket.id;
        player.connectionSucceeded = true;

        if (player.disconnectedAt) {
            logger.info(`user '${socket.user.username} reconnected to game`);
            game.reconnect(socket, player.name);
        }

        socket.joinChannel(game.id);

        player.socket = socket;
        game.jsonForUsers[player.name] = undefined;

        if (supersededSocket && supersededSocket.id !== socket.id) {
            logger.info(
                `user '${socket.user.username}' opened a second game connection, closing the first`
            );

            // The player already points at the new socket, so this close runs
            // through onSocketDisconnected's `player.id !== socket.id` guard and
            // cannot mark the player disconnected or tear the game down.
            supersededSocket.tIsClosing = true;
            supersededSocket.disconnect();
        }

        if (!game.isSpectator(player) && !player.disconnectedAt) {
            game.addAlert('info', '{0} has connected to the game server', player);
        } else if (game.isSpectator(player) && player.disconnectedAt) {
            game.addAlert('info', '{0} reconnected to the game as a spectator', player);
        }

        this.sendGameState(game);

        socket.registerEvent('game', this.onGameMessage.bind(this));
        socket.on('disconnect', this.onSocketDisconnected.bind(this));
    }

    onSocketDisconnected(socket, reason) {
        let game = this.findGameForUser(socket.user.username);
        if (!game) {
            return;
        }

        logger.info(`user '${socket.user.username}' disconnected from a game: ${reason}`);

        let player = game.playersAndSpectators[socket.user.username];
        if (player.id !== socket.id) {
            return;
        }

        let isSpectator = player && player.isSpectator();

        game.disconnect(socket.user.username);

        if (!socket.tIsClosing) {
            if (game.isEmpty()) {
                delete this.games[game.id];

                this.gameSocket.send('GAMECLOSED', { game: game.id });
            } else if (isSpectator) {
                this.gameSocket.send('PLAYERLEFT', {
                    gameId: game.id,
                    game: game.getSaveState(),
                    player: socket.user.username,
                    spectator: true
                });
            }
        }

        this.sendGameState(game);
    }

    onLeaveGame(socket) {
        let game = this.findGameForUser(socket.user.username);
        if (!game) {
            return;
        }

        let player = game.playersAndSpectators[socket.user.username];
        let isSpectator = player.isSpectator();

        game.leave(socket.user.username);

        this.gameSocket.send('PLAYERLEFT', {
            gameId: game.id,
            game: game.getSaveState(),
            player: socket.user.username,
            spectator: isSpectator
        });

        socket.send('cleargamestate');
        socket.leaveChannel(game.id);

        if (game.isEmpty()) {
            delete this.games[game.id];

            this.gameSocket.send('GAMECLOSED', { game: game.id });
            this.sendGameState(game);
        } else {
            // Re-run the pipeline so any prompts currently waiting on the
            // departing player (e.g. the post-game rematch prompt) can
            // recompute their buttons / completion based on the new
            // `player.left` state. Without this, the remaining player keeps
            // seeing stale buttons until the next game action.
            this.runAndCatchErrors(game, () => {
                game.continue();
                this.sendGameState(game);
            });
        }
    }

    /**
     * ARCHON: send a player a complete snapshot of the board, on request.
     *
     * A client that suspects its board has drifted - a delta that would not
     * apply, or a socket the OS suspended in the background that may have
     * missed updates - used to have exactly one way to ask for a clean copy:
     * drop the connection, because reconnecting is what resets the diff
     * baseline. That works, but it takes the board off screen for a round trip
     * and races the outgoing socket against the incoming one. This does the
     * same thing over the live connection.
     */
    onResync(socket) {
        const game = this.findGameForUser(socket.user.username);
        if (!game) {
            return;
        }

        const player = game.playersAndSpectators[socket.user.username];

        // Ignore a socket that has already been superseded: resetting the
        // baseline on its behalf would desynchronise the client that actually
        // holds the player's connection.
        if (!player || player.socket !== socket) {
            return;
        }

        game.jsonForUsers[player.name] = undefined;

        this.runAndCatchErrors(game, () => {
            this.deliverStateTo(game, player);
        });
    }

    onGameMessage(socket, command, ...args) {
        let game = this.findGameForUser(socket.user.username);

        if (!game) {
            return;
        }

        if (command === 'leavegame') {
            return this.onLeaveGame(socket);
        }

        if (command === 'resync') {
            return this.onResync(socket);
        }

        if (!game[command] || !(game[command] instanceof Function)) {
            return;
        }

        this.runAndCatchErrors(game, () => {
            game.notePlayerEvent(socket.user.username);

            game[command](socket.user.username, ...args);

            game.continue();

            this.sendGameState(game);
        });
    }
}

module.exports = GameServer;
