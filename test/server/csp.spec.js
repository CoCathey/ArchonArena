const { buildDirectives, normalizeMode, sentryOrigin } = require('../../server/csp');

describe('Content-Security-Policy', function () {
    describe('buildDirectives', function () {
        const prod = buildDirectives({ isDeveloping: false });

        // The whole point of the policy: an injected <script> or a javascript:
        // URL must not run. Production must never allow inline or eval'd script.
        it('does not allow inline or eval script in production', function () {
            expect(prod.scriptSrc).not.toContain("'unsafe-inline'");
            expect(prod.scriptSrc).not.toContain("'unsafe-eval'");
        });

        it('allows inline and eval script only in development, for Vite/HMR', function () {
            const dev = buildDirectives({ isDeveloping: true });

            expect(dev.scriptSrc).toContain("'unsafe-inline'");
            expect(dev.scriptSrc).toContain("'unsafe-eval'");
        });

        it('locks down the injection-adjacent directives', function () {
            expect(prod.objectSrc).toEqual(["'none'"]);
            expect(prod.baseUri).toEqual(["'self'"]);
            expect(prod.formAction).toEqual(["'self'"]);
            expect(prod.frameAncestors).toEqual(["'self'"]);
            expect(prod.defaultSrc).toEqual(["'self'"]);
        });

        // Verified against the real built client in a browser: without these the
        // stylesheet, the inline styles React emits, and data: images are all
        // blocked and the page renders unstyled.
        it('allows what the client actually loads', function () {
            expect(prod.styleSrc).toContain('https://fonts.googleapis.com');
            expect(prod.styleSrc).toContain("'unsafe-inline'");
            expect(prod.fontSrc).toContain('https://fonts.gstatic.com');
            expect(prod.imgSrc).toContain('data:');
            expect(prod.imgSrc).toContain('blob:');
        });

        it('allows hCaptcha to load, connect and frame', function () {
            for (const directive of [
                prod.scriptSrc,
                prod.styleSrc,
                prod.connectSrc,
                prod.frameSrc
            ]) {
                expect(directive).toContain('https://hcaptcha.com');
                expect(directive).toContain('https://*.hcaptcha.com');
            }
        });

        it('allows secure websockets for gameplay, and plain ws only in development', function () {
            expect(prod.connectSrc).toContain('wss:');
            expect(prod.connectSrc).not.toContain('ws:');
            expect(buildDirectives({ isDeveloping: true }).connectSrc).toContain('ws:');
        });

        it('allows the Sentry ingest origin when a DSN is configured', function () {
            const withSentry = buildDirectives({
                sentryDsn: 'https://abc123@o12345.ingest.sentry.io/6789'
            });

            expect(withSentry.connectSrc).toContain('https://o12345.ingest.sentry.io');
        });

        it('does not break when the DSN is absent or malformed', function () {
            expect(sentryOrigin(undefined)).toEqual([]);
            expect(sentryOrigin('')).toEqual([]);
            expect(sentryOrigin('not a url')).toEqual([]);
            expect(buildDirectives({ sentryDsn: 'nonsense' }).connectSrc).toEqual(
                buildDirectives({}).connectSrc
            );
        });
    });

    describe('normalizeMode', function () {
        it('defaults to enforcing', function () {
            expect(normalizeMode(undefined)).toBe('enforce');
            expect(normalizeMode('')).toBe('enforce');
        });

        it('accepts the documented modes, case-insensitively', function () {
            expect(normalizeMode('off')).toBe('off');
            expect(normalizeMode('report-only')).toBe('report-only');
            expect(normalizeMode('REPORT-ONLY')).toBe('report-only');
            expect(normalizeMode('enforce')).toBe('enforce');
        });

        // A typo must not silently disable the policy.
        it('falls back to enforcing for anything unrecognised', function () {
            expect(normalizeMode('reportonly')).toBe('enforce');
            expect(normalizeMode('disabled')).toBe('enforce');
        });
    });
});
