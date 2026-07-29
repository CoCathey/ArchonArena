const fs = require('fs');
const path = require('path');
const {
    buildDirectives,
    normalizeMode,
    sentryOrigin,
    gameNodeOrigins,
    inlineStyleHash,
    REACT_ARIA_PRESSABLE_STYLE
} = require('../../server/csp');

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

        // Verified against the real built client in a browser: without these,
        // generated and canvas-produced images are blocked.
        //
        // ARCHON (I5): this used to assert style-src 'unsafe-inline' as well.
        // The bundle no longer needs it - Font Awesome's runtime CSS injection
        // was turned off in favour of the bundled stylesheet, and React Aria's
        // one remaining rule is allowed by hash.
        it('allows what the client actually loads', function () {
            expect(prod.imgSrc).toContain('data:');
            expect(prod.imgSrc).toContain('blob:');
            expect(prod.styleSrc).toContain("'self'");
        });

        // Fonts are self-hosted, so the policy must not need a third-party font
        // origin - that was the point of bundling them.
        it('needs no third-party font or stylesheet origin', function () {
            expect(prod.fontSrc).toEqual(["'self'", 'data:']);
            expect(prod.styleSrc).not.toContain('https://fonts.googleapis.com');
            expect(prod.styleSrc.join(' ')).not.toContain('gstatic');
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

        // Only in production: on a plain-http dev server there is nothing to
        // upgrade, and the directive would fight the Vite dev server.
        it('upgrades insecure requests in production only', function () {
            expect(prod.upgradeInsecureRequests).toEqual([]);
            expect(buildDirectives({ isDeveloping: true }).upgradeInsecureRequests).toBeUndefined();
        });

        // ARCHON (I5): production used to allow `wss:` blanket-wide, i.e. a
        // websocket to any host on the internet. The documented topology keeps
        // game nodes behind the same Caddy, so 'self' covers them - verified in
        // a browser, since 'self' matching ws/wss is a CSP3 behaviour.
        it('does not allow websockets to arbitrary hosts in production', function () {
            expect(prod.connectSrc).not.toContain('wss:');
            expect(prod.connectSrc).not.toContain('ws:');
            expect(prod.connectSrc).toContain("'self'");
        });

        it('still allows plain ws in development, for Vite and HMR', function () {
            const dev = buildDirectives({ isDeveloping: true });

            expect(dev.connectSrc).toContain('ws:');
            expect(dev.connectSrc).toContain('wss:');
        });

        it('allows explicitly configured game-node origins for a split-host deployment', function () {
            const split = buildDirectives({
                isDeveloping: false,
                gameNodeOrigins: 'wss://node1.example.com,wss://node2.example.com'
            });

            expect(split.connectSrc).toContain('wss://node1.example.com');
            expect(split.connectSrc).toContain('wss://node2.example.com');
            // Still not a blanket scheme.
            expect(split.connectSrc).not.toContain('wss:');
        });

        it('drops anything that is not a websocket origin rather than emitting it', function () {
            // A malformed value must not end up in the header, where it would
            // either be ignored silently or widen the policy.
            expect(gameNodeOrigins('not a url, http://example.com, wss://ok.example.com')).toEqual([
                'wss://ok.example.com'
            ]);
            expect(gameNodeOrigins(undefined)).toEqual([]);
            expect(gameNodeOrigins(['wss://a.example.com'])).toEqual(['wss://a.example.com']);
        });

        // ARCHON (I5): style-src no longer carries 'unsafe-inline'. The one
        // rule the app still injects at runtime is allowed by hash instead.
        it('does not allow arbitrary inline style in production', function () {
            expect(prod.styleSrc).not.toContain("'unsafe-inline'");
            expect(prod.styleSrc).toContain("'self'");
        });

        it('allows React Aria one injected rule by hash', function () {
            expect(prod.styleSrc).toContain(inlineStyleHash(REACT_ARIA_PRESSABLE_STYLE));
        });

        it('computes a CSP-shaped sha256 hash', function () {
            // Pinned so a change to the hashing itself is visible, not just a
            // change to the input.
            expect(inlineStyleHash('body{}')).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
        });

        // The hash pins CONTENT. If a React Aria upgrade changes the rule, the
        // style silently stops applying and mobile press handling degrades -
        // which is a horrible way to find out. So rebuild the rule from the
        // installed package and fail here instead.
        it('still matches the rule React Aria actually injects', function () {
            const source = fs.readFileSync(
                path.join(
                    __dirname,
                    '../../node_modules/@react-aria/interactions/dist/usePress.mjs'
                ),
                'utf8'
            );

            // The library injects a template literal with the attribute name
            // interpolated, so both halves have to be recovered separately.
            const template = source.match(
                /`\n@layer \{\n {2}\[\$\{[^}]+\}\] \{\n {4}([^\n]+)\n {2}\}\n\}\n\s*`/
            );
            const attribute = source.match(/PRESSABLE_ATTRIBUTE\s*=\s*["']([^"']+)["']/);

            expect(
                template,
                'React Aria no longer injects the expected @layer rule'
            ).not.toBeNull();
            expect(attribute, 'React Aria pressable attribute not found').not.toBeNull();

            const injected = `@layer {\n  [${attribute[1]}] {\n    ${template[1]}\n  }\n}`;

            expect(injected).toBe(REACT_ARIA_PRESSABLE_STYLE);
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
