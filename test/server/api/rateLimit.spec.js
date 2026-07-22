const { rateLimit, _reset } = require('../../../server/api/rateLimit');

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

    it('allows up to max requests then blocks with 429', function () {
        const limiter = rateLimit({ name: 't', windowMs: 60000, max: 3 });
        let allowed = 0;
        const run = () => {
            const { req, res } = makeReqRes(1);
            limiter(req, res, () => allowed++);
            return res;
        };

        run();
        run();
        run();
        expect(allowed).toBe(3);

        const blocked = run();
        expect(allowed).toBe(3);
        expect(blocked.statusCode).toBe(429);
        expect(blocked.body.success).toBe(false);
        expect(blocked.headers['Retry-After']).toBeDefined();
    });

    it('scopes limits per user', function () {
        const limiter = rateLimit({ name: 't', windowMs: 60000, max: 1 });
        let allowed = 0;

        const runFor = (id) => {
            const { req, res } = makeReqRes(id);
            limiter(req, res, () => allowed++);
            return res;
        };

        runFor(1);
        runFor(2);
        expect(allowed).toBe(2); // different users each get their own budget

        const blocked = runFor(1);
        expect(blocked.statusCode).toBe(429);
    });

    it('falls back to IP when unauthenticated', function () {
        const limiter = rateLimit({ name: 't', windowMs: 60000, max: 1 });
        let allowed = 0;
        const run = () => {
            const req = { get: () => '9.9.9.9', headers: {} };
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
            limiter(req, res, () => allowed++);
            return res;
        };

        run();
        const blocked = run();
        expect(allowed).toBe(1);
        expect(blocked.statusCode).toBe(429);
    });
});
