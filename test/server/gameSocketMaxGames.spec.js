const config = require('config');
const GameSocket = require('../../server/gamenode/gamesocket.js');

/**
 * onGameSync's HELLO payload used to read `config.maxGames`, a top-level key
 * the config files never set - only `gameNode.maxGames` is documented. The
 * router's cap check (`numGames >= maxGames`) is then always false against
 * `undefined`, so a node never stops accepting games no matter what an
 * operator configures. This pins the payload to the documented key.
 */
describe('GameSocket HELLO maxGames', function () {
    afterEach(function () {
        delete config.gameNode.maxGames;
    });

    it('reports the configured gameNode.maxGames', function () {
        config.gameNode.maxGames = 5;

        // Object.create rather than `new`: the constructor connects to Redis.
        const socket = Object.create(GameSocket.prototype);
        socket.isDraining = false;
        socket.listenAddress = undefined;
        socket.version = '1.0.0';
        socket.protocol = 'ws';

        let sent;
        socket.send = (command, arg) => {
            sent = { command, arg };
        };

        socket.onGameSync({});

        expect(sent.command).toBe('HELLO');
        expect(sent.arg.maxGames).toBe(5);
    });

    it('reports 0 while draining regardless of the configured cap', function () {
        config.gameNode.maxGames = 5;

        const socket = Object.create(GameSocket.prototype);
        socket.isDraining = true;
        socket.listenAddress = undefined;
        socket.version = '1.0.0';
        socket.protocol = 'ws';

        let sent;
        socket.send = (command, arg) => {
            sent = { command, arg };
        };

        socket.onGameSync({});

        expect(sent.arg.maxGames).toBe(0);
    });
});
