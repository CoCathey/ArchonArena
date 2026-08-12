import {
    computePayouts,
    computePrizePool,
    formatCents
} from '../../client/Components/Tournaments/prizePool';

/**
 * ARCHON: the prize table has to add up.
 *
 * This platform never touches the money - the organizer collects and pays out
 * - so nothing here can lose anyone a cent directly. What it can do is print a
 * table that does not sum to the pot, in front of eight people at the end of
 * the night, which is the one bug in this module anybody will ever notice.
 *
 * So the invariant these tests care about is conservation: every division
 * either adds back up to what went in, or the difference is named.
 */
describe('prize pool', function () {
    const splits = (...pairs) => pairs.map(([rank, bps]) => ({ rank, bps }));
    const player = (userId, finalRank, extra = {}) => ({
        userId,
        username: `user${userId}`,
        finalRank,
        ...extra
    });

    describe('the pot', function () {
        it('is the buy-in times the people who bought in', function () {
            const pool = computePrizePool({
                entryFeeCents: 1000,
                entrantCount: 8,
                splits: splits([1, 10000])
            });

            expect(pool.poolCents).toBe(8000);
            expect(pool.places[0].amountCents).toBe(8000);
            expect(pool.retainedCents).toBe(0);
        });

        it('names what the splits do not hand out', function () {
            // 75/20 leaves 5% with the organizer - the venue's cut.
            const pool = computePrizePool({
                entryFeeCents: 1000,
                entrantCount: 10,
                splits: splits([1, 7500], [2, 2000])
            });

            expect(pool.poolCents).toBe(10000);
            expect(pool.places.map((place) => place.amountCents)).toEqual([7500, 2000]);
            expect(pool.retainedCents).toBe(500);
        });

        // Floors everywhere, so the table can never promise more than the pot.
        it('never over-allocates when the split does not divide cleanly', function () {
            const pool = computePrizePool({
                entryFeeCents: 500,
                entrantCount: 3,
                splits: splits([1, 3333], [2, 3333], [3, 3334])
            });

            const awarded = pool.places.reduce((sum, place) => sum + place.amountCents, 0);

            expect(awarded).toBeLessThanOrEqual(pool.poolCents);
            expect(awarded + pool.retainedCents).toBe(pool.poolCents);
        });

        it('copes with a free event and with nobody entered', function () {
            expect(computePrizePool({ entryFeeCents: 0, entrantCount: 8 }).poolCents).toBe(0);
            expect(computePrizePool({ entryFeeCents: 1000, entrantCount: 0 }).poolCents).toBe(0);
            expect(computePrizePool().poolCents).toBe(0);
        });

        it('ignores nonsense splits rather than paying them', function () {
            const pool = computePrizePool({
                entryFeeCents: 1000,
                entrantCount: 4,
                splits: [
                    { rank: 1, bps: 5000 },
                    { rank: 0, bps: 1000 },
                    { rank: 2, bps: -500 },
                    { rank: 'x', bps: 1000 }
                ]
            });

            expect(pool.places).toHaveLength(1);
            expect(pool.places[0].amountCents).toBe(2000);
        });
    });

    describe('who gets paid', function () {
        const event = (players, splitList = splits([1, 7500], [2, 2000])) =>
            computePayouts({ entryFeeCents: 1000, splits: splitList, players });

        it('pays the placed players and nobody else', function () {
            const result = event([player(1, 1), player(2, 2), player(3, 3), player(4, 4)]);

            expect(result.poolCents).toBe(4000);
            expect(result.payouts).toHaveLength(2);
            expect(result.payouts[0]).toMatchObject({ userId: 1, rank: 1, amountCents: 3000 });
            expect(result.payouts[1]).toMatchObject({ userId: 2, rank: 2, amountCents: 800 });
        });

        it('does not count waitlisted players in the pot', function () {
            const result = event([
                player(1, 1),
                player(2, 2),
                player(3, null, { waitlisted: true })
            ]);

            expect(result.poolCents).toBe(2000);
        });

        // A player who dropped part-way still paid, and every paper event
        // leaves that money in the pot.
        it('keeps a dropped player their buy-in in the pot', function () {
            const result = event([player(1, 1), player(2, 2), player(3, 3, { dropped: true })]);

            expect(result.poolCents).toBe(3000);
        });

        /**
         * The case this platform actually produces: computeFinalRanks shares a
         * placing between players knocked out in the same bracket round.
         */
        describe('ties', function () {
            it('pools the places a tie occupies and splits them evenly', function () {
                // Two tied for 1st take 1st AND 2nd money: 75% + 20% of 4000.
                const result = event([player(1, 1), player(2, 1), player(3, 3), player(4, 4)]);

                expect(result.payouts).toHaveLength(2);
                expect(result.payouts[0].amountCents).toBe(1900);
                expect(result.payouts[1].amountCents).toBe(1900);
                expect(result.payouts[0].sharedWith).toBe(1);
            });

            it('gives a tie for last money only for the places it reaches', function () {
                // Two tied for 2nd take 2nd and 3rd; there is no 3rd prize.
                const result = event([player(1, 1), player(2, 2), player(3, 2), player(4, 4)]);

                const second = result.payouts.filter((payout) => payout.rank === 2);

                expect(second).toHaveLength(2);
                expect(second[0].amountCents + second[1].amountCents).toBe(800);
            });

            // Somebody has to get the odd penny, and it must be the same one
            // on every render.
            it('splits an odd amount to the cent, deterministically', function () {
                const result = computePayouts({
                    entryFeeCents: 333,
                    splits: splits([1, 10000]),
                    players: [player(7, 1), player(3, 1), player(5, 3)]
                });

                const total = result.payouts.reduce((sum, pay) => sum + pay.amountCents, 0);

                expect(total).toBe(result.poolCents);
                expect(result.payouts.map((pay) => pay.userId)).toEqual([3, 7]);
                expect(result.payouts.map((pay) => pay.amountCents)).toEqual([500, 499]);

                // And again, identically.
                const again = computePayouts({
                    entryFeeCents: 333,
                    splits: splits([1, 10000]),
                    players: [player(5, 3), player(7, 1), player(3, 1)]
                });

                expect(again.payouts).toEqual(result.payouts);
            });
        });

        /**
         * Conservation, which is the whole point: what came in either goes to a
         * player, is retained by the organizer, or is named as unallocated.
         * Nothing evaporates and nothing is invented.
         */
        it('always adds back up to the pot', function () {
            const cases = [
                [[player(1, 1), player(2, 2)], splits([1, 7500], [2, 2000])],
                [
                    [player(1, 1), player(2, 1), player(3, 3)],
                    splits([1, 5000], [2, 3000], [3, 2000])
                ],
                [[player(1, 1)], splits([1, 5000], [2, 3000], [3, 2000])],
                [
                    [player(1, 1), player(2, 2), player(3, 3)],
                    splits([1, 3333], [2, 3333], [3, 3334])
                ],
                [[player(1, 4), player(2, 5)], splits([1, 10000])]
            ];

            for (const [players, splitList] of cases) {
                const result = computePayouts({ entryFeeCents: 777, splits: splitList, players });
                const paid = result.payouts.reduce((sum, pay) => sum + pay.amountCents, 0);

                expect(paid + result.retainedCents + result.unallocatedCents).toBe(
                    result.poolCents
                );
                expect(result.unallocatedCents).toBeGreaterThanOrEqual(0);
            }
        });

        // A prize for a place nobody reached is called out rather than quietly
        // folded into the organizer's cut.
        it('names prizes no one reached', function () {
            const result = event([player(1, 1), player(2, 2)], splits([1, 5000], [3, 5000]));

            expect(result.unallocatedCents).toBe(1000);
        });

        it('pays nobody when the event is free', function () {
            const result = computePayouts({
                entryFeeCents: 0,
                splits: splits([1, 10000]),
                players: [player(1, 1)]
            });

            expect(result.payouts).toEqual([]);
        });
    });

    describe('formatting', function () {
        it('writes money the way people read it', function () {
            expect(formatCents(1000)).toBe('$10.00');
            expect(formatCents(1999)).toBe('$19.99');
            expect(formatCents(0)).toBe('$0.00');
            expect(formatCents(1050, 'EUR')).toBe('€10.50');
        });

        it('falls back to the code for a currency it has no symbol for', function () {
            expect(formatCents(1000, 'SEK')).toBe('10.00 SEK');
        });
    });
});
