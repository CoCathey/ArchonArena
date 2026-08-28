const GameServer = require('../../../server/gamenode/gameserver.js');

/**
 * ARCHON: pairs with gamesocket.spec.js. The socket only announces that a
 * RESTART command arrived (`onRestart`); it's the node's job to act on it by
 * starting the same graceful drain HealthServer already runs for SIGTERM, so
 * the container's own restart policy brings it back once games finish.
 */
const buildServer = (healthServer) => {
    const server = Object.create(GameServer.prototype);

    server.healthServer = healthServer;

    return server;
};

describe('GameServer.onRestart', function () {
    it('starts draining on the health server', function () {
        const startDraining = vi.fn();
        const server = buildServer({ startDraining });

        server.onRestart();

        expect(startDraining).toHaveBeenCalledTimes(1);
    });

    it('does nothing if the health server has not been created yet', function () {
        const server = buildServer(undefined);

        expect(() => server.onRestart()).not.toThrow();
    });
});
