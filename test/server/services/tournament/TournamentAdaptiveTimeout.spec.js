const TournamentService = require('../../../../server/services/tournament/TournamentService');

/**
 * ARCHON (N9): the Adaptive Bo3 chain bid had no clock and no way out.
 *
 * `AdaptiveState` recorded WHO was on the clock (`turnUserId`) but never WHEN
 * their turn began, and no code path could settle the auction without one of
 * the two players acting. A pair who neither bid nor passed - one asleep, one
 * gone home, both waiting for the other to open - held game three, and with it
 * their round, open indefinitely. The organizer could take a paper result,
 * which is why this was a defect and not a blocker, but nothing in the engine
 * could move.
 *
 * The rule the clock enforces is the one already written: running out of time
 * IS a pass by the player on the clock. Nothing new is invented, so an expired
 * auction settles exactly where an attentive one would have - the standing
 * high bidder takes the deck at their bid, and if nobody has bid at all the
 * opening player concedes it at zero, which is what `adaptivePass` has always
 * done for a player who refuses to open.
 */
describe('Adaptive Bo3 bid timeout', function () {
    let service;
    let db;
    let tournament;
    let match;
    let timeoutMinutes;

    const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000).toISOString();

    beforeEach(function () {
        timeoutMinutes = 10;
        tournament = {
            Id: 1,
            Status: 'active',
            OrganizerId: 9,
            Mode: 'online',
            AdaptiveBo3: true,
            BestOf: 3
        };
        match = {
            Id: 3,
            TournamentId: 1,
            Player1Id: 1,
            Player2Id: 2,
            BestOf: 3,
            Player1Wins: 1,
            Player2Wins: 1
        };

        db = {
            query: vi.fn().mockImplementation(async (sql) => {
                if (sql.includes('FROM "Tournaments"')) {
                    return [tournament];
                }

                if (sql.includes('FROM "TournamentMatches"')) {
                    return [match];
                }

                return [];
            })
        };

        service = new TournamentService(db, {
            settingsService: {
                getSection: () => ({ adaptiveBidTimeoutMinutes: timeoutMinutes })
            }
        });
    });

    const savedState = () => {
        const call = db.query.mock.calls
            .filter(([sql]) => sql.includes('SET "AdaptiveState"'))
            .pop();

        return call && JSON.parse(call[1][1]);
    };

    describe('the clock', function () {
        it('starts when the turn passes to a player', async function () {
            await service.adaptiveBid(1, 3, { id: 1 }, 3);

            expect(savedState().turnStartedAt).toEqual(expect.any(String));
        });

        it('restarts for the opponent on every new bid', async function () {
            match.AdaptiveState = {
                bidDeckOwnerId: 1,
                currentBid: 3,
                highBidderId: 1,
                turnUserId: 2,
                turnStartedAt: minutesAgo(4)
            };

            await service.adaptiveBid(1, 3, { id: 2 }, 5);

            expect(Date.parse(savedState().turnStartedAt)).toBeGreaterThan(
                Date.parse(minutesAgo(1))
            );
        });
    });

    describe('when the clock runs out', function () {
        it('settles the auction on the standing high bid', async function () {
            match.AdaptiveState = {
                bidDeckOwnerId: 1,
                currentBid: 4,
                highBidderId: 1,
                turnUserId: 2,
                turnStartedAt: minutesAgo(11)
            };

            const state = await service.getAdaptiveState(1, 3, { id: 1 });

            expect(state.bidding.resolved).toBe(true);
            expect(savedState().chains['1']).toBe(4);
            expect(savedState().chains['2']).toBe(0);
        });

        it('records that it was the clock and not the player', async function () {
            // An organizer looking at a settled auction has to be able to tell
            // a concession from an expiry - they are the same outcome and very
            // different conversations.
            match.AdaptiveState = {
                bidDeckOwnerId: 1,
                currentBid: 4,
                highBidderId: 1,
                turnUserId: 2,
                turnStartedAt: minutesAgo(11)
            };

            await service.getAdaptiveState(1, 3, { id: 1 });

            expect(savedState().resolvedBy).toBe('timeout');
        });

        it('concedes at zero when nobody ever opened', async function () {
            match.AdaptiveState = {
                bidDeckOwnerId: 1,
                currentBid: 0,
                highBidderId: null,
                turnUserId: 1,
                turnStartedAt: minutesAgo(11)
            };

            const state = await service.getAdaptiveState(1, 3, { id: 1 });

            expect(state.bidding.resolved).toBe(true);
            // Player 1 was on the clock, so player 2 takes the nominated deck
            // at zero - exactly what an explicit pass by player 1 does.
            expect(savedState().decks['2']).toBe(1);
            expect(savedState().chains['2']).toBe(0);
        });

        it('refuses a bid that arrives after time', async function () {
            match.AdaptiveState = {
                bidDeckOwnerId: 1,
                currentBid: 4,
                highBidderId: 1,
                turnUserId: 2,
                turnStartedAt: minutesAgo(11)
            };

            const result = await service.adaptiveBid(1, 3, { id: 2 }, 6);

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/already settled|ran out/i);
        });

        it('leaves an auction inside its time alone', async function () {
            match.AdaptiveState = {
                bidDeckOwnerId: 1,
                currentBid: 4,
                highBidderId: 1,
                turnUserId: 2,
                turnStartedAt: minutesAgo(9)
            };

            const state = await service.getAdaptiveState(1, 3, { id: 1 });

            expect(state.bidding.resolved).toBe(false);
            expect(savedState()).toBeUndefined();
        });

        it('never expires when the timeout is switched off', async function () {
            timeoutMinutes = 0;
            match.AdaptiveState = {
                bidDeckOwnerId: 1,
                currentBid: 4,
                highBidderId: 1,
                turnUserId: 2,
                turnStartedAt: minutesAgo(600)
            };

            const state = await service.getAdaptiveState(1, 3, { id: 1 });

            expect(state.bidding.resolved).toBe(false);
        });

        it('does not expire an auction that predates the clock', async function () {
            // A bid opened before this shipped has no turnStartedAt. Treating
            // a missing timestamp as "infinitely old" would settle every one
            // of them the moment the lobby came up.
            match.AdaptiveState = {
                bidDeckOwnerId: 1,
                currentBid: 4,
                highBidderId: 1,
                turnUserId: 2
            };

            const state = await service.getAdaptiveState(1, 3, { id: 1 });

            expect(state.bidding.resolved).toBe(false);
        });
    });

    describe('the organizer force-resolve', function () {
        const organizer = { id: 9 };

        it('settles a stuck auction without waiting for the clock', async function () {
            match.AdaptiveState = {
                bidDeckOwnerId: 1,
                currentBid: 4,
                highBidderId: 1,
                turnUserId: 2,
                turnStartedAt: minutesAgo(1)
            };

            const result = await service.adaptiveForceResolve(1, 3, organizer);

            expect(result.success).toBe(true);
            expect(result.resolved).toBe(true);
            expect(savedState().chains['1']).toBe(4);
            expect(savedState().resolvedBy).toBe('organizer');
        });

        it('settles one where nobody opened', async function () {
            match.AdaptiveState = {
                bidDeckOwnerId: 1,
                currentBid: 0,
                highBidderId: null,
                turnUserId: 1
            };

            const result = await service.adaptiveForceResolve(1, 3, organizer);

            expect(result.success).toBe(true);
            expect(savedState().decks['2']).toBe(1);
        });

        it('is not something a player in the match can do', async function () {
            match.AdaptiveState = {
                bidDeckOwnerId: 1,
                currentBid: 4,
                highBidderId: 1,
                turnUserId: 2
            };

            const result = await service.adaptiveForceResolve(1, 3, { id: 2, permissions: {} });

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/organizer/i);
        });

        it('will not reopen an auction that is already settled', async function () {
            match.AdaptiveState = { resolved: true, currentBid: 4, highBidderId: 1 };

            const result = await service.adaptiveForceResolve(1, 3, organizer);

            expect(result.success).toBe(false);
        });
    });
});
