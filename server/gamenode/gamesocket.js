const EventEmitter = require('events');

const config = require('config');
const logger = require('../log.js');
const RedisClientFactory = require('../services/RedisClientFactory');
const { detectBinary } = require('../util');
const { OUTBOX_KEY } = require('../nodeoutbox');

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

    /**
     * @returns {string|null} the wire form, or null if it could not be encoded
     */
    serialize(command, arg, outboxKey) {
        try {
            return JSON.stringify({
                command: command,
                arg: arg,
                identity: this.nodeName,
                // ARCHON (N10): present only on a durable send. The lobby
                // sends it back as the acknowledgement, so it travels with
                // the message rather than being re-derived at the far end.
                outboxKey: outboxKey
            });
        } catch (err) {
            logger.error('Failed to stringify node data', err);
            for (let obj of Object.values(detectBinary(arg))) {
                logger.error(`Path: ${obj.path}, Type: ${obj.type}`);
            }

            return null;
        }
    }

    send(command, arg) {
        const data = this.serialize(command, arg);

        if (data === null) {
            return;
        }

        this.publisher.publish('nodemessage', data);
    }

    /**
     * ARCHON (N10): a send that survives the lobby not being there.
     *
     * `nodemessage` is Redis pub/sub, which is at-most-once: a publish with no
     * subscriber is discarded, and the lobby is the only subscriber. A deploy
     * restarts it, so a game finishing in that window was never recorded,
     * rated or replayed - and nothing told either player.
     *
     * The message is written to an outbox hash BEFORE it is published, so the
     * record exists whether or not anybody is listening. Redis outlives the
     * lobby (its own container, `appendonly yes` on a named volume), and the
     * lobby drains the outbox when it comes back and clears each entry once
     * the game is recorded.
     *
     * The outbox write is best effort and never gates the publish: if Redis
     * refuses it we are exactly where we were before this existed, which is
     * the one thing a safety net must never make worse.
     *
     * @param {string} command
     * @param {object} arg
     * @param {string} key stable per event, so a redelivery overwrites rather
     * than accumulates - a game finishes once
     */
    async sendDurable(command, arg, key) {
        const data = this.serialize(command, arg, key);

        if (data === null) {
            return;
        }

        try {
            await this.publisher.hSet(OUTBOX_KEY, key, data);
        } catch (err) {
            logger.error(`Failed to file ${key} in the durable outbox`, err);
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
