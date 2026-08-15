const crypto = require('crypto');

const secureRandom = require('../../../server/game/secureRandom');

/**
 * ARCHON: the shuffle has to stay fair, and stay unguessable.
 *
 * Fairness was never the problem - the shuffle this replaces measured clean -
 * and that is exactly why it needs pinning. The change swapped the randomness
 * SOURCE, and the one way to make things worse while doing that is to get the
 * range reduction wrong: random bits arrive as bytes and a 36-card deck needs
 * 0-35, and 256 is not divisible by 36. The naive `byte % 36` hands the first
 * four positions an extra chance, measured below at a 15% spread from a
 * perfectly uniform source.
 *
 * So these tests are not ceremony around a library call. They are the thing
 * that catches a future change reaching for the modulo because it looks
 * cheaper.
 */
describe('secureRandom', function () {
    describe('shuffle', function () {
        it('keeps every card, exactly once', function () {
            const deck = Array.from({ length: 36 }, (unused, index) => index);
            const shuffled = secureRandom.shuffle(deck);

            expect(shuffled).toHaveLength(36);
            expect([...shuffled].sort((a, b) => a - b)).toEqual(deck);
        });

        // Several call sites shuffle a live zone - a player's hand - to look at
        // it. Reordering their hand as a side effect would be a real bug.
        it('does not disturb the array it was given', function () {
            const hand = ['a', 'b', 'c', 'd', 'e', 'f'];
            const before = [...hand];

            secureRandom.shuffle(hand);

            expect(hand).toEqual(before);
        });

        it('copes with what an empty or single-card pile gives it', function () {
            expect(secureRandom.shuffle([])).toEqual([]);
            expect(secureRandom.shuffle(['only'])).toEqual(['only']);
            expect(secureRandom.shuffle(undefined)).toEqual([]);
        });

        /**
         * THE FAIRNESS TEST. Every card must be equally likely in every
         * position - which is what Fisher-Yates guarantees and what a botched
         * range reduction quietly breaks.
         *
         * Twelve cards rather than thirty-six so each cell gets enough samples
         * to be meaningful without the test taking a minute. Chi-square with
         * 121 degrees of freedom sits under about 158 at p=0.001; a shuffle
         * with real positional bias lands in the thousands.
         */
        it('puts every card in every position equally often', function () {
            const size = 12;
            const trials = 60000;
            const counts = Array.from({ length: size }, () => new Array(size).fill(0));

            for (let trial = 0; trial < trials; trial++) {
                const order = secureRandom.shuffle(
                    Array.from({ length: size }, (unused, index) => index)
                );

                for (let position = 0; position < size; position++) {
                    counts[order[position]][position]++;
                }
            }

            const expected = trials / size;
            let chiSquare = 0;

            for (let card = 0; card < size; card++) {
                for (let position = 0; position < size; position++) {
                    chiSquare += (counts[card][position] - expected) ** 2 / expected;
                }
            }

            expect(chiSquare).toBeLessThan(200);
        });
    });

    describe('randomInt', function () {
        it('stays inside the range', function () {
            for (let trial = 0; trial < 2000; trial++) {
                const value = secureRandom.randomInt(7);

                expect(value).toBeGreaterThanOrEqual(0);
                expect(value).toBeLessThan(7);
                expect(Number.isInteger(value)).toBe(true);
            }
        });

        // Callers ask for a card from a pile that can be empty. Throwing there
        // would turn an empty hand into a crashed game.
        it('answers zero rather than throwing for an empty range', function () {
            expect(secureRandom.randomInt(0)).toBe(0);
            expect(secureRandom.randomInt(-3)).toBe(0);
            expect(secureRandom.randomInt(undefined)).toBe(0);
        });

        /**
         * The modulo trap, demonstrated rather than asserted.
         *
         * If this ever fails it means someone replaced the rejection sampling
         * with arithmetic, and the shuffle went quietly unfair while every
         * other test kept passing.
         */
        it('is far more even than the modulo it must not use', function () {
            const size = 36;
            const trials = 360000;
            const spread = (counts) => {
                const expected = trials / size;

                return (Math.max(...counts) - Math.min(...counts)) / expected;
            };

            const modulo = new Array(size).fill(0);
            const bytes = crypto.randomBytes(trials);

            for (let index = 0; index < trials; index++) {
                modulo[bytes[index] % size]++;
            }

            const fair = new Array(size).fill(0);

            for (let index = 0; index < trials; index++) {
                fair[secureRandom.randomInt(size)]++;
            }

            // 256 % 36 = 4, so four values get an extra chance - about 15%.
            expect(spread(modulo)).toBeGreaterThan(0.1);
            // Sampling noise only.
            expect(spread(fair)).toBeLessThan(0.05);
        });
    });

    describe('sample', function () {
        it('returns one element without a count, and an array with one', function () {
            const cards = ['a', 'b', 'c'];

            expect(cards).toContain(secureRandom.sample(cards));
            expect(secureRandom.sample(cards, 2)).toHaveLength(2);
            expect(secureRandom.sample(cards, 99)).toHaveLength(3);
        });

        // Matches what the call sites replaced expected of underscore.
        it('gives back nothing for an empty pile', function () {
            expect(secureRandom.sample([])).toBeUndefined();
            expect(secureRandom.sample([], 3)).toEqual([]);
            expect(secureRandom.sample(undefined)).toBeUndefined();
        });

        it('picks each element about equally often', function () {
            const cards = ['a', 'b', 'c', 'd'];
            const counts = { a: 0, b: 0, c: 0, d: 0 };

            for (let trial = 0; trial < 40000; trial++) {
                counts[secureRandom.sample(cards)]++;
            }

            for (const card of cards) {
                expect(counts[card]).toBeGreaterThan(9000);
                expect(counts[card]).toBeLessThan(11000);
            }
        });
    });

    /**
     * The point of the whole change. Fairness is what the tests above cover;
     * this is the property they cannot see, so it is asserted structurally: the
     * randomness comes from crypto, and nothing here falls back to Math.random.
     */
    describe('the source', function () {
        it('draws from crypto, not from Math.random', function () {
            const fromCrypto = vi.spyOn(crypto, 'randomInt');
            const fromMath = vi.spyOn(Math, 'random');

            secureRandom.shuffle([1, 2, 3, 4, 5, 6, 7, 8]);

            expect(fromCrypto).toHaveBeenCalled();
            expect(fromMath).not.toHaveBeenCalled();

            vi.restoreAllMocks();
        });
    });
});
