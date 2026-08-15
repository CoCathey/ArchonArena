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
            drainTimeoutMs: options.drainTimeoutMs || 60000,
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

        it('reports not-ready while standing down', async function () {
            const server = build({ games: { a: {} } });
            const port = await listen(server);

            expect((await request(port, 'GET', '/health/ready')).status).toBe(200);

            await request(port, 'POST', '/health/drain');

            expect((await request(port, 'GET', '/health/ready')).status).toBe(503);
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

    describe('shutdown drain', function () {
        it('exits immediately when there is nothing to wait for', function () {
            const server = build({ games: {} });

            server.startDraining();

            expect(exits).toEqual([0]);
        });

        it('waits for games in progress, then exits', async function () {
            const games = { a: {} };
            const server = build({ games });

            server.startDraining();
            expect(exits).toEqual([]);

            delete games.a;

            await new Promise((resolve) => setTimeout(resolve, 40));

            expect(exits).toEqual([0]);
        });

        it('gives up after the drain timeout', async function () {
            const server = build({ games: { a: {} }, drainTimeoutMs: 20 });

            server.startDraining();

            await new Promise((resolve) => setTimeout(resolve, 60));

            expect(exits).toEqual([1]);
        });
    });
});
