const GameSocket = require('../../../server/gamenode/gamesocket.js');

/**
 * ARCHON: the HELLO payload's maxGames must come from the *section* the
 * config file documents (`gameNode.maxGames`), not a top-level key that
 * never existed. Reading the wrong key meant every worker announced
 * `maxGames: undefined`, and `numGames >= undefined` is false for any
 * numGames, so the per-node cap was silently never enforced.
 */
const buildSocket = (maxGames) => {
    // Object.create rather than `new`: the constructor connects to Redis.
    const socket = Object.create(GameSocket.prototype);

    socket.isDraining = false;
    socket.version = '1.0.0';
    socket.protocol = 'https';
    socket.listenAddress = undefined;
    socket.configService = {
        getValueForSection: (section, key) => {
            if (section === 'gameNode' && key === 'maxGames') {
                return maxGames;
            }

            throw new Error(`unexpected config lookup: ${section}.${key}`);
        }
    };

    let sent;
    socket.send = (command, arg) => {
        sent = { command, arg };
    };

    return { socket, sentPayload: () => sent };
};

describe('GameSocket HELLO payload', function () {
    it('announces the configured per-node game cap', function () {
        const { socket, sentPayload } = buildSocket(5);

        socket.onGameSync([]);

        expect(sentPayload().command).toBe('HELLO');
        expect(sentPayload().arg.maxGames).toBe(5);
    });

    it('announces zero while draining, regardless of the configured cap', function () {
        const { socket, sentPayload } = buildSocket(5);
        socket.isDraining = true;

        socket.onGameSync([]);

        expect(sentPayload().arg.maxGames).toBe(0);
    });

    it('leaves the cap undefined rather than silently substituting a number', function () {
        const { socket, sentPayload } = buildSocket(undefined);

        socket.onGameSync([]);

        expect(sentPayload().arg.maxGames).toBeUndefined();
    });
});
