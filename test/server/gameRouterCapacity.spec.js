const GameRouter = require('../../server/gamerouter.js');

// Object.create rather than `new`: the constructor connects to Redis.
const routerWith = (workers) => {
    const router = Object.create(GameRouter.prototype);

    router.workers = workers;

    return router;
};

const worker = (identity, fields = {}) => ({
    identity,
    numGames: 0,
    ...fields
});

describe('game node placement', function () {
    describe('capacity', function () {
        /**
         * The node advertises its cap in HELLO, and for the whole life of this
         * code it advertised `undefined`: it read `config.maxGames` while the
         * config file documents - and every deployment sets - `gameNode.maxGames`.
         *
         * `numGames >= undefined` is false for any number, so the cap silently did
         * not exist. That is still the effective behaviour when no cap is set, but
         * now it is the answer to "is a cap configured?" rather than a comparison
         * that happens to be false. Without this distinction, fixing the config
         * key would have been the whole fix - and a node whose HELLO omits
         * maxGames would have started refusing every game.
         */
        it('treats an unset cap as unlimited', function () {
            const router = routerWith({
                'node-0': worker('node-0', { numGames: 500 })
            });

            expect(router.isWorkerFull(router.workers['node-0'])).toBe(false);
            expect(router.getNextAvailableGameNode().identity).toBe('node-0');
        });

        it('enforces a configured cap', function () {
            const router = routerWith({
                'node-0': worker('node-0', { numGames: 40, maxGames: 40 })
            });

            expect(router.isWorkerFull(router.workers['node-0'])).toBe(true);
            expect(router.getNextAvailableGameNode()).toBeUndefined();
        });

        // How a draining node tells the lobby to place nothing on it. Zero is
        // finite, so it must be honoured rather than read as "no cap".
        it('places nothing on a node advertising a zero cap', function () {
            const router = routerWith({
                'node-0': worker('node-0', { numGames: 0, maxGames: 0 })
            });

            expect(router.isWorkerFull(router.workers['node-0'])).toBe(true);
        });

        it('fills the least loaded node that has room', function () {
            const router = routerWith({
                'node-0': worker('node-0', { numGames: 3, maxGames: 10 }),
                'node-1': worker('node-1', { numGames: 1, maxGames: 10 }),
                'node-2': worker('node-2', { numGames: 0, maxGames: 0 })
            });

            expect(router.getNextAvailableGameNode().identity).toBe('node-1');
        });
    });

    describe('rolling deploys', function () {
        // The whole basis of a zero-downtime deploy: a node being replaced takes
        // no new games while its sibling does.
        it('skips a draining node and uses its sibling', function () {
            const router = routerWith({
                'node-0': worker('node-0', { numGames: 0, draining: true }),
                'node-1': worker('node-1', { numGames: 5 })
            });

            expect(router.getNextAvailableGameNode().identity).toBe('node-1');
        });

        it('skips disabled and disconnected nodes', function () {
            const router = routerWith({
                'node-0': worker('node-0', { disabled: true }),
                'node-1': worker('node-1', { disconnected: true }),
                'node-2': worker('node-2', { numGames: 9 })
            });

            expect(router.getNextAvailableGameNode().identity).toBe('node-2');
        });

        it('has nowhere to put a game when every node is standing down', function () {
            const router = routerWith({
                'node-0': worker('node-0', { draining: true }),
                'node-1': worker('node-1', { draining: true })
            });

            expect(router.getNextAvailableGameNode()).toBeUndefined();
        });
    });

    describe('status reporting', function () {
        it('reports the flag the admin toggle actually flips', function () {
            const router = routerWith({
                'node-0': worker('node-0', { draining: true, version: 'v2' })
            });

            const [status] = router.getNodeStatus();

            // A draining node is not a disabled one. Labelling the toggle from
            // `status` offered "Enable" here, which described neither the state
            // nor what the click would do.
            expect(status).toMatchObject({
                name: 'node-0',
                status: 'draining',
                draining: true,
                disabled: false,
                version: 'v2'
            });
        });

        it('reports the cap, or null when there is none', function () {
            const router = routerWith({
                'node-0': worker('node-0', { maxGames: 40 }),
                'node-1': worker('node-1')
            });

            const [capped, uncapped] = router.getNodeStatus();

            expect(capped.maxGames).toBe(40);
            expect(uncapped.maxGames).toBeNull();
        });

        it('ranks disconnected above disabled above draining', function () {
            const router = routerWith({
                'node-0': worker('node-0', { disconnected: true, disabled: true }),
                'node-1': worker('node-1', { disabled: true, draining: true }),
                'node-2': worker('node-2')
            });

            expect(router.getNodeStatus().map((node) => node.status)).toEqual([
                'disconnected',
                'disabled',
                'active'
            ]);
        });
    });
});
