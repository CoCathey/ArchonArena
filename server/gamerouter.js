const EventEmitter = require('events');

const logger = require('./log');
const GameService = require('./services/GameService');
// ARCHON: ratings react to finished games (docs/design/rating-engine.md)
const RatingService = require('./services/rating/RatingService');
const RedisClientFactory = require('./services/RedisClientFactory');
// ARCHON (N48): the learning loop's diary, which finished human games are
// written into (see gamenode/humancapture.js).
const BotPolicyService = require('./services/championschallenge/BotPolicyService');
const {
    humanLearningConfig,
    learnsFromTable
} = require('./services/championschallenge/humanLearning');
// ARCHON (N50): which finished games are evidence about play - see humanLadder.
const { countsTowardLadder } = require('./services/championschallenge/humanLadder');
const { detectBinary } = require('./util');

class GameRouter extends EventEmitter {
    /**
     * @param {import("./services/ConfigService.js")} configService
     */
    constructor(configService) {
        super();

        this.workers = {};
        this.gameService = new GameService();
        // ARCHON: ratings react to finished games (docs/design/rating-engine.md)
        this.ratingService = new RatingService(configService);
        // ARCHON (N48): a finished human game is training data. This is the
        // only place both halves are known at once - the node ships the
        // decisions with GAMEWIN, and the diary lives in the lobby's database.
        this.policyService = new BotPolicyService(configService);

        const factory = new RedisClientFactory(configService);
        this.subscriber = factory.createClient();
        this.publisher = factory.createClient();

        this.subscriber.on('error', this.onError);
        this.publisher.on('error', this.onError);

        this.subscriber
            .connect()
            .then(() => {
                return this.subscriber.subscribe('nodemessage', this.onMessage.bind(this));
            })
            .then(() => {
                this.sendCommand('allnodes', 'LOBBYHELLO');
            });

        this.publisher.connect();

        setInterval(this.checkTimeouts.bind(this), 1000 * 60);
    }

    // External methods
    /**
     * @param {import("./pendinggame.js")} game
     */
    startGame(game) {
        let node = this.getNextAvailableGameNode();
        if (!node) {
            logger.error('Could not find new node for game');

            return undefined;
        }

        // ARCHON (F9): practice games are recorded like any other - a player
        // wants to find the game again and watch it back - but the row is
        // flagged, and every aggregate excludes flagged rows. Persisting is
        // where "it happened" is written; rating is where "it counted" is,
        // and a bot game is never rated (see GAMEWIN below).
        this.gameService.create(game.getSaveState());

        // ARCHON (N48): whether this table's human seats are captured for the
        // learning loop. Stamped here rather than at each of the three places
        // a game can start, because this is the one funnel all of them go
        // through - and because a table that started before an admin turned
        // the setting on should finish the way it started.
        game.learnFromHumans = learnsFromTable(humanLearningConfig().mode, {
            botGame: !!game.botGame
        });

        node.numGames++;

        this.sendCommand(node.identity, 'STARTGAME', game.getStartGameDetails());

        return node;
    }

    /**
     * @param {import("./pendinggame.js")} game
     * @param {import("./models/User")} user
     */
    addSpectator(game, user) {
        this.sendCommand(game.node.identity, 'SPECTATOR', {
            game: game.getSaveState(),
            user: user
        });
    }

    getNextAvailableGameNode() {
        if (Object.values(this.workers).length === 0) {
            return undefined;
        }

        let returnedWorker;
        for (const worker of Object.values(this.workers)) {
            if (
                worker.numGames >= worker.maxGames ||
                worker.disabled ||
                worker.disconnected ||
                worker.draining
            ) {
                continue;
            }

            if (!returnedWorker || returnedWorker.numGames > worker.numGames) {
                returnedWorker = worker;
            }
        }

        return returnedWorker;
    }

    getNodeStatus() {
        return Object.values(this.workers).map((worker) => {
            return {
                name: worker.identity,
                numGames: worker.numGames,
                status: worker.disconnected
                    ? 'disconnected'
                    : worker.disabled
                    ? 'disabled'
                    : worker.draining
                    ? 'draining'
                    : 'active',
                version: worker.version,
                draining: worker.draining || false
            };
        });
    }

    /**
     * @param {string} nodeName
     */
    disableNode(nodeName) {
        let worker = this.workers[nodeName];
        if (!worker) {
            return false;
        }

        worker.disabled = true;

        return true;
    }

    /**
     * @param {string} nodeName
     */
    enableNode(nodeName) {
        let worker = this.workers[nodeName];
        if (!worker) {
            return false;
        }

        worker.disabled = false;

        return true;
    }

    /**
     * @param {string} nodeName
     */
    toggleNode(nodeName) {
        let worker = this.workers[nodeName];
        if (!worker) {
            return false;
        }

        worker.disabled = !worker.disabled;

        return true;
    }

    /**
     * @param {string} nodeName
     */
    restartNode(nodeName) {
        let worker = this.workers[nodeName];
        if (!worker) {
            return false;
        }

        this.sendCommand(nodeName, 'RESTART');

        return true;
    }

    /**
     * @param {import("./pendinggame.js")} game
     * @param {string} username
     */
    notifyFailedConnect(game, username) {
        if (!game.node) {
            return;
        }

        this.sendCommand(game.node.identity, 'CONNECTFAILED', {
            gameId: game.id,
            username: username
        });
    }

    /**
     * @param {import("./pendinggame.js")} game
     */
    closeGame(game) {
        if (!game.node) {
            return;
        }

        this.sendCommand(game.node.identity, 'CLOSEGAME', { gameId: game.id });
    }

    /**
     * ARCHON: write a game's final state away, and survive it failing.
     *
     * `gameService.update()` is a promise that rejects on any database fault.
     * Four of the five places that called it did so bare - no await, no catch -
     * which is an unhandled rejection, and under Node's default policy an
     * unhandled rejection terminates the process. So a transient database
     * problem while somebody pressed Rematch or left a game did not cost a
     * database row; it took the lobby down and every game running on it with
     * it. GAMEWIN was the only one written defensively.
     *
     * Losing the row is the correct failure here: the game is over either way,
     * and the players' next action matters more than the record of their last.
     *
     * @param {object} game a save state from a game node
     */
    persistFinishedGame(game) {
        Promise.resolve(this.gameService.update(game)).catch((err) =>
            logger.error(`Failed to persist finished game ${game && game.gameId}`, err)
        );
    }

    /**
     * ARCHON (N48): file a finished human game in the training diary.
     *
     * The node captured the rows live (gamenode/humancapture.js); the diary
     * lives in the lobby's database, so this is the one point where both
     * halves exist at once. Best effort throughout - a game that has finished
     * already did everything it owed anybody.
     *
     * @param {object} arg the GAMEWIN payload
     */
    recordHumanGame(arg) {
        const human = arg && arg.humanGame;

        if (!human || !Array.isArray(human.decisions) || !human.decisions.length) {
            return;
        }

        Promise.resolve(this.policyService.recordHumanGame(human)).catch((err) =>
            logger.error('Failed to record a human game for training', err)
        );
    }

    /**
     * ARCHON (N50): file a finished practice game on the human record.
     *
     * The calibration ladder (N39) measures the champion against opponents the
     * lab built, so its ceiling is the lab's own. This is the rung that is a
     * person - and it is the only number on the page that answers the question
     * anybody actually asks about a game bot.
     *
     * Here rather than in the node because a ladder row needs the database
     * (the opponent's standing decides which band the game lands in), and
     * beside `recordHumanGame` because both are consequences of the same
     * event. Kept OUT of the persist/replay/rate chain for the same reason
     * that one is: bookkeeping must never be able to cost a game its record.
     *
     * @param {object} arg the GAMEWIN payload
     */
    recordHumanLadderGame(arg) {
        const game = arg && arg.game;

        if (!game || !game.botGame || !countsTowardLadder(arg.reason)) {
            return;
        }

        // Both shapes are checked rather than assumed: this runs BEFORE the
        // persist/replay/rate chain below it, so a throw here would cost the
        // game the three things it is actually owed.
        const botSeats = Array.isArray(arg.botSeats) ? arg.botSeats : [];
        const seats = Array.isArray(game.players) ? game.players : [];
        const humans = seats
            .map((player) => player && player.name)
            .filter((name) => name && !botSeats.includes(name));

        // A bot-versus-bot showcase has no human seat, and a table whose bot
        // seat was never identified would file the game against whoever the
        // first player happened to be. Both are "nothing to record", not a
        // guess.
        if (botSeats.length !== 1 || humans.length !== 1) {
            return;
        }

        Promise.resolve(
            this.policyService.recordHumanLadderGame({
                username: humans[0],
                botWon: arg.winner === botSeats[0],
                policyVersion: arg.botPolicyVersion
            })
        ).catch((err) => logger.error('Failed to record a practice game on the human ladder', err));
    }

    // Events
    /**
     * @param {Error} err
     */
    onError(err) {
        logger.error('Redis error: ', err);
    }

    /**
     * @param {string} channel
     * @param {string} msg
     */
    onMessage(msg, channel) {
        if (channel !== 'nodemessage') {
            logger.warn(`Message '${msg}' received for unknown channel ${channel}`);
            return;
        }

        let message;
        try {
            message = JSON.parse(msg);
        } catch (err) {
            logger.info(
                `Error decoding redis message. Channel ${channel}, message '${msg}' %o`,
                err
            );
            return;
        }

        const identity = message.identity;
        let worker = this.workers[identity];

        if (worker && worker.disconnected) {
            logger.info(`Worker ${identity} came back`);
            worker.disconnected = false;
        }

        switch (message.command) {
            case 'HELLO':
                this.emit('onWorkerStarted', identity);
                if (this.workers[identity]) {
                    logger.info(`Worker ${identity} was already known, presume reconnected`);
                    this.workers[identity].disconnected = false;
                }

                this.workers[identity] = {
                    identity: identity,
                    numGames: 0,
                    ...message.arg
                };
                worker = this.workers[identity];

                this.emit('onNodeReconnected', identity, message.arg.games);

                worker.numGames = message.arg.games.length;

                break;
            case 'PONG':
                if (worker) {
                    worker.pingSent = undefined;
                } else {
                    logger.error('PONG received for unknown worker');
                }

                break;
            case 'GAMEWIN':
                // ARCHON: persist the result, then save the replay and rate the
                // game. Best effort and idempotent; never blocks the game flow.
                // The lobby also listens so tournament matches auto-report.
                //
                // Saving the replay and rating the game are INDEPENDENT
                // consequences of a game finishing, and are run that way. They
                // used to be chained - `update -> saveReplay -> processGame` -
                // which quietly made rating conditional on the replay working.
                // A deployment whose database was missing "GameReplays" hit
                // exactly that: saveReplay rejected, the chain skipped straight
                // to the catch, and a month of games finished normally without
                // ever reaching the ladder. Nothing was broken about rating.
                //
                // Rating still runs after `update`, because it reads the rows
                // that writes. Only the replay dependency is removed.
                // ARCHON (N48): the people who just played it taught the bot
                // something. A third independent consequence, deliberately
                // outside the chain below: a diary write must never be able
                // to cost a game its record, its replay or its rating.
                this.recordHumanGame(message.arg);
                // ARCHON (N50): and how the bot did against them. A fourth
                // independent consequence, outside the chain for the same
                // reason the third is.
                this.recordHumanLadderGame(message.arg);

                Promise.resolve(this.gameService.update(message.arg.game))
                    .then(() =>
                        Promise.allSettled([
                            this.gameService.saveReplay(
                                message.arg.game.gameId,
                                message.arg.replay
                            ),
                            // ARCHON (F9): a practice game is recorded and
                            // replayable, and is never a result: no Amber
                            // moves, no record changes. The guard is here
                            // rather than inside the rating engine because
                            // this is where "should this count" is known.
                            message.arg.game && message.arg.game.botGame
                                ? Promise.resolve({ skipped: true })
                                : this.ratingService.processGame(message.arg.game.gameId)
                        ])
                    )
                    .then(([replay, rating]) => {
                        // Reported separately so the log names which one failed.
                        // "Failed to save/rate" told you neither.
                        if (replay.status === 'rejected') {
                            logger.error(
                                `Failed to save the replay for game ${message.arg.game.gameId}`,
                                replay.reason
                            );
                        }
                        if (rating.status === 'rejected') {
                            logger.error(
                                `Failed to rate game ${message.arg.game.gameId}`,
                                rating.reason
                            );
                        }
                    })
                    .catch((err) =>
                        // Only `update` reaches here now. If that failed there is
                        // no persisted game to replay or rate in the first place.
                        logger.error('Failed to persist finished game', err)
                    );

                this.emit('onGameWin', message.arg.game);
                break;
            case 'REMATCH':
                // ARCHON: the rejection handler GAMEWIN has and these three did
                // not. `update()` rejects on any database fault, and an
                // unhandled rejection terminates the process under Node's
                // default policy - so a failed write here did not lose a game
                // record, it took the whole lobby down, with every player in
                // every game on it. Which looks, to the two people who pressed
                // Rematch, exactly like the button ending their game.
                this.persistFinishedGame(message.arg.game);

                if (worker) {
                    worker.numGames--;
                } else {
                    logger.error(`Got rematch game for non existant worker ${identity}`);
                }

                this.emit('onGameRematch', message.arg.game);

                break;
            // ARCHON: a tournament series continuing at the table it is
            // already at. Same shape as a rematch - the node is done with this
            // game and its worker is freed - but the lobby seats the players at
            // the event's next table rather than building a new game.
            case 'TOURNAMENTNEXTGAME':
                this.persistFinishedGame(message.arg.game);

                if (worker) {
                    worker.numGames--;
                } else {
                    logger.error(`Got a next-game handoff for non existant worker ${identity}`);
                }

                this.emit('onTournamentNextGame', message.arg.game);

                break;
            case 'REMATCHWITHNEWDECKS':
                this.persistFinishedGame(message.arg.game);

                if (worker) {
                    worker.numGames--;
                } else {
                    logger.error(
                        `Got rematch with new decks game for non existant worker ${identity}`
                    );
                }

                this.emit('onGameRematchWithNewDecks', message.arg.game);

                break;
            case 'GAMECLOSED':
                if (worker) {
                    worker.numGames--;
                } else {
                    logger.error(`Got close game for non existant worker ${identity}`);
                }

                this.emit('onGameClosed', message.arg.game);

                break;
            case 'PLAYERLEFT':
                if (!message.arg.spectator) {
                    this.persistFinishedGame(message.arg.game);
                }

                this.emit('onPlayerLeft', message.arg.gameId, message.arg.player);

                break;
        }

        if (worker) {
            worker.lastMessage = new Date();
        }
    }

    // Internal methods
    /**
     * @param {string} channel
     * @param {string} command
     */
    sendCommand(channel, command, arg = {}) {
        let object = {
            command: command,
            arg: arg
        };

        let objectStr = '';
        try {
            objectStr = JSON.stringify(object);
        } catch (err) {
            logger.error('Failed to stringify node data', err);
            for (let obj of Object.values(detectBinary(arg))) {
                logger.error(`Path: ${obj.path}, Type: ${obj.type}`);
            }

            return;
        }

        try {
            this.publisher.publish(channel, objectStr);
        } catch (err) {
            logger.error(err);
        }
    }

    checkTimeouts() {
        const currentTime = Date.now();
        const pingTimeout = 1 * 60 * 1000;

        for (const worker of Object.values(this.workers)) {
            if (worker.disconnected) {
                continue;
            }

            if (worker.pingSent && currentTime - worker.pingSent > pingTimeout) {
                logger.info(`worker ${worker.identity} timed out`);
                worker.disconnected = true;
                this.emit('onWorkerTimedOut', worker.identity);
            } else if (!worker.pingSent) {
                if (currentTime - worker.lastMessage > pingTimeout) {
                    worker.pingSent = currentTime;
                    this.sendCommand(worker.identity, 'PING');
                }
            }
        }
    }
}

module.exports = GameRouter;
