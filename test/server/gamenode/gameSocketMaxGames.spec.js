const config = require('config');
const GameSocket = require('../../../server/gamenode/gamesocket.js');

/**
 * ARCHON: the per-node game cap has to come from `config.gameNode.maxGames`,
 * the key the config file documents and the one gamerouter.js compares
 * `numGames` against. `onGameSync` used to read the flat `config.maxGames`,
 * which no config file sets, so `numGames >= undefined` was always false and
 * a node advertised no ceiling regardless of what an operator configured.
 */
describe('GameSocket onGameSync maxGames', function () {
    const originalMaxGames = config.gameNode.maxGames;

    afterEach(function () {
        config.gameNode.maxGames = originalMaxGames;
    });

    // Object.create rather than `new`: the constructor connects to Redis.
    const buildSocket = () => Object.create(GameSocket.prototype);

    it('advertises config.gameNode.maxGames when not draining', function () {
        config.gameNode.maxGames = 5;

        const socket = buildSocket();
        socket.isDraining = false;
        socket.version = '1.0.0';
        socket.protocol = 'https';

        let sent;
        socket.send = (command, arg) => {
            sent = { command, arg };
        };

        socket.onGameSync([]);

        expect(sent.command).toBe('HELLO');
        expect(sent.arg.maxGames).toBe(5);
    });

    it('advertises 0 while draining regardless of the configured cap', function () {
        config.gameNode.maxGames = 5;

        const socket = buildSocket();
        socket.isDraining = true;
        socket.version = '1.0.0';
        socket.protocol = 'https';

        let sent;
        socket.send = (command, arg) => {
            sent = { command, arg };
        };

        socket.onGameSync([]);

        expect(sent.arg.maxGames).toBe(0);
    });
});
