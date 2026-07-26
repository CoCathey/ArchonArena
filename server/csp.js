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
 *  - style-src 'unsafe-inline'. React inline `style={{...}}` props and the
 *    runtime style injection from Tailwind/HeroUI both produce inline styles.
 *    Removing this needs per-render nonces or hashes throughout the component
 *    tree; it is a real project, not a config change.
 *  - wss: (ws: in development). Gameplay runs over socket.io. In production the
 *    game node is deliberately same-origin behind Caddy, but an operator may
 *    split nodes onto their own hosts (docs/DEPLOYMENT.md §6), and a CSP that
 *    silently kills game connections on that topology is worse than one that
 *    allows secure websockets broadly.
 *  - Development adds 'unsafe-inline'/'unsafe-eval' to script-src because Vite's
 *    dev server and HMR require both. Production never gets them.
 */

const HCAPTCHA = ['https://hcaptcha.com', 'https://*.hcaptcha.com'];

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
 * @returns {object} helmet contentSecurityPolicy directives
 */
function buildDirectives({ isDeveloping = false, sentryDsn } = {}) {
    const devScript = isDeveloping ? ["'unsafe-inline'", "'unsafe-eval'"] : [];
    const socketSchemes = isDeveloping ? ['ws:', 'wss:'] : ['wss:'];

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
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', ...HCAPTCHA],
        // Google Fonts serves the files from gstatic; data: covers inlined faces.
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        // Card art, avatars and backgrounds are all same-origin; data:/blob:
        // cover generated and canvas-produced images.
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", ...socketSchemes, ...HCAPTCHA, ...sentryOrigin(sentryDsn)],
        // hCaptcha renders its challenge in an iframe.
        frameSrc: HCAPTCHA,
        workerSrc: ["'self'", 'blob:'],
        manifestSrc: ["'self'"]
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

module.exports = { buildDirectives, normalizeMode, sentryOrigin, HCAPTCHA };
