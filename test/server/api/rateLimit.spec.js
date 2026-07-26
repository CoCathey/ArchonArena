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

    it('falls back to IP when unauthenticated', function () {
        const limiter = rateLimit({ name: 't', windowMs: 60000, max: 1 });
        let allowed = 0;
        const run = () => {
            const { req, res } = makeAnonReqRes('9.9.9.9');
            limiter(req, res, () => allowed++);
            return res;
        };

        run();
        const blocked = run();
        expect(allowed).toBe(1);
        expect(blocked.statusCode).toBe(429);
    });

    it('scopes limits per IP when unauthenticated', function () {
        const limiter = rateLimit({ name: 't', windowMs: 60000, max: 1 });
        let allowed = 0;
        const runFor = (ip) => {
            const { req, res } = makeAnonReqRes(ip);
            limiter(req, res, () => allowed++);
            return res;
        };

        runFor('9.9.9.9');
        runFor('8.8.8.8');
        expect(allowed).toBe(2);

        expect(runFor('9.9.9.9').statusCode).toBe(429);
    });

    // Regression: the limiter used to read x-real-ip / x-forwarded-for straight
    // off the request, so a caller could mint a fresh bucket per request just by
    // varying the header and never be limited at all.
    it('cannot be bypassed by spoofing forwarding headers', function () {
        const limiter = rateLimit({ name: 't', windowMs: 60000, max: 1 });
        let allowed = 0;
        const run = (spoof) => {
            const { req, res } = makeAnonReqRes('9.9.9.9', {
                'x-real-ip': spoof,
                'x-forwarded-for': spoof
            });
            limiter(req, res, () => allowed++);
            return res;
        };

        run('1.1.1.1');
        const blocked = run('2.2.2.2');

        expect(allowed).toBe(1);
        expect(blocked.statusCode).toBe(429);
    });
});
