const logger = require('../log');
const { MemoryStore, RedisStore } = require('./rateLimitStore');

/**
 * ARCHON: sliding-window rate limiting and login failure throttling.
 *
 * Applied to record-creating / invite / external-API endpoints that have no
 * legitimate high-frequency use (friend requests, club/store/tournament
 * creation, DoK collection import, replay sharing), and to every auth endpoint.
 *
 * ARCHON (I5): state now lives in Redis rather than in a per-process Map. The
 * production topology runs more than one lobby, and a per-process limit divides
 * by the number of processes — "10 login failures" silently became 10 per
 * lobby. See rateLimitStore.js for the storage, including why a Redis outage
 * degrades to per-process limits instead of dropping them.
 */

// The active store. Starts in-process so anything that imports this module
// before the lobby boots (tests, scripts) still gets working limits; `setRedisStore`
// swaps in the shared one at startup.
let store = new MemoryStore();

/**
 * Back the limiters with Redis. Called once from server startup with a
 * connected client; safe to skip entirely, in which case limits stay
 * per-process exactly as they were.
 *
 * @param {object} client   a connected node-redis client
 * @param {string} [prefix] key prefix (the site's redisKeyPrefix)
 */
function setRedisStore(client, prefix = '') {
    store = new RedisStore(client, { prefix });
    logger.info('Rate limiting is backed by Redis (limits are shared across lobby processes)');
}

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

    return async (req, res, next) => {
        const identity = req.user && req.user.id ? `u:${req.user.id}` : `ip:${clientIp(req)}`;
        const key = `${bucket}:${identity}`;

        let result;

        try {
            result = await store.hit(key, windowMs, max, Date.now());
        } catch (err) {
            // The store already falls back to memory internally, so reaching
            // here means something unexpected. Let the request through rather
            // than 500 on it: a limiter is a safeguard, not a gate.
            logger.error('Rate limiter failed; allowing the request', err);

            return next();
        }

        if (result.limited) {
            res.set('Retry-After', String(result.retryAfterSec));

            return res.status(429).send({
                success: false,
                message:
                    message ||
                    'You are doing that too often. Please slow down and try again shortly.'
            });
        }

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
 * Every method is async because the state is shared (see the module comment);
 * callers must await them, or a lockout will not be observed until the next
 * request.
 *
 * @param {object} options
 * @param {number} options.windowMs how far back failures are counted
 * @param {number} options.max      failures allowed within the window
 * @param {number} options.blockMs  how long a key stays locked out
 */
function createFailureThrottle({ windowMs, max, blockMs }) {
    return {
        /**
         * Seconds remaining on the lockout for `key`, or 0 when not locked out.
         */
        async blockedFor(key, now = Date.now()) {
            return store.blockedFor(key, now);
        },

        /** Record one failed attempt; locks the key out once max is reached. */
        async recordFailure(key, now = Date.now()) {
            return store.recordFailure(key, windowMs, max, blockMs, now);
        },

        /** Clear all state for a key. Called on a successful authentication. */
        async reset(key) {
            return store.resetKey(key);
        }
    };
}

// Exposed for tests: drop back to a clean in-process store.
function _reset() {
    store = new MemoryStore();
}

module.exports = { rateLimit, createFailureThrottle, clientIp, setRedisStore, _reset };
