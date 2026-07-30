/**
 * ARCHON: Content-Security-Policy for the site.
 *
 * The policy is built here rather than inline in server.js so the directive set
 * is unit-testable and so the reasoning for each allowance stays next to it.
 *
 * The value that matters most is `script-src` without 'unsafe-inline' or
 * 'unsafe-eval' in production: the built client is all external module scripts,
 * so an injected <script> or a javascript: URL simply will not execute. Every
 * other directive below is either 'self' or the minimum a third party needs.
 *
 * Deliberate exceptions, and why:
 *
 *  - Development adds 'unsafe-inline'/'unsafe-eval' to script-src, and ws:,
 *    because Vite's dev server and HMR require them. Production never gets them.
 *
 * ARCHON (I5): style-src no longer carries 'unsafe-inline', and connect-src no
 * longer carries a blanket `wss:`. Both were removed against the real built
 * bundle in Chromium rather than by reasoning about what the app might do —
 * see the notes on REACT_ARIA_PRESSABLE_STYLE and gameNodeOrigins below.
 */

const crypto = require('crypto');

const HCAPTCHA = ['https://hcaptcha.com', 'https://*.hcaptcha.com'];

/**
 * The one inline stylesheet the app still injects at runtime.
 *
 * @react-aria/interactions' `usePress` prepends this 88-byte rule to <head> on
 * first use. It offers no nonce hook and no way to opt out, so the choice is
 * between keeping 'unsafe-inline' for the whole site or allowing exactly this
 * one block by hash. (Font Awesome used to inject ~15 KB the same way; that one
 * had a supported fix and is now bundled — see client/index.jsx.)
 *
 * A hash pins the *content*, so if a React Aria upgrade changes the rule the
 * style silently stops applying and mobile press handling degrades. That would
 * be a nasty way to find out, so `csp.spec.js` asserts this text still matches
 * the rule in the installed package: the upgrade fails CI instead.
 *
 * Note that a hash in style-src also makes browsers ignore 'unsafe-inline'
 * entirely, which is precisely the point.
 */
const REACT_ARIA_PRESSABLE_STYLE = `@layer {
  [data-react-aria-pressable] {
    touch-action: pan-x pan-y pinch-zoom;
  }
}`;

const inlineStyleHash = (css) =>
    `'sha256-${crypto.createHash('sha256').update(css, 'utf8').digest('base64')}'`;

/**
 * Extra websocket origins for a deployment that runs game nodes on their own
 * hosts.
 *
 * The documented topology (docs/DEPLOYMENT.md §6) keeps every node behind the
 * same Caddy, so gameplay websockets are same-origin and `'self'` covers them —
 * verified in a browser, since `'self'` matching ws/wss on the same host is a
 * CSP3 behaviour rather than something to assume. `wss:` used to be allowed
 * blanket-wide to cover a split-host setup nobody runs; this makes that case
 * opt-in instead, so the default policy does not permit a websocket to any host
 * on the internet.
 *
 * Accepts an array or a comma-separated string (so it can come from an
 * environment variable). Anything unparseable is dropped rather than emitted
 * into the header.
 *
 * @param {string[]|string} [origins]
 * @returns {string[]}
 */
function gameNodeOrigins(origins) {
    const list = Array.isArray(origins)
        ? origins
        : String(origins || '')
              .split(',')
              .map((entry) => entry.trim());

    return list
        .filter(Boolean)
        .map((entry) => {
            try {
                const url = new URL(entry);

                return url.protocol === 'ws:' || url.protocol === 'wss:' ? url.origin : null;
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

/**
 * The origin a Sentry DSN reports to, so `connect-src` can allow it. DSNs look
 * like https://<key>@<host>/<project>; anything unparseable yields no origin
 * rather than a broken directive.
 *
 * @param {string} [dsn]
 * @returns {string[]} zero or one origin
 */
function sentryOrigin(dsn) {
    if (!dsn) {
        return [];
    }

    try {
        return [new URL(dsn).origin];
    } catch {
        return [];
    }
}

/**
 * @param {object} options
 * @param {boolean} [options.isDeveloping] loosen script-src for the Vite dev server
 * @param {string}  [options.sentryDsn]    allow the Sentry ingest origin
 * @param {string[]|string} [options.gameNodeOrigins] ws(s) origins for game
 *        nodes on their own hosts; unset means same-origin, covered by 'self'
 * @returns {object} helmet contentSecurityPolicy directives
 */
function buildDirectives({ isDeveloping = false, sentryDsn, gameNodeOrigins: nodes } = {}) {
    const devScript = isDeveloping ? ["'unsafe-inline'", "'unsafe-eval'"] : [];
    // Development talks to the Vite dev server and HMR over plain ws on a
    // possibly-different port; production is same-origin or explicitly listed.
    const socketSchemes = isDeveloping ? ['ws:', 'wss:'] : gameNodeOrigins(nodes);

    return {
        defaultSrc: ["'self'"],
        // Blocks <base href> hijacking of every relative URL on the page.
        baseUri: ["'self'"],
        // No Flash/Java/embed surface at all.
        objectSrc: ["'none'"],
        // Clickjacking: the modern counterpart to helmet's X-Frame-Options.
        frameAncestors: ["'self'"],
        // Stops an injected form from posting credentials off-site.
        formAction: ["'self'"],
        scriptSrc: ["'self'", ...devScript, ...HCAPTCHA],
        // The hash covers React Aria's one runtime-injected rule; everything
        // else is the bundled same-origin stylesheet. A hash here also disables
        // 'unsafe-inline' semantics for this directive in every modern browser.
        styleSrc: ["'self'", inlineStyleHash(REACT_ARIA_PRESSABLE_STYLE), ...HCAPTCHA],
        // Fonts are self-hosted (client/assets/fonts), so no third-party font
        // origin is needed; data: covers any inlined face.
        fontSrc: ["'self'", 'data:'],
        // Card art, avatars and backgrounds are all same-origin; data:/blob:
        // cover generated and canvas-produced images.
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", ...socketSchemes, ...HCAPTCHA, ...sentryOrigin(sentryDsn)],
        // hCaptcha renders its challenge in an iframe.
        frameSrc: HCAPTCHA,
        workerSrc: ["'self'", 'blob:'],
        manifestSrc: ["'self'"],
        // Safety net for any http:// subresource that slips into a page: the
        // browser retries it over https rather than firing mixed-content. Only
        // in production - on a plain-http dev server it has nothing to upgrade.
        ...(isDeveloping ? {} : { upgradeInsecureRequests: [] })
    };
}

/**
 * How the policy is applied. `enforce` blocks violations, `report-only` logs
 * them in the browser console without blocking, `off` sends no header.
 *
 * Configurable because the policy cannot be exercised against the real site
 * until it is deployed: if something turns out to be blocked in production,
 * CSP_MODE=report-only restores the site without a redeploy while it is fixed.
 *
 * @param {string} [mode]
 * @returns {'enforce'|'report-only'|'off'}
 */
function normalizeMode(mode) {
    const value = String(mode || 'enforce').toLowerCase();

    return value === 'off' || value === 'report-only' ? value : 'enforce';
}

module.exports = {
    buildDirectives,
    normalizeMode,
    sentryOrigin,
    gameNodeOrigins,
    inlineStyleHash,
    REACT_ARIA_PRESSABLE_STYLE,
    HCAPTCHA
};
