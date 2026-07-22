/**
 * ARCHON: lightweight in-memory sliding-window rate limiter.
 *
 * Applied to record-creating / invite / external-API endpoints that have no
 * legitimate high-frequency use, to bound spam and automated abuse (friend
 * requests, club/store/tournament creation, DoK collection import).
 *
 * State is per-process, consistent with the rest of the app's per-instance
 * state (e.g. the DoK outbound budget). A hard multi-instance guarantee would
 * move this to Redis, but per-instance limits already raise the cost of abuse
 * substantially and add no new failure modes (no external dependency, fails
 * open only if the process itself is unhealthy).
 */

// key -> number[] of request timestamps (ms since epoch)
const store = new Map();

// Opportunistic cleanup horizon. Kept comfortably above every window below so
// the sweep never discards data a limiter still needs; per-request enforcement
// re-filters against each limiter's own window.
const MAX_AGE_MS = 60 * 60 * 1000;
let lastSweepAt = 0;

function clientIp(req) {
    return (
        (req.get && req.get('x-real-ip')) ||
        (req.headers && req.headers['x-forwarded-for']) ||
        (req.connection && req.connection.remoteAddress) ||
        'unknown'
    );
}

function sweep(now) {
    if (now - lastSweepAt < 60 * 1000) {
        return;
    }

    lastSweepAt = now;
    const cutoff = now - MAX_AGE_MS;

    for (const [key, times] of store) {
        const kept = times.filter((time) => time > cutoff);
        if (kept.length === 0) {
            store.delete(key);
        } else if (kept.length !== times.length) {
            store.set(key, kept);
        }
    }
}

/**
 * @param {object} options
 * @param {number} options.windowMs sliding window length in milliseconds
 * @param {number} options.max      max requests allowed per key per window
 * @param {string} options.name     bucket name (namespaces the key)
 * @param {string} [options.message] 429 message
 * @returns {import('express').RequestHandler}
 */
function rateLimit({ windowMs, max, name, message }) {
    const bucket = name || 'action';

    return (req, res, next) => {
        const identity = req.user && req.user.id ? `u:${req.user.id}` : `ip:${clientIp(req)}`;
        const key = `${bucket}:${identity}`;
        const now = Date.now();
        const windowStart = now - windowMs;

        const times = (store.get(key) || []).filter((time) => time > windowStart);

        if (times.length >= max) {
            const retryAfterSec = Math.max(1, Math.ceil((times[0] + windowMs - now) / 1000));
            res.set('Retry-After', String(retryAfterSec));

            return res.status(429).send({
                success: false,
                message:
                    message ||
                    'You are doing that too often. Please slow down and try again shortly.'
            });
        }

        times.push(now);
        store.set(key, times);
        sweep(now);

        next();
    };
}

// Exposed for tests.
function _reset() {
    store.clear();
    lastSweepAt = 0;
}

module.exports = { rateLimit, _reset };
