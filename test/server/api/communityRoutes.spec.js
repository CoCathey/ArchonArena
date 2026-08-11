const express = require('express');
const http = require('http');

/**
 * ARCHON: route shadowing in the community API.
 *
 * Express matches in registration order, so `/api/clubs/:id` declared before
 * `/api/clubs/invitations` swallows it - the literal path arrives at the detail
 * handler as the id "invitations", which parses to NaN and 404s a route that
 * exists. It is invisible in review because both registrations are correct on
 * their own, and it is invisible in a unit test of the service because the
 * service is never reached.
 *
 * So this drives the real router over a real socket and asks what actually
 * answers.
 */
describe('community club routes', function () {
    let server;
    let baseUrl;
    const calls = [];

    // Stand-ins for the two things a route needs before it can be dispatched:
    // an authenticated user, and a service to call.
    const clubService = {
        invitations: async (userId) => {
            calls.push(['invitations', userId]);

            return [{ id: 4, name: 'Austin Archons' }];
        },
        getDetail: async (clubId) => {
            calls.push(['getDetail', clubId]);

            return { success: true, club: { id: clubId } };
        },
        invite: async (clubId, actor, username) => {
            calls.push(['invite', clubId, username]);

            return { success: true, username };
        },
        respondToInvitation: async (clubId, userId, accept) => {
            calls.push(['respondToInvitation', clubId, accept]);

            return { success: true };
        }
    };

    beforeAll(async function () {
        const app = express();

        app.use(express.json());
        // Register the routes exactly as server/api/community.js does, in the
        // same order, against the stub service. Importing the module itself
        // would drag in the database, passport and the notification service;
        // what is under test is the ordering, so that is what is reproduced.
        const jwt = (req, res, next) => {
            req.user = { id: 9, permissions: {} };
            next();
        };
        const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

        app.get(
            '/api/clubs/invitations',
            jwt,
            wrap(async (req, res) => {
                res.send({
                    success: true,
                    invitations: await clubService.invitations(req.user.id)
                });
            })
        );
        app.get(
            '/api/clubs/:id',
            jwt,
            wrap(async (req, res) => {
                res.send(await clubService.getDetail(parseInt(req.params.id, 10), req.user.id));
            })
        );
        app.post(
            '/api/clubs/:id/invite',
            jwt,
            wrap(async (req, res) => {
                res.send(
                    await clubService.invite(
                        parseInt(req.params.id, 10),
                        req.user,
                        req.body.username
                    )
                );
            })
        );
        app.post(
            '/api/clubs/:id/invitation',
            jwt,
            wrap(async (req, res) => {
                res.send(
                    await clubService.respondToInvitation(
                        parseInt(req.params.id, 10),
                        req.user.id,
                        !!req.body.accept
                    )
                );
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

    beforeEach(() => calls.splice(0));

    const request = async (method, path, body) => {
        const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined
        });

        return { status: response.status, body: await response.json() };
    };

    it('serves /api/clubs/invitations instead of treating it as a club id', async function () {
        const response = await request('GET', '/api/clubs/invitations');

        expect(response.status).toBe(200);
        expect(response.body.invitations).toHaveLength(1);
        // The failure mode this exists for: getDetail(NaN).
        expect(calls).toEqual([['invitations', 9]]);
    });

    it('still routes a numeric club id to the detail handler', async function () {
        const response = await request('GET', '/api/clubs/42');

        expect(response.status).toBe(200);
        expect(calls).toEqual([['getDetail', 42]]);
    });

    it('routes invite and invitation responses to their own handlers', async function () {
        await request('POST', '/api/clubs/42/invite', { username: 'sam' });
        expect(calls).toEqual([['invite', 42, 'sam']]);

        calls.splice(0);
        await request('POST', '/api/clubs/42/invitation', { accept: true });
        expect(calls).toEqual([['respondToInvitation', 42, true]]);

        calls.splice(0);
        await request('POST', '/api/clubs/42/invitation', { accept: false });
        expect(calls).toEqual([['respondToInvitation', 42, false]]);
    });

    // Everything above proves how Express behaves given an ordering. This
    // proves the real module produces that ordering, by handing it a server
    // that records what it is asked to register. `init` only ever calls the
    // verb methods, so nothing here needs a database.
    it('registers the real routes so no literal club path is shadowed', function () {
        const registered = [];
        const record =
            (method) =>
            (path, ...rest) =>
                registered.push({ method, path, handlers: rest.length });
        const fakeServer = {
            get: record('get'),
            post: record('post'),
            put: record('put'),
            patch: record('patch'),
            delete: record('delete'),
            use: () => {}
        };

        require('../../../server/api/community.js').init(fakeServer);

        const paths = registered.filter((r) => r.method === 'get').map((r) => r.path);
        const literal = paths.indexOf('/api/clubs/invitations');
        const parameterised = paths.indexOf('/api/clubs/:id');

        expect(literal).toBeGreaterThan(-1);
        expect(parameterised).toBeGreaterThan(-1);
        expect(literal).toBeLessThan(parameterised);

        // Generalised: any literal segment where a `:id` pattern could match
        // first has the same problem, so check them all rather than the one
        // that happened to bite.
        const patternIndex = paths.findIndex((p) => /^\/api\/clubs\/:id$/.test(p));

        for (const [index, path] of paths.entries()) {
            const match = /^\/api\/clubs\/([A-Za-z-]+)$/.exec(path);

            if (match && patternIndex > -1) {
                expect(
                    index,
                    `GET ${path} is registered after /api/clubs/:id and will never be reached`
                ).toBeLessThan(patternIndex);
            }
        }

        // The invitation mutations are registered too, and are POSTs so they
        // cannot collide with the GET detail route.
        const posts = registered.filter((r) => r.method === 'post').map((r) => r.path);

        expect(posts).toContain('/api/clubs/:id/invite');
        expect(posts).toContain('/api/clubs/:id/invitation');
    });
});
