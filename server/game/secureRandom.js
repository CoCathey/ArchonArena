const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

/**
 * ARCHON (N21): a scoped, seedable source for SIMULATED games only.
 *
 * The Champion's Challenge's learning bot needs deterministic replay: to ask
 * "what happens if I play this card instead?", it re-runs a game's recorded
 * inputs from the start, and that only reconstructs the same game if every
 * shuffle and random discard draws the same numbers. So a simulation runs
 * inside `withRandomSource(prng, work)`, and every call that lands here from
 * that async context - across awaits, but never from unrelated work
 * interleaved on the event loop - draws from the injected generator instead
 * of crypto.
 *
 * Real games are untouched by construction: they run on the game nodes,
 * which never enter a scope, and even in the lobby the AsyncLocalStorage
 * boundary means invite codes, tokens and every other caller keep drawing
 * from crypto while a bot game is mid-await beside them. Unpredictability
 * was the whole point of this module; the scope exists precisely so
 * determinism can be granted to practice games without loaning it to
 * anything that matters.
 */
const randomScope = new AsyncLocalStorage();

/**
 * Run `work` with all of this module's randomness drawn from `source` - an
 * object with `next()` returning floats in [0, 1). Returns work's result;
 * the scope covers everything awaited inside it.
 *
 * @template T
 * @param {{next: () => number}} source
 * @param {() => T} work
 * @returns {T}
 */
const withRandomSource = (source, work) => randomScope.run(source, work);

/**
 * A tiny deterministic generator (mulberry32) for simulated games. Fast,
 * well-distributed, and 32 bits of seed is plenty for practice games -
 * anything that pays out real fairness still comes from crypto.
 *
 * @param {number} seed
 * @returns {{next: () => number, seed: number}}
 */
const seededSource = (seed) => {
    let state = seed >>> 0;

    return {
        seed: state,
        next() {
            state = (state + 0x6d2b79f5) >>> 0;
            let t = state;

            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        }
    };
};

/**
 * ARCHON: randomness that decides a game.
 *
 * Every shuffle, every "discard a random card", every first-player roll comes
 * through here. The algorithm is unchanged - Fisher-Yates, which is already
 * optimal and already unbiased - and so is the fairness: the shuffle this
 * replaces was measured over 240,000 trials at chi-square 133 on 121 degrees of
 * freedom, which is exactly what a uniform shuffle looks like.
 *
 * What changes is PREDICTABILITY, and that is the whole point.
 *
 * `Math.random()` in V8 is xorshift128+: a formula whose internal state can be
 * recovered from a handful of observed outputs, seeded once per process and
 * shared by every game on the node. Someone who watched enough randomness they
 * were entitled to see - their own shuffles across a few games, a sealed deal -
 * could in principle work out the state and predict an opponent's draws. That
 * was academic while this was friends playing for fun. It stopped being
 * academic when events started carrying entry fees and prize pools.
 *
 * This costs about a microsecond per shuffle. A 36-card deck measured at 2.2us
 * against 1.1us for the version it replaces, a handful of times per game.
 *
 * THE ONE THING THAT IS EASY TO GET WRONG
 *
 * Not the shuffle - the range reduction. Random bits arrive as bytes (0-255)
 * and a 36-card deck needs 0-35. 256 is not divisible by 36, so the naive
 * `byte % 36` gives the first four positions an extra chance: measured at a 15%
 * spread across positions, from a perfectly uniform source. `crypto.randomInt`
 * does rejection sampling - draw again when the value lands in the ragged tail -
 * which is why it is used here rather than any arithmetic of our own. The
 * distribution test in the spec exists to catch a future change that reaches
 * for the modulo.
 */

/**
 * A uniformly random integer in [0, max).
 *
 * @param {number} max exclusive upper bound, at least 1
 */
const randomInt = (max) => {
    const bound = Math.floor(max);

    if (!Number.isFinite(bound) || bound < 1) {
        // Callers ask for a card from a pile that can be empty. Zero is the
        // only sensible answer and throwing here would turn an empty hand into
        // a crashed game.
        return 0;
    }

    // ARCHON (N21): a simulated game's scoped source, when one is set. The
    // float-scaling bias crypto.randomInt's rejection sampling avoids is
    // ~2^-53 here - meaningless for a practice game - and determinism needs
    // a fixed number of draws per call, which rejection sampling cannot give.
    const scoped = randomScope.getStore();

    if (scoped) {
        return Math.floor(scoped.next() * bound);
    }

    return crypto.randomInt(bound);
};

/**
 * A shuffled copy. Fisher-Yates: walk from the end, swap each position with a
 * uniformly chosen one at or before it.
 *
 * A copy rather than in-place because the callers it replaces (`_.shuffle`)
 * return one, and several of them shuffle a live zone - a player's hand - that
 * must not be reordered as a side effect of looking at it.
 */
const shuffle = (array) => {
    const out = Array.isArray(array) ? array.slice() : [...(array || [])];

    for (let index = out.length - 1; index > 0; index--) {
        const swap = randomInt(index + 1);

        [out[index], out[swap]] = [out[swap], out[index]];
    }

    return out;
};

/**
 * One random element, or `n` of them.
 *
 * Matches underscore's `_.sample` shape, which is what the call sites expect:
 * with no count it returns a single element (undefined when there is nothing
 * to pick), and with one it returns an array of at most that many.
 */
const sample = (array, count) => {
    const items = Array.isArray(array) ? array : [...(array || [])];

    if (count === undefined) {
        return items.length === 0 ? undefined : items[randomInt(items.length)];
    }

    return shuffle(items).slice(0, Math.max(0, count));
};

module.exports = { randomInt, shuffle, sample, withRandomSource, seededSource };
