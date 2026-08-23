const config = require('config');
const GameSocket = require('../../server/gamenode/gamesocket.js');

/**
 * The HELLO message a node sends advertises its capacity so the router's
 * `getNextAvailableGameNode` can stop routing to a full node. It used to read
 * `config.maxGames`, a key nothing ever set - the config file only documents
 * `gameNode.maxGames` - so the advertised cap was always `undefined` and
 * `numGames >= undefined` is false for every number the node could reach.
 * An operator who set `gameNode.maxGames` therefore had no effect at all.
 */
describe('GameSocket HELLO maxGames', function () {
    afterEach(function () {
        delete config.gameNode.maxGames;
    });

    const buildSocket = () => {
        // Object.create rather than `new`: the constructor connects to Redis.
        const socket = Object.create(GameSocket.prototype);
        socket.isDraining = false;
        socket.version = 'test-version';
        socket.protocol = 'https';
        socket.listenAddress = undefined;

        let sent;
        socket.send = (command, arg) => {
            sent = { command, arg };
        };

        return { socket, sentArg: () => sent && sent.arg };
    };

    it('advertises the configured gameNode.maxGames cap', function () {
        config.gameNode.maxGames = 3;

        const { socket, sentArg } = buildSocket();
        socket.onGameSync([]);

        expect(sentArg().maxGames).toBe(3);
    });

    it('advertises 0 while draining, regardless of the configured cap', function () {
        config.gameNode.maxGames = 3;

        const { socket, sentArg } = buildSocket();
        socket.isDraining = true;
        socket.onGameSync([]);

        expect(sentArg().maxGames).toBe(0);
    });
});
