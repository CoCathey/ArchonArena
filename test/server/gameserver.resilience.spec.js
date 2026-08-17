const GameServer = require('../../server/gamenode/gameserver.js');

/**
 * ARCHON: the node holds every live game in memory and nowhere else.
 *
 * So the failure that matters most here is not a game that breaks - errors
 * inside a game are contained per-game by `runAndCatchErrors` - but a throw
 * that escapes into a timer or a socket callback, where Node's answer is to
 * kill the process. That takes every OTHER game on the node with it: their
 * players are disconnected mid-game, their boards freeze, and there is
 * nothing left to reconnect to, because the games only ever existed here.
 *
 * These specs pin the containment: one impossible game does not evict
 * anybody else.
 */
const buildServer = (games = {}) => {
    const server = Object.create(GameServer.prototype);

    server.games = games;
    server.sent = [];
    server.gameSocket = { send: (command, arg) => server.sent.push({ command, arg }) };
    server.sendGameState = () => {};
    server.clearSpectatorDelay = () => {};
    server.handleError = () => {};

    return server;
};

const healthyGame = (id, calls) => ({
    id,
    finishedAt: undefined,
    isEmpty: () => false,
    checkInactivity: () => {
        calls.push(`inactivity:${id}`);

        return false;
    },
    checkAbandonment: () => {
        calls.push(`abandonment:${id}`);

        return false;
    },
    continue: () => {},
    getPlayersAndSpectators: () => ({})
});

describe('the game node survives one bad game', function () {
    it('keeps sweeping when a game throws on the inactivity check', function () {
        const calls = [];
        const poison = healthyGame('poison', calls);

        poison.checkInactivity = () => {
            throw new Error('this game is having a bad day');
        };

        const server = buildServer({ poison, healthy: healthyGame('healthy', calls) });

        expect(() => server.clearStaleAndFinishedGames()).not.toThrow();
        // The healthy game was still swept - it is not collateral.
        expect(calls).toContain('inactivity:healthy');
        expect(calls).toContain('abandonment:healthy');
    });

    it('keeps sweeping when a game throws on the empty check', function () {
        const calls = [];
        const poison = healthyGame('poison', calls);

        poison.isEmpty = () => {
            throw new Error('cannot tell');
        };

        const server = buildServer({ poison, healthy: healthyGame('healthy', calls) });

        expect(() => server.clearStaleAndFinishedGames()).not.toThrow();
        expect(calls).toContain('inactivity:healthy');
        // And a game it could not read is left alone rather than closed.
        expect(server.sent).toEqual([]);
    });

    it('refuses one connection rather than the whole node when seating throws', function () {
        const server = buildServer();
        let disconnected = false;

        server.seatConnection = () => {
            throw new Error('no game for this socket');
        };

        const socket = {
            request: { user: { username: 'Ana' } },
            disconnect: () => {
                disconnected = true;
            }
        };

        expect(() => server.onConnection(socket)).not.toThrow();
        expect(disconnected).toBe(true);
    });

    it('installs the last-resort guards once, however many servers are built', function () {
        const before = process.listenerCount('uncaughtException');

        buildServer().installCrashGuards();
        buildServer().installCrashGuards();

        // At most one pair, and never a listener leak per game server.
        expect(process.listenerCount('uncaughtException')).toBeLessThanOrEqual(before + 1);
        expect(process.listenerCount('unhandledRejection')).toBeLessThanOrEqual(before + 1);
    });
});
