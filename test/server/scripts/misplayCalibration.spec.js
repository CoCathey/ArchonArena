const { summariseReviews } = require('../../../server/scripts/misplay-calibration');

/**
 * ARCHON (F3): the calibration report the thresholds get tuned against.
 *
 * The script itself is a query; this arithmetic is the part that must be
 * right, because a wrong rate here would tune the review in the wrong
 * direction. Driven with an injected review function so every number in the
 * answer can be worked out by reading the fixture.
 */
describe('misplay calibration summary', function () {
    const rows = [
        { Data: { version: 6 } }, // two moments, one game
        { Data: { version: 6 } }, // none, two clears
        { Data: { version: 3 } }, // board-only, one moment
        { Data: { version: 1 } } // unreadable
    ];

    const reviews = [
        {
            available: true,
            handsRecorded: true,
            thinned: false,
            moments: [
                { type: 'unused-creatures', player: 'a' },
                { type: 'held-cards', player: 'a' }
            ],
            suppressed: { 'house-call:forged': 1 }
        },
        {
            available: true,
            handsRecorded: true,
            thinned: true,
            moments: [],
            suppressed: { 'house-call:forged': 1, 'held-cards:insurance': 1 }
        },
        {
            available: true,
            handsRecorded: false,
            thinned: false,
            moments: [{ type: 'unused-creatures', player: 'b' }],
            suppressed: {}
        },
        { available: false, reason: 'nothing' }
    ];

    it('reports rates, distribution and justification counts', function () {
        let call = 0;
        const summary = summariseReviews(rows, { review: () => reviews[call++] });

        expect(summary.scanned).toBe(4);
        expect(summary.reviewable).toBe(3);
        expect(summary.unreadable).toBe(1);
        expect(summary.withHands).toBe(2);
        expect(summary.thinned).toBe(1);
        expect(summary.byVersion).toEqual({ 1: 1, 3: 1, 6: 2 });

        expect(summary.momentsTotal).toBe(3);
        expect(summary.momentsPerGame).toBe(1);
        expect(summary.gamesWithNone).toBe(1);
        expect(summary.momentCounts).toEqual({ 0: 1, 1: 1, 2: 1 });

        // unused-creatures appears twice across two games; held-cards once.
        expect(summary.byType['unused-creatures']).toEqual({ moments: 2, games: 2 });
        expect(summary.byType['held-cards']).toEqual({ moments: 1, games: 1 });

        expect(summary.suppressed['house-call:forged']).toBe(2);
        expect(summary.suppressed['held-cards:insurance']).toBe(1);
        expect(summary.suppressedTotal).toBe(3);
    });

    it('copes with an empty history', function () {
        const summary = summariseReviews([]);

        expect(summary.scanned).toBe(0);
        expect(summary.momentsPerGame).toBe(null);
    });
});
