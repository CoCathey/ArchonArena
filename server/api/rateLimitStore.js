const logger = require('../log');

/**
 * ARCHON (I5): the storage behind the rate limiter and the login failure
 * throttle.
 *
 * Both used to be plain in-process Maps. That bounds abuse on a single-process
 * deployment, but the production topology runs more than one lobby behind
 * Caddy, and a per-process limit divides by the number of processes: "10 login
 * failures" becomes 10 *per lobby*, and an attacker who reconnects a few times
 * gets a fresh budget for free. Redis makes the limit mean what it says.
 *
 * Two implementations behind one interface:
 *
 *  - `MemoryStore` is the original behaviour, kept exactly as it was.
 *  - `RedisStore` is the shared one. Every decision is a single Lua script, so
 *    check-and-record is atomic — a read-then-write pair would let concurrent
 *    requests slip past the limit at exactly the moment the limit matters.
 *
 * **RedisStore falls back to MemoryStore on any failure.** This is the whole
 * reason the memory implementation stays: if Redis is unreachable the limits
 * degrade to today's per-process behaviour rather than vanishing, so the change
 * cannot make the site *less* protected than it was, and a Redis outage cannot
 * take authentication down with it. The fallback starts counting from whenever
 * it takes over — it does not inherit the shared counts — which is the honest
 * trade for not blocking logins on a cache.
 */

/** Millisecond-precision sliding window over an in-process Map. */
class MemoryStore {
    constructor() {
        // key -> number[] of event timestamps (ms since epoch)
        this.events = new Map();
        // key -> epoch ms the lockout ends
        this.blocks = new Map();
        this.lastSweepAt = 0;
    }

    /**
     * Opportunistic cleanup. The horizon is deliberately far above every window
     * in use, so the sweep never discards data a caller still needs; each call
     * re-filters against its own window anyway.
     */
    sweep(now, maxAgeMs = 60 * 60 * 1000) {
        if (now - this.lastSweepAt < 60 * 1000) {
            return;
        }

        this.lastSweepAt = now;
        const cutoff = now - maxAgeMs;

        for (const [key, times] of this.events) {
            const kept = times.filter((time) => time > cutoff);

            if (kept.length === 0) {
                this.events.delete(key);
            } else if (kept.length !== times.length) {
                this.events.set(key, kept);
            }
        }

        for (const [key, until] of this.blocks) {
            if (until <= now) {
                this.blocks.delete(key);
            }
        }
    }

    /** Record a request; report whether it is over the limit. */
    hit(key, windowMs, max, now) {
        const times = (this.events.get(key) || []).filter((time) => time > now - windowMs);

        if (times.length >= max) {
            return {
                limited: true,
                retryAfterSec: Math.max(1, Math.ceil((times[0] + windowMs - now) / 1000))
            };
        }

        times.push(now);
        this.events.set(key, times);
        this.sweep(now);

        return { limited: false, retryAfterSec: 0 };
    }

    /** Seconds left on a lockout, or 0 when the key is not locked out. */
    blockedFor(key, now) {
        const until = this.blocks.get(key);

        if (!until || until <= now) {
            return 0;
        }

        return Math.max(1, Math.ceil((until - now) / 1000));
    }

    /**
     * Record one failure; lock the key out once `max` pile up in `windowMs`.
     *
     * Failure counts live under their own `fail:` namespace, matching what
     * RedisStore does with its key names — otherwise a request-limiter bucket
     * and a throttle key that happened to spell the same string would count
     * toward each other.
     */
    recordFailure(key, windowMs, max, blockMs, now) {
        const failKey = `fail:${key}`;
        const failures = (this.events.get(failKey) || []).filter((time) => time > now - windowMs);

        failures.push(now);

        if (failures.length >= max) {
            this.blocks.set(key, now + blockMs);
            // Start the next window clean, so a key that has just been locked
            // out is not immediately re-locked by failures that already counted.
            this.events.delete(failKey);
        } else {
            this.events.set(failKey, failures);
        }
    }

    /** Forget everything about a key. Called on a successful authentication. */
    resetKey(key) {
        this.events.delete(`fail:${key}`);
        this.blocks.delete(key);
    }

    clear() {
        this.events.clear();
        this.blocks.clear();
        this.lastSweepAt = 0;
    }
}

// Check-and-record for the request limiter. Returns {limited, oldestScore}.
// Atomic: a read followed by a separate write would let two concurrent requests
// both observe "under the limit" and both proceed.
const HIT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)

if count >= max then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {1, tonumber(oldest[2])}
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {0, 0}
`;

// Record a failure and lock the key out once the limit is reached, in one step.
const FAILURE_SCRIPT = `
local failures = KEYS[1]
local block = KEYS[2]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local blockMs = tonumber(ARGV[4])
local member = ARGV[5]

redis.call('ZREMRANGEBYSCORE', failures, 0, now - window)
redis.call('ZADD', failures, now, member)
redis.call('PEXPIRE', failures, window)

if redis.call('ZCARD', failures) >= max then
  redis.call('SET', block, '1', 'PX', blockMs)
  -- Clear the window so the key is not re-locked by failures already counted.
  redis.call('DEL', failures)
  return 1
end

return 0
`;

/**
 * Shared store backed by Redis, with MemoryStore as the failure fallback.
 *
 * The client is injected rather than constructed here so the whole thing is
 * testable against a real Redis (and against a client that throws).
 */
class RedisStore {
    constructor(client, { prefix = '', fallback = new MemoryStore() } = {}) {
        this.client = client;
        this.prefix = prefix;
        this.fallback = fallback;
        // Log the first failure of an outage, not one line per request.
        this.degraded = false;
    }

    key(name) {
        return `${this.prefix}ratelimit:${name}`;
    }

    /**
     * Run `operation`, falling back to the in-process store if Redis is
     * unavailable or errors. Never throws: a limiter that throws would turn a
     * cache blip into a 500 on login.
     */
    async withFallback(operation, fallbackOperation) {
        if (!this.client) {
            return fallbackOperation();
        }

        try {
            const result = await operation();

            if (this.degraded) {
                logger.info('Rate limiting is using Redis again');
                this.degraded = false;
            }

            return result;
        } catch (err) {
            if (!this.degraded) {
                this.degraded = true;
                logger.warn(
                    `Rate limiting fell back to per-process limits: ${err.message}. ` +
                        'Limits still apply, but only within each lobby process.'
                );
            }

            return fallbackOperation();
        }
    }

    // A unique member per event: two requests in the same millisecond must both
    // count, and a sorted set would otherwise collapse them into one.
    member(now) {
        return `${now}-${Math.random().toString(36).slice(2, 10)}`;
    }

    async hit(key, windowMs, max, now) {
        return this.withFallback(
            async () => {
                const [limited, oldest] = await this.client.eval(HIT_SCRIPT, {
                    keys: [this.key(key)],
                    arguments: [String(now), String(windowMs), String(max), this.member(now)]
                });

                if (!limited) {
                    return { limited: false, retryAfterSec: 0 };
                }

                return {
                    limited: true,
                    retryAfterSec: Math.max(1, Math.ceil((Number(oldest) + windowMs - now) / 1000))
                };
            },
            () => this.fallback.hit(key, windowMs, max, now)
        );
    }

    async blockedFor(key, now) {
        return this.withFallback(
            async () => {
                const ttl = await this.client.pTTL(this.key(`block:${key}`));

                // -2 = no such key, -1 = key with no expiry (never written here).
                return ttl > 0 ? Math.max(1, Math.ceil(ttl / 1000)) : 0;
            },
            () => this.fallback.blockedFor(key, now)
        );
    }

    async recordFailure(key, windowMs, max, blockMs, now) {
        return this.withFallback(
            () =>
                this.client.eval(FAILURE_SCRIPT, {
                    keys: [this.key(`fail:${key}`), this.key(`block:${key}`)],
                    arguments: [
                        String(now),
                        String(windowMs),
                        String(max),
                        String(blockMs),
                        this.member(now)
                    ]
                }),
            () => this.fallback.recordFailure(key, windowMs, max, blockMs, now)
        );
    }

    async resetKey(key) {
        return this.withFallback(
            async () => {
                await this.client.del([this.key(`fail:${key}`), this.key(`block:${key}`)]);
            },
            () => this.fallback.resetKey(key)
        );
    }
}

module.exports = { MemoryStore, RedisStore, HIT_SCRIPT, FAILURE_SCRIPT };
