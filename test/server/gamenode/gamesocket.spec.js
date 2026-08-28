const RedisClientFactory = require('../../../server/services/RedisClientFactory');
const GameSocket = require('../../../server/gamenode/gamesocket');
const ConfigService = require('../../../server/services/ConfigService');

/**
 * ARCHON: the admin "Restart" button used to shell out to `pm2 restart`, and
 * this stack has never run pm2 - the game nodes run under Docker
 * (`restart: unless-stopped`). The click did nothing and said nothing, which
 * is exactly the kind of silent no-op an operator discovers mid-incident.
 *
 * This pins the fix at the boundary that matters: a RESTART command from the
 * lobby must not touch a `pm2` binary, and must tell the rest of the node
 * (via `onRestart`) to start draining instead, the same way SIGTERM does.
 *
 * `createClient` is stubbed so the socket never opens a real connection -
 * there is no redis server in the test environment, and the constructor
 * would otherwise leave an unhandled rejection and an open handle behind.
 */
describe('GameSocket', function () {
    let gameSocket;
    let createClientSpy;

    beforeEach(function () {
        createClientSpy = vi
            .spyOn(RedisClientFactory.prototype, 'createClient')
            .mockImplementation(() => ({
                on: vi.fn(),
                connect: vi.fn().mockResolvedValue(undefined),
                get: vi.fn().mockResolvedValue(null),
                subscribe: vi.fn().mockResolvedValue(undefined),
                publish: vi.fn().mockResolvedValue(undefined)
            }));

        gameSocket = new GameSocket(new ConfigService(), undefined, 'http', 'test');
    });

    afterEach(function () {
        createClientSpy.mockRestore();
    });

    describe('when it receives a RESTART command', function () {
        it('emits onRestart instead of shelling out to pm2', function () {
            const handler = vi.fn();
            gameSocket.on('onRestart', handler);

            gameSocket.onMessage(JSON.stringify({ command: 'RESTART' }), gameSocket.nodeName);

            expect(handler).toHaveBeenCalledTimes(1);
        });

        it('does not change draining state by itself', function () {
            // Draining is HealthServer's job (it calls setDraining once the
            // drain actually starts); the socket only announces the request.
            gameSocket.onMessage(JSON.stringify({ command: 'RESTART' }), gameSocket.nodeName);

            expect(gameSocket.isDraining).toBe(false);
        });
    });
});
