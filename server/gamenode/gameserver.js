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
// ARCHON (F9): the Helper Bot's seat - answers the bot's prompts after every
// event that can change game state. Attached to the game instance itself so
// it lives and dies with the game.
const BotDriver = require('./botdriver.js');
const { rolesIndex: warmCardKnowledge } = require('../services/membership/cardKnowledge');

class GameServer {
    constructor() {
        this.configService = new ConfigService();
        const sentryDsn = this.configService.getValue('sentryDsn');

        if (sentryDsn) {
            Sentry.init({ dsn: sentryDsn, release: process.env.VERSION || 'Local build' });
        }

        this.games = {};
        this.protocol = 'https';

        /**
         * ARCHON (F9): read the card knowledge index now, not mid-game.
         *
         * The bots ask it "does this card take amber?" on every decision.
         * Building it parses nine megabytes of card packs synchronously -
         * a fifth of a second - and the first bot decision of a game is the
         * worst possible moment to spend it, because a blocked event loop
         * on this process is a table that visibly freezes. Once at startup,
         * cached for the life of the node.
         */
        warmCardKnowledge();

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

        this.installCrashGuards();

        if (process.env.SCENARIO) {
            require('../devtools/scenario/host.js').install(this, process.env.SCENARIO);
        }
    }

    /**
     * ARCHON: one bad moment must not evict everybody on this node.
     *
     * The node holds every live game in memory. Node's default behaviour on
     * an uncaught exception - and, since v15, on an unhandled promise
     * rejection - is to kill the process, which here means every player on
     * this node is disconnected mid-game and their game is gone: it exists
     * nowhere else. The lobby then sees the node die and clears its tables,
     * so the visible symptom is a board that freezes and a game that has
     * vanished, with nothing in the client to explain it.
     *
     * Errors that happen while RESOLVING a game are already contained
     * per-game (`runAndCatchErrors`), which is the honest place to handle
     * them. What reaches here is what escaped that: a throw from inside a
     * timer, a socket callback, or a promise nobody awaited. For those, a
     * loud log and a living process is strictly better than taking twenty
     * other games down - the game that threw is the one at risk, not the
     * rest, and a node that survives can still be drained and restarted
     * deliberately.
     */
    installCrashGuards() {
        if (GameServer.crashGuardsInstalled) {
            return;
        }

        GameServer.crashGuardsInstalled = true;

        const report = (kind, error) => {
            // Logged first and unconditionally: whatever else fails after
            // this, the reason the node nearly died is in the log.
            logger.error(`${kind} on the game node`, error);

            try {
                Sentry.captureException(error);
            } catch (sentryError) {
                logger.error('Failed to report the error to Sentry', sentryError);
            }
        };

        process.on('uncaughtException', (error) => report('Uncaught exception', error));
        process.on('unhandledRejection', (reason) => report('Unhandled rejection', reason));
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
        // ARCHON: the last moment at which this game can be recorded at all -
        // after this it is deleted from memory and only GAMECLOSED goes to the
        // lobby, which (unlike GAMEWIN and PLAYERLEFT) persists nothing. A game
        // both players walked out on is decided here or never.
        this.runAndCatchErrors(game, () => game.checkAbandonment({ closing: true }));

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

        /**
         * ARCHON: this sweep runs on a timer, and a throw inside a timer is
         * an uncaught exception - which used to mean the whole node, and
         * every live game on it, died because ONE game's state upset one
         * predicate. The work inside is already per-game; the containment
         * now is too, so a game that cannot be swept is a game that cannot
         * be swept, not an outage.
         */
        const perGame = (game, what, work) => {
            try {
                work();
            } catch (err) {
                logger.error(`Failed to ${what} game ${game && game.id}`, err);
            }
        };

        const staleGames = Object.values(this.games).filter((game) => {
            try {
                return game.finishedAt && Date.now() - game.finishedAt > timeout;
            } catch {
                return false;
            }
        });
        for (const game of staleGames) {
            perGame(game, 'close finished', () => {
                logger.info(`closed finished game ${game.id} due to inactivity`);
                this.closeGame(game);
            });
        }

        const emptyGames = Object.values(this.games).filter((game) => {
            try {
                return game.isEmpty();
            } catch (err) {
                logger.error(`Failed to check whether game ${game && game.id} is empty`, err);

                return false;
            }
        });
        for (const game of emptyGames) {
            perGame(game, 'close empty', () => {
                logger.info(`closed empty game ${game.id}`);
                this.closeGame(game);
            });
        }

        // Check for player inactivity in active games. Piggybacks on the
        // existing 30s sweep to set the forcePassAvailable flag.
        for (const game of Object.values(this.games)) {
            if (game.finishedAt) {
                continue;
            }

            let inactive = false;

            perGame(game, 'check inactivity in', () => {
                inactive = game.checkInactivity();
            });

            if (inactive) {
                this.runAndCatchErrors(game, () => {
                    game.continue();

                    // ARCHON (F9): safety net - if a prompt has somehow been
                    // waiting on the bot since the last event, answer it now
                    // rather than leaving the human staring at a stuck board.
                    if (game.botDriver) {
                        game.botDriver.pump(game);
                    }

                    this.sendGameState(game);
                });
            }
        }

        // ARCHON: award games whose loser closed the site and never came back.
        // Runs on every sweep rather than only at close, so the win lands while
        // the remaining player is still at the board to see it - and, more to
        // the point, so it does not depend on them doing anything at all.
        for (const game of Object.values(this.games)) {
            this.runAndCatchErrors(game, () => {
                if (game.checkAbandonment()) {
                    game.continue();

                    if (game.botDriver) {
                        game.botDriver.pump(game);
                    }

                    this.sendGameState(game);
                }
            });
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
        this.gameSocket.send('GAMEWIN', {
            game: game.getSaveState(),
            winner: winner.name,
            reason: reason,
            // ARCHON: recorded play-by-play for the replay viewer.
            replay: game.getReplay()
        });
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

        // ARCHON (F9): seat the bot. The lobby marks the bot's seat on the
        // start details (player.isBot); the driver answers its prompts from
        // here on - starting now, because initialise() has already dealt the
        // mulligan prompt and nobody is coming to click for the bot.
        const botNames = Object.values(pendingGame.players)
            .filter((player) => player.isBot)
            .map((player) => player.name);

        if (botNames.length > 0) {
            game.botDriver = new BotDriver(botNames, {
                maxTurns: pendingGame.botMaxTurns,
                // ARCHON (F9): play at a pace a person can watch.
                thinkMs: pendingGame.botThinkMs,
                // ARCHON (N21): the Champion's Challenge's reigning model,
                // so the practice opponent plays what the lab learned.
                policy: pendingGame.botPolicy,
                // A pump that runs out of its event-loop budget finishes here,
                // on a later tick, with the board pushed out as it goes. The
                // node stays responsive to every other game on it - and to the
                // lobby's ping, which is what decides this node is alive.
                resume: () =>
                    this.runAndCatchErrors(game, () => {
                        game.botDriver.pump(game);
                        this.sendGameState(game);
                    })
            });
            game.addAlert('info', 'Good luck, have fun!');
            this.runAndCatchErrors(game, () => {
                game.botDriver.pump(game);
            });
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

        // ARCHON: the same last chance to record a result that closeGame takes.
        // This path does not go through it - the lobby forces a close here when
        // every player has escaped over the lobby socket - so without this the
        // node would drop an abandoned game on the floor.
        this.runAndCatchErrors(game, () => game.checkAbandonment({ closing: true }));

        for (let player of Object.values(game.getPlayersAndSpectators())) {
            // ARCHON: a disconnected player has no socket - `disconnect()` sets
            // it to undefined. Unguarded, this threw a TypeError before the
            // game was deleted or GAMECLOSED was sent, which leaked the game on
            // this node and left the lobby waiting for a reply that never came.
            // The games that reach here are precisely the ones somebody walked
            // out of, so the missing case was the only case.
            if (!player.socket) {
                continue;
            }

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
        // ARCHON: socket.io calls this directly, so a throw here is an
        // uncaught exception and used to take the node - and every game on
        // it - down at the moment somebody was trying to JOIN a game. The
        // player who cannot be seated is told nothing useful either way; the
        // difference is whether everybody else keeps playing.
        try {
            this.seatConnection(ioSocket);
        } catch (err) {
            logger.error(
                `Failed to connect ${ioSocket?.request?.user?.username} to their game`,
                err
            );

            try {
                ioSocket.disconnect();
            } catch {
                // Nothing more to do: the socket is already unusable.
            }
        }
    }

    seatConnection(ioSocket) {
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

            // ARCHON (F9): whatever the human just did may have handed the
            // bot a prompt (its turn, a trigger window, a fight choice).
            // Answer before the state goes out, so the human never watches
            // a bot "thinking" about a window they cannot see.
            if (game.botDriver) {
                game.botDriver.pump(game);
            }

            this.sendGameState(game);
        });
    }
}

module.exports = GameServer;
