const {
    evidenceOf,
    deviationFor,
    kMultiplier,
    confidenceOf,
    SEED_DEVIATION,
    MIN_DEVIATION
} = require('../../../../server/services/rating/ariConfidence');

/**
 * ARCHON (N34): a provisional rating moves; a settled one holds.
 *
 * ARI's step was already comparative - Elo against the opponent's rating. What
 * it was not was confident: three games and three hundred bought the same step,
 * so a new deck crept away from its card-math seed one twitch at a time while
 * an established deck was still shoved about by single results it had long
 * outweighed.
 *
 * The properties below are the contract. The exact curve is deliberately NOT
 * asserted anywhere - it is a tuning choice - but its shape is, because every
 * one of these is a way the rule could be quietly inverted and still look like
 * it was working.
 */
describe('ARI confidence', function () {
    const deck = (ratedGames, simGames = 0, lastGameAt = new Date()) => ({
        ratedGames,
        simGames,
        lastGameAt
    });

    describe('evidence', function () {
        it('counts a sparring game for less than a real one', function () {
            expect(evidenceOf(deck(0, 4))).toBeLessThan(evidenceOf(deck(4, 0)));
        });

        it('cannot be talked up by an overnight sweep alone', function () {
            // The lab plays hundreds of games a night. Without the discount, a
            // deck no human had ever played would settle by morning.
            expect(evidenceOf(deck(0, 400))).toBeLessThan(evidenceOf(deck(400, 0)));
        });

        it('treats a deck with no record as having none', function () {
            expect(evidenceOf({})).toBe(0);
            expect(evidenceOf(null)).toBe(0);
        });
    });

    describe('deviation', function () {
        it('starts at the seed for a deck that has never played', function () {
            expect(deviationFor(deck(0, 0, null))).toBe(SEED_DEVIATION);
        });

        it('falls as a deck plays, and never below the floor', function () {
            const three = deviationFor(deck(3));
            const thirty = deviationFor(deck(30));
            const thousand = deviationFor(deck(1000));

            expect(three).toBeGreaterThan(thirty);
            expect(thirty).toBeGreaterThan(thousand);
            expect(thousand).toBeGreaterThanOrEqual(MIN_DEVIATION);
        });

        it('never claims certainty, however many games are played', function () {
            // A deck is never solved, and a deviation of zero would mean a K of
            // zero: a rating that can no longer be wrong is a rating that can
            // no longer be corrected.
            expect(deviationFor(deck(100000))).toBeGreaterThan(0);
        });

        it('loosens again when a deck has been shelved', function () {
            const now = new Date('2026-08-17T00:00:00Z');
            const played = new Date('2026-08-10T00:00:00Z');
            const longAgo = new Date('2024-08-17T00:00:00Z');

            expect(deviationFor({ ...deck(60), lastGameAt: longAgo }, { now })).toBeGreaterThan(
                deviationFor({ ...deck(60), lastGameAt: played }, { now })
            );
        });

        it('does not loosen an unplayed deck past the seed', function () {
            // Already as uncertain as unknown; idleness cannot make it worse.
            expect(deviationFor({ ratedGames: 0, simGames: 0, lastGameAt: null })).toBe(
                SEED_DEVIATION
            );
        });

        it('respects an operator who wants ratings to settle sooner', function () {
            const fast = deviationFor(deck(20), { settlingGames: 5 });
            const slow = deviationFor(deck(20), { settlingGames: 200 });

            expect(fast).toBeLessThan(slow);
        });
    });

    describe('the K multiplier', function () {
        it('is one for a fully settled deck, never less', function () {
            // The load-bearing property for an operator: `gameK` still means
            // what it meant before any of this existed.
            const multiplier = kMultiplier(deck(1000000));

            expect(multiplier).toBeGreaterThanOrEqual(1);
            expect(multiplier).toBeLessThan(1.05);
        });

        it('is largest for a deck that has never played', function () {
            expect(kMultiplier(deck(0, 0, null))).toBe(SEED_DEVIATION / MIN_DEVIATION);
        });

        it('falls monotonically with evidence', function () {
            const series = [0, 1, 5, 20, 50, 200, 1000].map((games) => kMultiplier(deck(games)));

            for (let i = 1; i < series.length; i++) {
                expect(series[i]).toBeLessThan(series[i - 1]);
            }
        });

        it('moves a new deck several times as far as a veteran on the same result', function () {
            // The whole point, stated as the thing a player would notice.
            expect(kMultiplier(deck(2))).toBeGreaterThan(2 * kMultiplier(deck(500)));
        });
    });

    describe('what a reader is told', function () {
        it('calls a deck with almost no record provisional', function () {
            expect(confidenceOf(deck(1)).provisional).toBe(true);
        });

        it('stops calling it provisional once it has a record', function () {
            expect(confidenceOf(deck(200)).provisional).toBe(false);
        });

        it('rounds for display without rounding to nothing', function () {
            const confidence = confidenceOf(deck(7, 3));

            expect(confidence.deviation).toBeGreaterThan(0);
            expect(Number.isFinite(confidence.evidence)).toBe(true);
            expect(confidence.kMultiplier).toBeGreaterThanOrEqual(1);
        });

        it('survives nonsense settings rather than producing a nonsense rating', function () {
            // These reach the module from admin-editable settings, and a NaN
            // multiplier would silently stop every ARI on the site from moving.
            const confidence = confidenceOf(deck(10), {
                settlingGames: 'not a number',
                simGameWeight: null,
                stalenessDays: undefined
            });

            expect(Number.isFinite(confidence.deviation)).toBe(true);
            expect(confidence.kMultiplier).toBeGreaterThanOrEqual(1);
        });
    });
});
