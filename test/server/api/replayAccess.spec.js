const express = require('express');
const http = require('http');

/**
 * ARCHON: replays are your own games only.
 *
 * The endpoint used to hand any recorded game to any signed-in account that
 * knew the game id, and every finished game's id is on both players' public
 * profiles - so in practice every game on the site was readable by every
 * member. Nobody agreed to that when they finished a match.
 *
 * The authorization is a couple of lines, which is exactly why it is worth a
 * test at the route: it is the sort of check that survives until someone
 * refactors the handler and quietly drops it. This drives the real shape of the
 * route over a real socket, and asserts on status codes rather than on the
 * service being called.
 */
describe('replay access', function () {
    let server;
    let baseUrl;
    let currentUser;

    const participants = { 'game-mine': [7], 'game-theirs': [99] };
    const recorded = new Set(['game-mine', 'game-theirs']);

    const gameService = {
        isGameParticipant: async (gameId, userId) => (participants[gameId] || []).includes(userId),
        getReplay: async (gameId) => (recorded.has(gameId) ? { header: { gameId } } : null),
        describeMissingReplay: async () => 'not-recorded'
    };

    beforeAll(async function () {
        const app = express();

        app.use(express.json());

        const jwt = (req, res, next) => {
            req.user = currentUser;
            next();
        };
        const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

        // The route as server/api/games.js declares it.
        app.get(
            '/api/games/:gameId/replay',
            jwt,
            wrap(async (req, res) => {
                const isParticipant = await gameService.isGameParticipant(
                    req.params.gameId,
                    req.user.id
                );
                const isAdmin = !!req.user.permissions?.isAdmin;

                if (!isParticipant && !isAdmin) {
                    return res.status(403).send({
                        success: false,
                        reason: 'not-your-game',
                        message: 'You can only watch replays of your own games.'
                    });
                }

                const replay = await gameService.getReplay(req.params.gameId);

                if (!replay) {
                    const reason = await gameService.describeMissingReplay(req.params.gameId);

                    return res
                        .status(404)
                        .send({ success: false, reason, message: 'Replay not found' });
                }

                res.send({ success: true, replay, canShare: isParticipant });
            })
        );

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async function () {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    const get = async (gameId) => {
        const response = await fetch(`${baseUrl}/api/games/${gameId}/replay`);

        return { status: response.status, body: await response.json() };
    };

    it('gives a player their own replay, and marks it shareable', async function () {
        currentUser = { id: 7, permissions: {} };

        const response = await get('game-mine');

        expect(response.status).toBe(200);
        expect(response.body.replay.header.gameId).toBe('game-mine');
        expect(response.body.canShare).toBe(true);
    });

    // The whole point of the change.
    it('refuses a game the caller was not in', async function () {
        currentUser = { id: 7, permissions: {} };

        const response = await get('game-theirs');

        expect(response.status).toBe(403);
        expect(response.body.reason).toBe('not-your-game');
        // And hands back nothing of the game itself.
        expect(response.body.replay).toBeUndefined();
    });

    // A report about what happened in a game cannot be investigated without
    // seeing the game.
    it('lets an admin read any replay, but not share it', async function () {
        currentUser = { id: 1, permissions: { isAdmin: true } };

        const response = await get('game-theirs');

        expect(response.status).toBe(200);
        expect(response.body.replay).toBeDefined();
        // Sharing stays the players' decision even when an admin is reading.
        expect(response.body.canShare).toBe(false);
    });

    // The block above proves the decisions given this handler shape. This
    // proves the SHIPPED route has that shape: the real module, initialised
    // with a stub service, so a refactor that drops the ownership check fails
    // here rather than in production.
    it('the shipped route enforces this, not just a copy of it', async function () {
        const registered = [];
        const record =
            (method) =>
            (path, ...handlers) =>
                registered.push({ method, path, handlers });

        require('../../../server/api/games.js').init(
            {
                get: record('get'),
                post: record('post'),
                put: record('put'),
                patch: record('patch'),
                delete: record('delete'),
                use: () => {}
            },
            { gameService }
        );

        const route = registered.find(
            (r) => r.method === 'get' && r.path === '/api/games/:gameId/replay'
        );

        expect(route, 'the replay route is not registered').toBeDefined();

        const call = async (gameId, user) => {
            // Last in the chain is the wrapped body; passport is ahead of it,
            // and setting req.user is what it would have done.
            const handler = route.handlers[route.handlers.length - 1];
            const sent = {};

            await handler(
                { params: { gameId }, user },
                {
                    status(code) {
                        sent.status = code;

                        return this;
                    },
                    send(body) {
                        sent.status = sent.status || 200;
                        sent.body = body;

                        return this;
                    }
                },
                (err) => {
                    throw err;
                }
            );

            return sent;
        };

        const theirs = await call('game-theirs', { id: 7, permissions: {} });

        expect(theirs.status).toBe(403);
        expect(theirs.body.reason).toBe('not-your-game');
        expect(theirs.body.replay).toBeUndefined();

        const mine = await call('game-mine', { id: 7, permissions: {} });

        expect(mine.status).toBe(200);
        expect(mine.body.replay).toBeDefined();
    });

    // Ownership is checked before existence, so a stranger cannot use the
    // difference between 403 and 404 to find out which games were recorded.
    it('does not let a stranger probe which games have replays', async function () {
        currentUser = { id: 7, permissions: {} };

        const theirs = await get('game-theirs');
        const theirsUnrecorded = await get('game-unrecorded-theirs');

        expect(theirs.status).toBe(403);
        expect(theirsUnrecorded.status).toBe(403);
        expect(theirs.body.reason).toBe(theirsUnrecorded.body.reason);
    });

    it('explains a missing replay for a game the caller was in', async function () {
        currentUser = { id: 7, permissions: {} };
        participants['game-mine-unrecorded'] = [7];

        const response = await get('game-mine-unrecorded');

        expect(response.status).toBe(404);
        expect(response.body.reason).toBe('not-recorded');
    });
});

/**
 * ARCHON (N12): replay analysis is a premium endpoint AND a private one.
 *
 * Two gates, and both matter. Dropping the capability check gives away what the
 * Archon tier is sold on; dropping the ownership check hands any member a
 * turn-by-turn reading of anyone's game, which is worse than the replay leak
 * this file was written for - the analysis is the replay, summarised.
 *
 * Driven against the shipped module rather than a copy, so a refactor that
 * loses either gate fails here.
 */
describe('replay analysis access', function () {
    const participants = { 'game-mine': [7], 'game-theirs': [99] };
    const analysed = [];

    const gameService = {
        isGameParticipant: async (gameId, userId) => (participants[gameId] || []).includes(userId),
        getReplay: async (gameId) => ({ gameId, snapshots: [] }),
        getReplayByShareToken: async (token) =>
            token === 'good-token' ? { gameId: 'game-shared', snapshots: [] } : null,
        describeMissingReplay: async () => 'not-recorded'
    };

    const replayAnalysis = {
        analyse: (replay) => {
            analysed.push(replay);

            return { available: true, turns: [] };
        }
    };

    const routes = [];

    beforeAll(function () {
        const record =
            (method) =>
            (path, ...handlers) =>
                routes.push({ method, path, handlers });

        require('../../../server/api/games.js').init(
            {
                get: record('get'),
                post: record('post'),
                put: record('put'),
                patch: record('patch'),
                delete: record('delete'),
                use: () => {}
            },
            { gameService, replayAnalysis }
        );
    });

    const routeFor = (path) => routes.find((r) => r.method === 'get' && r.path === path);

    /** Drive a registered route's whole middleware chain, as Express would. */
    const drive = async (path, params, user) => {
        const route = routeFor(path);

        expect(route, `${path} is not registered`).toBeDefined();

        const sent = {};
        const res = {
            status(code) {
                sent.status = code;

                return this;
            },
            send(body) {
                sent.status = sent.status || 200;
                sent.body = body;

                return this;
            }
        };
        const req = { params, user, query: {} };

        // Skip passport, which is always first; run everything after it, in
        // order, stopping as soon as one of them responds.
        for (const handler of route.handlers.slice(1)) {
            let advanced = false;

            await handler(req, res, (err) => {
                if (err) {
                    throw err;
                }

                advanced = true;
            });

            if (!advanced) {
                break;
            }
        }

        return sent;
    };

    const member = { id: 7, permissions: {}, capabilities: ['advanced_replays'], membership: {} };
    const free = { id: 7, permissions: {}, capabilities: [], membership: {} };

    it('analyses a member their own game', async function () {
        const response = await drive(
            '/api/games/:gameId/replay/analysis',
            { gameId: 'game-mine' },
            member
        );

        expect(response.status).toBe(200);
        expect(response.body.analysis.available).toBe(true);
    });

    it('refuses a member a game they were not in', async function () {
        const response = await drive(
            '/api/games/:gameId/replay/analysis',
            { gameId: 'game-theirs' },
            member
        );

        expect(response.status).toBe(403);
        expect(response.body.reason).toBe('not-your-game');
        expect(response.body.analysis).toBeUndefined();
    });

    it('refuses a free account their own game, naming what would unlock it', async function () {
        const response = await drive(
            '/api/games/:gameId/replay/analysis',
            { gameId: 'game-mine' },
            free
        );

        expect(response.status).toBe(403);
        expect(response.body.capability).toBe('advanced_replays');
        expect(response.body.upgradeRequired).toBe(true);
        expect(response.body.analysis).toBeUndefined();
    });

    // The replay behind a share link is public; the analysis of it is not.
    it('analyses a shared replay for a member', async function () {
        const response = await drive(
            '/api/replays/shared/:token/analysis',
            { token: 'good-token' },
            member
        );

        expect(response.status).toBe(200);
        expect(response.body.analysis.available).toBe(true);
    });

    it('refuses a shared replay analysis to a free account', async function () {
        const response = await drive(
            '/api/replays/shared/:token/analysis',
            { token: 'good-token' },
            free
        );

        expect(response.status).toBe(403);
        expect(response.body.capability).toBe('advanced_replays');
    });

    it('404s an unknown share token rather than analysing nothing', async function () {
        const response = await drive(
            '/api/replays/shared/:token/analysis',
            { token: 'no-such-token' },
            member
        );

        expect(response.status).toBe(404);
    });
});
