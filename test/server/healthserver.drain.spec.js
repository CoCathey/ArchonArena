const http = require('http');

const HealthServer = require('../../server/gamenode/healthserver.js');

/**
 * The game node's control port is what makes a zero-downtime deploy possible, so
 * the distinction it encodes has to hold: standing a node down (stop taking new
 * games, keep playing the current ones) is NOT the same operation as shutting it
 * down, and the deploy script depends on the first one not doing the second.
 *
 * If asking a node to stand down also made it exit, Docker's restart policy
 * would bring it straight back on the old image and it would start taking games
 * again before the deploy could replace it.
 */
/**
 * Poll until a condition holds rather than sleeping for a guessed interval.
 * The drain loop is driven by real timers, and a fixed sleep that is generous on
 * an idle machine is not generous when the whole suite is running in parallel -
 * which makes for a test that fails occasionally and tells you nothing when it
 * does.
 */
const waitFor = async (predicate, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (predicate()) {
            return true;
        }

        await new Promise((resolve) => setTimeout(resolve, 5));
    }

    return predicate();
};

const request = (port, method, path) =>
    new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path }, (res) => {
            let body = '';

            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });

        req.on('error', reject);
        req.end();
    });

describe('game node drain control', function () {
    let servers;
    let sigtermBefore;
    let exits;
    let draining;

    const build = (options = {}) => {
        const gameServer = {
            games: options.games || {},
            gameSocket: {
                nodeName: 'node-0',
                version: 'test-build',
                setDraining: (value) => draining.push(value)
            }
        };

        const server = new HealthServer(gameServer, {
            port: 0,
            drainPollMs: 10,
            // `!== undefined`, not `||` - a test passing 0 means zero.
            drainTimeoutMs: options.drainTimeoutMs !== undefined ? options.drainTimeoutMs : 60000,
            exit: (code) => exits.push(code)
        });

        servers.push(server);

        return server;
    };

    const listen = async (server) => {
        server.start();

        await new Promise((resolve) => server.server.once('listening', resolve));

        return server.server.address().port;
    };

    beforeEach(function () {
        servers = [];
        exits = [];
        draining = [];
        sigtermBefore = process.listeners('SIGTERM');
    });

    afterEach(function () {
        for (const server of servers) {
            server.stop();
        }

        // Each HealthServer registers a SIGTERM handler. Drop the ones this test
        // added without touching the runner's own.
        for (const listener of process.listeners('SIGTERM')) {
            if (!sigtermBefore.includes(listener)) {
                process.removeListener('SIGTERM', listener);
            }
        }
    });

    describe('POST /health/drain', function () {
        it('stands the node down without shutting it down', async function () {
            const server = build({ games: { a: {}, b: {} } });
            const port = await listen(server);

            const res = await request(port, 'POST', '/health/drain');

            expect(res.status).toBe(200);
            expect(JSON.parse(res.body)).toMatchObject({
                identity: 'node-0',
                version: 'test-build',
                draining: true,
                shuttingDown: false,
                numGames: 2
            });

            // The whole point: the process is still here, playing its games.
            expect(exits).toEqual([]);
        });

        it('tells the lobby to stop placing games here', async function () {
            const server = build({ games: { a: {} } });
            const port = await listen(server);

            await request(port, 'POST', '/health/drain');

            expect(draining).toEqual([true]);
        });

        /**
         * Readiness gates traffic to this node, and this node's traffic is the
         * socket.io connections of the games it is still playing. Reporting a
         * quiesced node unready is what pulls it out of its Kubernetes Service
         * (probed every 5s, failureThreshold 1, no publishNotReadyAddresses) and
         * disconnects exactly the players the drain exists to protect.
         */
        it('stays ready while standing down, because its games still need it', async function () {
            const server = build({ games: { a: {} } });
            const port = await listen(server);

            expect((await request(port, 'GET', '/health/ready')).status).toBe(200);

            await request(port, 'POST', '/health/drain');

            expect((await request(port, 'GET', '/health/ready')).status).toBe(200);
        });

        it('reports not-ready once it is actually shutting down', async function () {
            const server = build({ games: { a: {} } });
            const port = await listen(server);

            server.startDraining();

            const res = await request(port, 'GET', '/health/ready');

            expect(res.status).toBe(503);
            expect(JSON.parse(res.body)).toMatchObject({ ready: false, draining: true });
        });

        it('is idempotent', async function () {
            const server = build({ games: { a: {} } });
            const port = await listen(server);

            await request(port, 'POST', '/health/drain');
            await request(port, 'POST', '/health/drain');

            expect(draining).toEqual([true]);
        });

        // A GET route that stands a node down is one crawler or misconfigured
        // uptime check away from taking games off a live server.
        it('refuses GET', async function () {
            const server = build();
            const port = await listen(server);

            const res = await request(port, 'GET', '/health/drain');

            expect(res.status).toBe(405);
            expect(server.isDraining).toBe(false);
        });
    });

    describe('POST /health/resume', function () {
        it('takes a stood-down node back into service', async function () {
            const server = build({ games: { a: {} } });
            const port = await listen(server);

            await request(port, 'POST', '/health/drain');
            const res = await request(port, 'POST', '/health/resume');

            expect(JSON.parse(res.body).draining).toBe(false);
            expect(draining).toEqual([true, false]);
        });

        it('refuses to revive a node that is shutting down', async function () {
            const server = build({ games: { a: {} } });
            const port = await listen(server);

            server.startDraining();

            const res = await request(port, 'POST', '/health/resume');

            expect(JSON.parse(res.body)).toMatchObject({ draining: true, shuttingDown: true });
        });
    });

    /**
     * The control routes are not passive reads: quiesce() publishes a HELLO,
     * which summarises every game on the node and hands it to Redis. An
     * exception escaping the request handler would be an uncaughtException and
     * would kill a process holding live games - from the endpoint whose entire
     * purpose is to protect them.
     */
    describe('when publishing the drain state fails', function () {
        it('answers 500 instead of taking the node down', async function () {
            const server = build({ games: { a: {} } });

            server.gameServer.gameSocket.setDraining = () => {
                throw new Error('redis is gone');
            };

            const port = await listen(server);
            const res = await request(port, 'POST', '/health/drain');

            expect(res.status).toBe(500);

            // Still serving: the games on this node are unaffected.
            expect((await request(port, 'GET', '/health/games')).body).toBe('1');
        });
    });

    describe('shutdown drain', function () {
        it('exits immediately when there is nothing to wait for', function () {
            const server = build({ games: {} });

            server.startDraining();

            expect(exits).toEqual([0]);
        });

        // `||` would read a zero timeout as "unset" and wait 90 minutes, which
        // is the opposite of what a caller passing 0 asked for.
        it('honours a zero drain timeout', async function () {
            const server = build({ games: { a: {} }, drainTimeoutMs: 0 });

            server.startDraining();

            await waitFor(() => exits.length > 0);

            expect(exits).toEqual([1]);
        });

        it('waits for games in progress, then exits', async function () {
            const games = { a: {} };
            const server = build({ games });

            server.startDraining();
            expect(exits).toEqual([]);

            delete games.a;

            await waitFor(() => exits.length > 0);

            expect(exits).toEqual([0]);
        });

        it('gives up after the drain timeout', async function () {
            const server = build({ games: { a: {} }, drainTimeoutMs: 20 });

            server.startDraining();

            await waitFor(() => exits.length > 0);

            expect(exits).toEqual([1]);
        });

        // The counterpart to the three above: a node with a game and a long
        // timeout must NOT exit. Without this, an implementation that exited the
        // moment it was asked to drain would still satisfy every other test here.
        it('does not exit while a game is still being played', async function () {
            const server = build({ games: { a: {} }, drainTimeoutMs: 60000 });

            server.startDraining();

            await waitFor(() => exits.length > 0, 60);

            expect(exits).toEqual([]);
        });
    });
});
