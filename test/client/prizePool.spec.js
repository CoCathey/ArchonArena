import {
    amountFromCents,
    bpsFromPercent,
    centsFromAmount,
    computePayouts,
    computePrizePool,
    formatCents,
    ordinal,
    percentFromBps,
    presetIdFor,
    prizeRows,
    PRIZE_PRESETS
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

    /**
     * What the organizer types, and what gets stored. Dollars to cents and
     * percent to basis points are the same conversion, and it is the one place
     * in here a float would quietly cost somebody a penny - 10.10 * 100 is
     * 1009.9999999999999.
     */
    describe('reading what the organizer typed', function () {
        it('turns an amount into cents without going through a float', function () {
            expect(centsFromAmount('10')).toBe(1000);
            expect(centsFromAmount('10.50')).toBe(1050);
            expect(centsFromAmount('10.5')).toBe(1050);
            expect(centsFromAmount('0.05')).toBe(5);
            expect(centsFromAmount('.5')).toBe(50);
            expect(centsFromAmount('$15.00')).toBe(1500);
        });

        // Spot-checked across a range rather than at one lucky number.
        it('is exact where multiplying by 100 is not', function () {
            for (const dollars of [1.1, 2.9, 4.35, 8.2, 16.08, 78.9, 102.03]) {
                expect(centsFromAmount(String(dollars))).toBe(Math.round(dollars * 100));
            }

            // These are the ones that go through the float wrong, and they are
            // ordinary prices, not contrived ones: 4.35 * 100 is
            // 434.99999999999994 and 8.20 * 100 is 819.9999999999999. Round
            // rescues both; the naive truncation loses a cent, silently, on a
            // number the organizer will see printed back correctly everywhere
            // else on the page.
            expect(Number.isInteger(4.35 * 100)).toBe(false);
            expect(Math.trunc(4.35 * 100)).toBe(434);
            expect(Math.trunc(8.2 * 100)).toBe(819);
            expect(centsFromAmount('4.35')).toBe(435);
            expect(centsFromAmount('8.20')).toBe(820);
        });

        it('truncates past the cent rather than inventing one', function () {
            expect(centsFromAmount('10.999')).toBe(1099);
        });

        it('reads an empty or unusable field as nothing at all', function () {
            expect(centsFromAmount('')).toBeNull();
            expect(centsFromAmount('   ')).toBeNull();
            expect(centsFromAmount('.')).toBeNull();
            expect(centsFromAmount(null)).toBeNull();
            expect(centsFromAmount(undefined)).toBeNull();
        });

        it('round-trips through the input and back', function () {
            for (const cents of [0, 5, 500, 1050, 199999]) {
                expect(centsFromAmount(amountFromCents(cents))).toBe(cents);
            }

            expect(amountFromCents(null)).toBe('');
        });

        it('reads a percentage as basis points', function () {
            expect(bpsFromPercent('75')).toBe(7500);
            expect(bpsFromPercent('7.5')).toBe(750);
            expect(bpsFromPercent('12.34')).toBe(1234);
            expect(bpsFromPercent('100')).toBe(10000);
        });

        it('writes basis points back without trailing noise', function () {
            expect(percentFromBps(7500)).toBe('75');
            expect(percentFromBps(750)).toBe('7.5');
            expect(percentFromBps(1234)).toBe('12.34');
            expect(percentFromBps(null)).toBe('');
        });
    });

    describe('naming a place', function () {
        it('gets the ordinals right, including the teens', function () {
            expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
                '1st',
                '2nd',
                '3rd',
                '4th',
                '11th',
                '12th',
                '13th',
                '21st',
                '22nd',
                '23rd',
                '101st',
                '111th'
            ]);
        });
    });

    /**
     * What the event page actually renders. Before the event settles a row is
     * a PLACE; afterwards it is a PERSON, and the two lists are different
     * shapes for a reason worth pinning down.
     */
    describe('the rows the page shows', function () {
        const entrants = (...ranks) => ranks.map((rank, index) => player(index + 1, rank));

        it('is places and amounts while the event is still running', function () {
            const table = prizeRows({
                entryFeeCents: 1000,
                splits: splits([1, 7500], [2, 2000]),
                players: entrants(null, null, null, null),
                finished: false
            });

            expect(table.settled).toBe(false);
            expect(table.rows).toEqual([
                { rank: 1, bps: 7500, amountCents: 3000 },
                { rank: 2, bps: 2000, amountCents: 800 }
            ]);
            // $40 pot, $38 handed out, $2 retained by the organizer.
            expect(table.poolCents).toBe(4000);
            expect(table.retainedCents).toBe(200);
        });

        it('is people and amounts once it has settled', function () {
            const table = prizeRows({
                entryFeeCents: 1000,
                splits: splits([1, 7500], [2, 2000]),
                players: entrants(1, 2, 3, 4),
                finished: true
            });

            expect(table.settled).toBe(true);
            expect(table.rows).toHaveLength(2);
            expect(table.rows[0].winners.map((winner) => winner.username)).toEqual(['user1']);
            expect(table.rows[0].winners[0].amountCents).toBe(3000);
            expect(table.rows[1].winners[0].amountCents).toBe(800);
        });

        /**
         * THE BUG THIS EXISTS TO PREVENT. Two players tied for 1st take the
         * 1st and 2nd prizes between them - 95% of a $40 pot, $19 each. If the
         * page went on rendering the promised table alongside them it would
         * also print "2nd ... $8.00" against an empty place, and $46 of prizes
         * would be listed out of a $40 pot in front of four people who paid in.
         */
        it('does not print a prize twice when a placing is shared', function () {
            const table = prizeRows({
                entryFeeCents: 1000,
                splits: splits([1, 7500], [2, 2000]),
                players: [player(1, 1), player(2, 1), player(3, 3), player(4, 3)],
                finished: true
            });

            expect(table.rows).toHaveLength(1);
            expect(table.rows[0].rank).toBe(1);
            expect(table.rows[0].winners.map((winner) => winner.amountCents)).toEqual([1900, 1900]);

            // And the totals still reconcile: nothing is paid, retained or
            // unclaimed twice.
            const paid = table.rows
                .flatMap((row) => row.winners)
                .reduce((sum, winner) => sum + winner.amountCents, 0);

            expect(paid + table.retainedCents + table.unallocatedCents).toBe(table.poolCents);
        });

        it('names a prize nobody reached rather than quietly keeping it', function () {
            const table = prizeRows({
                entryFeeCents: 1000,
                splits: splits([1, 5000], [2, 3000], [3, 2000]),
                players: [player(1, 1), player(2, 2)],
                finished: true
            });

            // $20 pot: 1st takes $10, 2nd takes $6, and the $4 third prize has
            // nobody to go to in a two-player event.
            expect(table.unallocatedCents).toBe(400);
            expect(table.rows).toHaveLength(2);
        });

        it('has nothing to show for a free event', function () {
            const table = prizeRows({
                entryFeeCents: 0,
                splits: splits([1, 10000]),
                players: entrants(1, 2),
                finished: true
            });

            expect(table.rows).toEqual([]);
            expect(table.poolCents).toBe(0);
        });
    });

    describe('the presets', function () {
        // A preset that over-allocates would be a prize table the server
        // refuses, offered to the organizer as a one-click option.
        it('never hand out more than the pot', function () {
            for (const preset of PRIZE_PRESETS) {
                if (!preset.splits) {
                    continue;
                }

                const total = preset.splits.reduce((sum, split) => sum + split.bps, 0);

                expect(total, preset.label).toBeLessThanOrEqual(10000);
            }
        });

        it('recognises its own tables so an edit reopens on the right one', function () {
            for (const preset of PRIZE_PRESETS) {
                if (preset.splits && preset.splits.length > 0) {
                    expect(presetIdFor(preset.splits)).toBe(preset.id);
                }
            }

            expect(presetIdFor([{ rank: 1, bps: 4200 }])).toBe('custom');
            expect(presetIdFor([])).toBe('none');
            expect(presetIdFor(null)).toBe('none');
        });
    });
});
