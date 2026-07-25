// ARCHON: Quick Match matchmaking queue (Phase — player-facing matchmaking).
//
// A pure, in-memory queue that pairs waiting players by Amber (rating)
// proximity within a tolerance that widens the longer they wait, so a close
// match is preferred but nobody waits forever. The service holds no sockets
// and never calls Date.now() itself — the lobby drives it (passing the clock
// and a `canPair` predicate for block-lists / already-in-a-game checks), which
// keeps the pairing logic deterministic and unit-testable.

const DEFAULT_CONFIG = {
    // Amber gap allowed the instant a player joins the queue.
    baseTolerance: 150,
    // Extra Amber of tolerance granted per second waited (the longer of the
    // two players' waits is used).
    tolerancePerSecond: 25,
    // After this long in queue a player will match anyone available.
    maxWaitMs: 60000
};

// Fallback Amber for a player with no rating in the pool yet (matches the Elo
// engine's default starting rating).
const DEFAULT_AMBER = 1200;

class MatchmakingService {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        // username -> { username, format, amber, joinedAt }
        this.entries = new Map();
    }

    has(username) {
        return this.entries.has(username);
    }

    size(format) {
        if (!format) {
            return this.entries.size;
        }

        let count = 0;
        for (const entry of this.entries.values()) {
            if (entry.format === format) {
                count++;
            }
        }

        return count;
    }

    /**
     * Snapshot of who is currently queued, for broadcasting live queue sizes.
     * @returns {Array<{username: string, format: string}>}
     */
    list() {
        return Array.from(this.entries.values()).map((entry) => ({
            username: entry.username,
            format: entry.format
        }));
    }

    /**
     * Add (or refresh) a player in the queue. Re-queueing for the same format
     * keeps the original wait so a player can't game the tolerance by
     * re-joining; switching format starts a fresh wait.
     */
    enqueue({ username, format, amber, joinedAt }) {
        if (!username || !format) {
            return false;
        }

        const existing = this.entries.get(username);
        const keepWait = existing && existing.format === format;

        this.entries.set(username, {
            username,
            format,
            amber: Number.isFinite(amber) ? amber : DEFAULT_AMBER,
            joinedAt: keepWait ? existing.joinedAt : joinedAt
        });

        return true;
    }

    dequeue(username) {
        return this.entries.delete(username);
    }

    toleranceFor(waitMs) {
        if (waitMs >= this.config.maxWaitMs) {
            return Infinity;
        }

        return this.config.baseTolerance + this.config.tolerancePerSecond * (waitMs / 1000);
    }

    /**
     * Find and remove all pairs that can be matched right now.
     *
     * @param {number} nowMs current time in ms (the lobby passes Date.now()).
     * @param {(a: object, b: object) => boolean} [canPair] optional guard the
     *   caller uses to veto a pairing (e.g. block-lists, already-in-a-game).
     * @returns {Array<[object, object]>} matched [a, b] entry pairs, removed
     *   from the queue.
     */
    collectMatches(nowMs, canPair = () => true) {
        const pairs = [];
        const byFormat = new Map();

        for (const entry of this.entries.values()) {
            if (!byFormat.has(entry.format)) {
                byFormat.set(entry.format, []);
            }
            byFormat.get(entry.format).push(entry);
        }

        for (const group of byFormat.values()) {
            // Longest-waiting first, so the queue is fair (FIFO) and a
            // long-waiter's widened tolerance is applied before newcomers'.
            const pool = group.slice().sort((a, b) => a.joinedAt - b.joinedAt);
            const used = new Set();

            for (let i = 0; i < pool.length; i++) {
                const a = pool[i];
                if (used.has(a.username)) {
                    continue;
                }

                let best = null;
                let bestGap = Infinity;

                for (let j = i + 1; j < pool.length; j++) {
                    const b = pool[j];
                    if (used.has(b.username) || !canPair(a, b)) {
                        continue;
                    }

                    const gap = Math.abs(a.amber - b.amber);
                    const tolerance = Math.max(
                        this.toleranceFor(nowMs - a.joinedAt),
                        this.toleranceFor(nowMs - b.joinedAt)
                    );

                    if (gap <= tolerance && gap < bestGap) {
                        best = b;
                        bestGap = gap;
                    }
                }

                if (best) {
                    used.add(a.username);
                    used.add(best.username);
                    pairs.push([a, best]);
                }
            }
        }

        for (const [a, b] of pairs) {
            this.entries.delete(a.username);
            this.entries.delete(b.username);
        }

        return pairs;
    }
}

module.exports = MatchmakingService;
module.exports.DEFAULT_AMBER = DEFAULT_AMBER;
