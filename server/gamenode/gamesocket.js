const EventEmitter = require('events');

const config = require('config');
const logger = require('../log.js');
const RedisClientFactory = require('../services/RedisClientFactory');
const { detectBinary } = require('../util');

/**
 * How many games this node will hold before the lobby places elsewhere.
 *
 * ARCHON: this used to read `config.maxGames` at the top level, while
 * config/default.json5 documents the setting under `gameNode`. Anyone following
 * the config file therefore set a key nothing read, and the value here was
 * always undefined - which the router's `numGames >= maxGames` treats as false
 * for any number, so the cap silently did not exist.
 *
 * Read from the section first, fall back to the old top-level key so a
 * deployment that happened to set it there is unaffected, and leave it undefined
 * when neither is set. The router reads undefined as unlimited, which is the
 * behaviour every deployment has today - this fixes which key is honoured, not
 * what an unconfigured node does.
 */
const resolveMaxGames = () => {
    for (const key of ['gameNode.maxGames', 'maxGames']) {
        if (!config.has(key)) {
            continue;
        }

        const value = Number(config.get(key));

        if (Number.isFinite(value) && value > 0) {
            return value;
        }
    }

    return undefined;
};

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
        this.maxGames = resolveMaxGames();

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
            maxGames: this.isDraining ? 0 : this.maxGames,
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
                // ARCHON: this used to `spawnSync('pm2', ['restart', ...])`,
                // inherited from an upstream deployment that ran under pm2.
                // Nothing installs pm2 here, so the admin panel's Restart button
                // spawned a command that did not exist and reported nothing -
                // the one control an operator would reach for during an incident
                // was silently inert.
                //
                // Restart now means: stop taking new games, wait for the ones in
                // progress to end, then exit and let the container's restart
                // policy bring the node back. Nobody's game dies for a restart,
                // and the node shows as `draining` in the admin table
                // immediately, so the click has visible feedback.
                logger.info('Restart requested by the lobby - draining before exit');
                this.emit('onRestartRequested');
                break;
            case 'LOBBYHELLO':
                this.emit('onGameSync', this.onGameSync.bind(this));
                // Announced separately from the sync, which also fires on our own
                // startup and whenever the drain state changes. This one means
                // specifically "the lobby has just come up", which is the only
                // moment a result it never received can be re-delivered.
                this.emit('onLobbyReconnected');
                break;
        }
    }
}

module.exports = GameSocket;
