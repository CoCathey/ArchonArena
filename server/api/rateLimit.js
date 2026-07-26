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

/**
 * The client address to key an anonymous caller on.
 *
 * ARCHON: this used to read `x-real-ip` / `x-forwarded-for` straight off the
 * request. Those are attacker-controlled on any request that reaches the app,
 * so a caller could send a different `X-Real-IP` every time and get a fresh
 * bucket on each one - the limiter counted, but never actually limited.
 *
 * `req.ip` is derived by Express from the `trust proxy` setting (server.js
 * trusts exactly the one Caddy hop in production, nothing in development), so
 * forwarding headers are honoured only when they came from our own proxy and
 * are ignored otherwise.
 */
function clientIp(req) {
    return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
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

/**
 * ARCHON: a throttle that counts *failures* rather than requests, and locks the
 * key out for a while once too many pile up.
 *
 * `rateLimit` above bounds raw request volume, which is the wrong tool for
 * credential guessing: a limit loose enough not to inconvenience someone
 * mistyping their password is far too loose to stop an attacker, and a limit
 * tight enough to stop the attacker locks out honest users who simply log in
 * often. Counting only failed attempts - and clearing the count on success -
 * lets the limit be strict without ever penalising a legitimate login.
 *
 * Keys are caller-chosen so the same throttle can track an address and an
 * account separately: per-IP catches one host working through many accounts,
 * per-username catches many hosts working on one account.
 *
 * @param {object} options
 * @param {number} options.windowMs how far back failures are counted
 * @param {number} options.max      failures allowed within the window
 * @param {number} options.blockMs  how long a key stays locked out
 */
function createFailureThrottle({ windowMs, max, blockMs }) {
    // key -> { failures: number[], blockedUntil: number }
    const buckets = new Map();

    const bucketFor = (key) => {
        let bucket = buckets.get(key);

        if (!bucket) {
            bucket = { failures: [], blockedUntil: 0 };
            buckets.set(key, bucket);
        }

        return bucket;
    };

    return {
        /**
         * Seconds remaining on the lockout for `key`, or 0 when not locked out.
         */
        blockedFor(key, now = Date.now()) {
            const bucket = buckets.get(key);

            if (!bucket || bucket.blockedUntil <= now) {
                return 0;
            }

            return Math.max(1, Math.ceil((bucket.blockedUntil - now) / 1000));
        },

        /** Record one failed attempt; locks the key out once max is reached. */
        recordFailure(key, now = Date.now()) {
            const bucket = bucketFor(key);

            bucket.failures = bucket.failures.filter((time) => time > now - windowMs);
            bucket.failures.push(now);

            if (bucket.failures.length >= max) {
                bucket.blockedUntil = now + blockMs;
                // Start the next window clean so a locked-out key is not
                // immediately re-locked by failures that already counted.
                bucket.failures = [];
            }
        },

        /** Clear all state for a key. Called on a successful authentication. */
        reset(key) {
            buckets.delete(key);
        },

        // Exposed for tests.
        _reset() {
            buckets.clear();
        }
    };
}

// Exposed for tests.
function _reset() {
    store.clear();
    lastSweepAt = 0;
}

module.exports = { rateLimit, createFailureThrottle, clientIp, _reset };
