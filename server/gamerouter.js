const EventEmitter = require('events');

const logger = require('./log');
const GameService = require('./services/GameService');
// ARCHON: ratings react to finished games (docs/design/rating-engine.md)
const RatingService = require('./services/rating/RatingService');
const RedisClientFactory = require('./services/RedisClientFactory');
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

        this.gameService.create(game.getSaveState());

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
                this.isWorkerFull(worker) ||
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

    /**
     * Whether a worker is at capacity.
     *
     * ARCHON: an unset maxGames means unlimited, and says so. This was written
     * as `worker.numGames >= worker.maxGames`, which reaches the same conclusion
     * for the wrong reason - any comparison against undefined is false, so the
     * node looked infinitely large because the check was broken rather than
     * because a cap was deliberately not configured. A draining node reports
     * maxGames: 0, which is finite and therefore still enforced.
     *
     * @param {{ numGames: number, maxGames?: number }} worker
     */
    isWorkerFull(worker) {
        const maxGames = Number(worker.maxGames);

        if (!Number.isFinite(maxGames)) {
            return false;
        }

        return worker.numGames >= maxGames;
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
                draining: worker.draining || false,
                // Reported separately from `status` so the admin table can label
                // its toggle from the flag the toggle actually flips. A draining
                // node is not disabled, and offering "Enable" for it - which is
                // what deriving the label from `status` did - describes neither
                // the current state nor what the button would do.
                disabled: worker.disabled || false,
                maxGames: Number.isFinite(Number(worker.maxGames)) ? Number(worker.maxGames) : null
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
                    // ARCHON: `disabled` belongs to the lobby, not the node, so
                    // it has to survive a HELLO. The node reports what it knows
                    // about itself (version, capacity, draining, its games) and
                    // that record used to replace the worker wholesale, silently
                    // taking an admin's Disable with it.
                    //
                    // A HELLO is no longer a rare event: every lobby restart
                    // broadcasts LOBBYHELLO and every node answers, and a node
                    // sends one whenever its drain state changes. So a rolling
                    // deploy - which restarts the lobby - would have quietly put
                    // every disabled node back into rotation, with the admin
                    // table showing "Disable" again as if nobody had touched it.
                    disabled: !!(worker && worker.disabled),
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
                Promise.resolve(this.gameService.update(message.arg.game))
                    .then(() =>
                        Promise.allSettled([
                            this.gameService.saveReplay(
                                message.arg.game.gameId,
                                message.arg.replay
                            ),
                            this.ratingService.processGame(message.arg.game.gameId)
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
                this.gameService.update(message.arg.game);

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
                this.gameService.update(message.arg.game);

                if (worker) {
                    worker.numGames--;
                } else {
                    logger.error(`Got a next-game handoff for non existant worker ${identity}`);
                }

                this.emit('onTournamentNextGame', message.arg.game);

                break;
            case 'REMATCHWITHNEWDECKS':
                this.gameService.update(message.arg.game);

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
                    this.gameService.update(message.arg.game);
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
