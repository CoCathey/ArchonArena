const { rateLimit, createFailureThrottle, _reset } = require('../../../server/api/rateLimit');
const { MemoryStore, RedisStore } = require('../../../server/api/rateLimitStore');

function makeReqRes(userId) {
    const req = { user: userId ? { id: userId } : undefined, get: () => undefined, headers: {} };
    const res = {
        statusCode: 200,
        body: undefined,
        headers: {},
        set(k, v) {
            this.headers[k] = v;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        send(payload) {
            this.body = payload;
            return this;
        }
    };
    return { req, res };
}

describe('rateLimit middleware', function () {
    beforeEach(() => _reset());

    it('allows up to max requests then blocks with 429', async function () {
        const limiter = rateLimit({ name: 't', windowMs: 60000, max: 3 });
        let allowed = 0;
        const run = async () => {
            const { req, res } = makeReqRes(1);
            await limiter(req, res, () => allowed++);
            return res;
        };

        await run();
        await run();
        await run();
        expect(allowed).toBe(3);

        const blocked = await run();
        expect(allowed).toBe(3);
        expect(blocked.statusCode).toBe(429);
        expect(blocked.body.success).toBe(false);
        expect(blocked.headers['Retry-After']).toBeDefined();
    });

    it('scopes limits per user', async function () {
        const limiter = rateLimit({ name: 't', windowMs: 60000, max: 1 });
        let allowed = 0;

        const runFor = async (id) => {
            const { req, res } = makeReqRes(id);
            await limiter(req, res, () => allowed++);
            return res;
        };

        await runFor(1);
        await runFor(2);
        expect(allowed).toBe(2); // different users each get their own budget

        const blocked = await runFor(1);
        expect(blocked.statusCode).toBe(429);
    });

    // Anonymous callers are keyed on req.ip, which Express derives from the
    // `trust proxy` setting rather than from raw request headers.
    const makeAnonReqRes = (ip, headers = {}) => {
        const req = { ip, headers, get: (name) => headers[String(name).toLowerCase()] };
        const res = {
            statusCode: 200,
            set() {},
            status(c) {
                this.statusCode = c;
                return this;
            },
            send() {
                return this;
            }
        };
        return { req, res };
    };

    it('falls back to IP when unauthenticated', async function () {
        const limiter = rateLimit({ name: 't', windowMs: 60000, max: 1 });
        let allowed = 0;
        const run = async () => {
            const { req, res } = makeAnonReqRes('9.9.9.9');
            await limiter(req, res, () => allowed++);
            return res;
        };

        await run();
        const blocked = await run();
        expect(allowed).toBe(1);
        expect(blocked.statusCode).toBe(429);
    });

    it('scopes limits per IP when unauthenticated', async function () {
        const limiter = rateLimit({ name: 't', windowMs: 60000, max: 1 });
        let allowed = 0;
        const runFor = async (ip) => {
            const { req, res } = makeAnonReqRes(ip);
            await limiter(req, res, () => allowed++);
            return res;
        };

        await runFor('9.9.9.9');
        await runFor('8.8.8.8');
        expect(allowed).toBe(2);

        expect((await runFor('9.9.9.9')).statusCode).toBe(429);
    });

    // Regression: the limiter used to read x-real-ip / x-forwarded-for straight
    // off the request, so a caller could mint a fresh bucket per request just by
    // varying the header and never be limited at all.
    it('cannot be bypassed by spoofing forwarding headers', async function () {
        const limiter = rateLimit({ name: 't', windowMs: 60000, max: 1 });
        let allowed = 0;
        const run = async (spoof) => {
            const { req, res } = makeAnonReqRes('9.9.9.9', {
                'x-real-ip': spoof,
                'x-forwarded-for': spoof
            });
            await limiter(req, res, () => allowed++);
            return res;
        };

        await run('1.1.1.1');
        const blocked = await run('2.2.2.2');

        expect(allowed).toBe(1);
        expect(blocked.statusCode).toBe(429);
    });
});

describe('createFailureThrottle', function () {
    const options = { windowMs: 60000, max: 3, blockMs: 30000 };

    beforeEach(() => _reset());

    it('does not block before the failure limit is reached', async function () {
        const throttle = createFailureThrottle(options);

        await throttle.recordFailure('ip:1.1.1.1');
        await throttle.recordFailure('ip:1.1.1.1');

        expect(await throttle.blockedFor('ip:1.1.1.1')).toBe(0);
    });

    it('blocks once the failure limit is reached, and reports Retry-After seconds', async function () {
        const throttle = createFailureThrottle(options);
        const now = 1000000;

        for (let i = 0; i < 3; i++) {
            await throttle.recordFailure('ip:1.1.1.1', now);
        }

        expect(await throttle.blockedFor('ip:1.1.1.1', now)).toBe(30);
        // Lockout expires on its own.
        expect(await throttle.blockedFor('ip:1.1.1.1', now + 30001)).toBe(0);
    });

    it('keeps keys independent so one account cannot lock out another', async function () {
        const throttle = createFailureThrottle(options);

        for (let i = 0; i < 3; i++) {
            await throttle.recordFailure('user:victim');
        }

        expect(await throttle.blockedFor('user:victim')).toBeGreaterThan(0);
        expect(await throttle.blockedFor('user:someone-else')).toBe(0);
    });

    // A successful login must wipe the slate: a legitimate user who mistypes
    // their password a few times should never be locked out afterwards.
    it('reset clears accumulated failures', async function () {
        const throttle = createFailureThrottle(options);

        await throttle.recordFailure('ip:1.1.1.1');
        await throttle.recordFailure('ip:1.1.1.1');
        await throttle.reset('ip:1.1.1.1');
        await throttle.recordFailure('ip:1.1.1.1');

        expect(await throttle.blockedFor('ip:1.1.1.1')).toBe(0);
    });

    it('forgets failures that fall outside the window', async function () {
        const throttle = createFailureThrottle(options);
        const now = 1000000;

        await throttle.recordFailure('ip:1.1.1.1', now);
        await throttle.recordFailure('ip:1.1.1.1', now);
        // Third failure arrives after the first two have aged out.
        await throttle.recordFailure('ip:1.1.1.1', now + 60001);

        expect(await throttle.blockedFor('ip:1.1.1.1', now + 60001)).toBe(0);
    });
});

describe('RedisStore', function () {
    // A minimal stand-in for node-redis that runs the same call sequence the
    // real client would. The Lua scripts themselves are exercised against a
    // real Redis in the runtime verification (see the commit message); these
    // cases pin the behaviour around them.
    const fakeClient = (evalResult) => ({
        eval: vi.fn().mockResolvedValue(evalResult),
        pTTL: vi.fn().mockResolvedValue(-2),
        del: vi.fn().mockResolvedValue(1)
    });

    it('namespaces keys with the site prefix', async function () {
        const client = fakeClient([0, 0]);
        const store = new RedisStore(client, { prefix: 'archonarena:prod:' });

        await store.hit('login:ip:1.1.1.1', 60000, 5, 1000);

        expect(client.eval.mock.calls[0][1].keys).toEqual([
            'archonarena:prod:ratelimit:login:ip:1.1.1.1'
        ]);
    });

    it('reports Retry-After from the oldest event in the window', async function () {
        const now = 1000000;
        // Oldest hit was 10s ago in a 60s window -> 50s until it ages out.
        const store = new RedisStore(fakeClient([1, now - 10000]));

        const result = await store.hit('k', 60000, 5, now);

        expect(result.limited).toBe(true);
        expect(result.retryAfterSec).toBe(50);
    });

    it('keeps failure counts and lockouts in separate keys', async function () {
        const client = fakeClient(0);
        const store = new RedisStore(client, { prefix: 'p:' });

        await store.recordFailure('ip:1.1.1.1', 60000, 3, 30000, 1000);

        expect(client.eval.mock.calls[0][1].keys).toEqual([
            'p:ratelimit:fail:ip:1.1.1.1',
            'p:ratelimit:block:ip:1.1.1.1'
        ]);
    });

    it('reads a lockout from the block key TTL', async function () {
        const client = fakeClient(0);
        client.pTTL.mockResolvedValue(29500);
        const store = new RedisStore(client);

        expect(await store.blockedFor('ip:1.1.1.1', 1000)).toBe(30);

        // -2 is node-redis for "no such key" - not locked out.
        client.pTTL.mockResolvedValue(-2);
        expect(await store.blockedFor('ip:1.1.1.1', 1000)).toBe(0);
    });

    // The load-bearing property of the whole change: a Redis outage must
    // degrade to per-process limits, never to no limits and never to a 500 on
    // the login endpoint.
    describe('when Redis is unavailable', function () {
        it('still enforces a limit, using the in-process fallback', async function () {
            const client = fakeClient([0, 0]);
            client.eval.mockRejectedValue(new Error('connection refused'));
            const store = new RedisStore(client, { fallback: new MemoryStore() });

            expect((await store.hit('k', 60000, 2, 1000)).limited).toBe(false);
            expect((await store.hit('k', 60000, 2, 1001)).limited).toBe(false);
            // Third request is over the limit even though Redis never answered.
            expect((await store.hit('k', 60000, 2, 1002)).limited).toBe(true);
        });

        it('still locks an account out after repeated failures', async function () {
            const client = fakeClient(0);
            client.eval.mockRejectedValue(new Error('connection refused'));
            client.pTTL.mockRejectedValue(new Error('connection refused'));
            const store = new RedisStore(client, { fallback: new MemoryStore() });

            for (let i = 0; i < 3; i++) {
                await store.recordFailure('user:victim', 60000, 3, 30000, 1000);
            }

            expect(await store.blockedFor('user:victim', 1000)).toBe(30);
        });

        it('never throws, so a cache blip cannot 500 a login', async function () {
            const client = fakeClient(0);
            client.eval.mockRejectedValue(new Error('down'));
            client.pTTL.mockRejectedValue(new Error('down'));
            client.del.mockRejectedValue(new Error('down'));
            const store = new RedisStore(client);

            await expect(store.hit('k', 60000, 5, 1000)).resolves.toBeDefined();
            await expect(store.blockedFor('k', 1000)).resolves.toBe(0);
            await expect(store.resetKey('k')).resolves.toBeUndefined();
        });
    });
});

describe('MemoryStore', function () {
    it('does not let a request bucket and a throttle key collide', async function () {
        // Both are keyed on caller-chosen strings; if they shared a namespace,
        // failed logins would eat into an unrelated request budget.
        const store = new MemoryStore();

        store.recordFailure('shared', 60000, 3, 30000, 1000);
        store.recordFailure('shared', 60000, 3, 30000, 1000);

        expect(store.hit('shared', 60000, 1, 1000).limited).toBe(false);
    });
});
