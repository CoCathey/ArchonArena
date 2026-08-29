const EventEmitter = require('events');

const config = require('config');
const logger = require('../log.js');
const RedisClientFactory = require('../services/RedisClientFactory');
const { detectBinary } = require('../util');

// ARCHON (N10): a finished game's result is queued here, not just published -
// see the comment on `send()` below.
const PENDING_GAME_RESULTS_KEY = 'pendingGameResults';

class GameSocket extends EventEmitter {
    /**
     * @param {import("../services/ConfigService.js")} configService
     * @param {string} listenAddress
     * @param {string} protocol
     * @param {string} version
     */
    constructor(configService, listenAddress, protocol, version) {
        super();

        this.configService = configService;
        this.listenAddress = listenAddress;
        this.protocol = protocol;
        this.version = version;
        this.isDraining = false;

        this.nodeName = process.env.SERVER || configService.getValueForSection('gameNode', 'name');

        const factory = new RedisClientFactory(configService);
        this.subscriber = factory.createClient();
        this.publisher = factory.createClient();
        this.redis = factory.createClient();

        this.subscriber.on('error', this.onError);
        this.publisher.on('error', this.onError);

        this.subscriber
            .connect()
            .then(() => {
                return Promise.all([
                    this.subscriber.subscribe(this.nodeName, this.onMessage.bind(this)),
                    this.subscriber.subscribe('allnodes', this.onMessage.bind(this))
                ]);
            })
            .then(() => {
                this.onConnect('allnodes');
            });

        this.publisher.connect();
        this.redis
            .connect()
            .then(() => {
                return this.redis.get('cards');
            })
            .then((cards) => {
                if (!cards) {
                    logger.error('No cards found in redis');
                    return;
                }

                this.emit('onCardData', JSON.parse(cards));
            })
            .catch((err) => {
                logger.error('Error loading cards from redis', err);
            });
    }

    send(command, arg) {
        let data = '';

        try {
            data = JSON.stringify({
                command: command,
                arg: arg,
                identity: this.nodeName
            });
        } catch (err) {
            logger.error('Failed to stringify node data', err);
            for (let obj of Object.values(detectBinary(arg))) {
                logger.error(`Path: ${obj.path}, Type: ${obj.type}`);
            }

            return;
        }

        if (command === 'GAMEWIN') {
            // A game result must survive the lobby being unreachable at the
            // exact instant it is sent: pub/sub only delivers to a subscriber
            // connected right now and drops the message for good otherwise -
            // which is exactly what a lobby restart does to a result
            // published in that window (N10: never recorded, rated or
            // replayed). Queuing it durably first means the payload is never
            // lost; the lobby drains this list on startup and periodically
            // (`gamerouter.js`). The publish below stays the fast path for a
            // lobby that is already listening.
            this.publisher
                .rPush(PENDING_GAME_RESULTS_KEY, data)
                .catch((err) => logger.error('Failed to queue game result for durability', err));
        }

        this.publisher.publish('nodemessage', data);
    }

    /**
     * @param {Error} err
     */
    onError(err) {
        logger.error('Redis error: ', err);
    }

    onConnect(channel) {
        if (channel === 'allnodes') {
            this.emit('onGameSync', this.onGameSync.bind(this));
        }
    }

    onGameSync(games) {
        const helloData = {
            maxGames: this.isDraining ? 0 : config.gameNode.maxGames,
            version: this.version,
            port:
                process.env.NODE_ENV === 'production'
                    ? 80
                    : process.env.PORT || config.gameNode.socketioPort,
            protocol: this.protocol,
            games: games,
            draining: this.isDraining
        };

        if (this.listenAddress) {
            helloData.address = this.listenAddress;
        }

        this.send('HELLO', helloData);
    }

    setDraining(draining) {
        if (this.isDraining !== draining) {
            this.isDraining = draining;
            logger.info(`Node draining status changed to: ${draining}`);

            this.emit('onGameSync', this.onGameSync.bind(this));
        }
    }

    /**
     * @param {string} channel
     * @param {string} msg
     */
    onMessage(msg, channel) {
        if (channel !== 'allnodes' && channel !== this.nodeName) {
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

        switch (message.command) {
            case 'PING':
                this.send('PONG');
                break;
            case 'STARTGAME':
                this.emit('onStartGame', message.arg);
                break;
            case 'SPECTATOR':
                this.emit('onSpectator', message.arg.game, message.arg.user);
                break;
            case 'CONNECTFAILED':
                this.emit('onFailedConnect', message.arg.gameId, message.arg.username);
                break;
            case 'CLOSEGAME':
                this.emit('onCloseGame', message.arg.gameId);
                break;
            case 'RESTART':
                // This stack runs game nodes under Docker (`restart: unless-stopped`),
                // not pm2 - there is no pm2 binary to shell out to. Draining and exiting
                // reuses the same graceful shutdown HealthServer already does for SIGTERM
                // (docs/DEPLOYMENT.md), so the container's own restart policy brings the
                // node back once its games have finished.
                logger.info('Got told to restart - starting graceful drain');
                this.emit('onRestart');
                break;
            case 'LOBBYHELLO':
                this.emit('onGameSync', this.onGameSync.bind(this));
                break;
        }
    }
}

module.exports = GameSocket;
