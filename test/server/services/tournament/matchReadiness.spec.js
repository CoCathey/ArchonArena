const TournamentService = require('../../../../server/services/tournament/TournamentService');

/**
 * ARCHON: a match missing from "matches needing games" is not necessarily over.
 *
 * It can be decided, out of the current round, or open and waiting on the
 * players - a Triad pick, the chain bid before game three. The lobby read
 * every absence as "decided" and told two players at 1-1 that their match was
 * over. describeMatchReadiness draws the distinction, and ensureGameForMatch
 * uses it to say why nothing opened instead of claiming success.
 */
describe('match readiness', function () {
    let service;
    let db;
    let tournament;
    let match;

    beforeEach(function () {
        tournament = {
            Id: 1,
            Status: 'active',
            CurrentRound: 2,
            Mode: 'online',
            Triad: false,
            AdaptiveBo3: false
        };
        match = {
            Id: 3,
            TournamentId: 1,
            Round: 2,
            Player1Id: 1,
            Player2Id: 2,
            Player1Wins: 0,
            Player2Wins: 0,
            WinnerId: null,
            ResultType: null,
            P1DeckId: null,
            P2DeckId: null,
            AdaptiveState: null
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

        service = new TournamentService(db, { settingsService: { getSection: () => ({}) } });
    });

    describe('describeMatchReadiness', function () {
        it('is ready for an ordinary open match', async function () {
            expect(await service.describeMatchReadiness(1, 3)).toEqual({ state: 'ready' });
        });

        it('is complete once the match has a result', async function () {
            match.WinnerId = 1;

            const readiness = await service.describeMatchReadiness(1, 3);

            expect(readiness.state).toBe('complete');
            expect(readiness.message).toMatch(/already has a result/);
        });

        it('is complete when the round has moved on', async function () {
            match.Round = 1;

            expect((await service.describeMatchReadiness(1, 3)).state).toBe('complete');
        });

        it('is complete when the event is not running', async function () {
            tournament.Status = 'complete';

            expect((await service.describeMatchReadiness(1, 3)).state).toBe('complete');
        });

        it('is blocked on a Triad pick, and says so', async function () {
            tournament.Triad = true;
            match.P1DeckId = 41;

            const readiness = await service.describeMatchReadiness(1, 3);

            expect(readiness.state).toBe('blocked');
            expect(readiness.message).toMatch(/Triad/);
        });

        it('is ready once both Triad picks are in', async function () {
            tournament.Triad = true;
            match.P1DeckId = 41;
            match.P2DeckId = 42;

            expect((await service.describeMatchReadiness(1, 3)).state).toBe('ready');
        });

        it('is blocked on the chain bid before Adaptive game three', async function () {
            tournament.AdaptiveBo3 = true;
            match.Player1Wins = 1;
            match.Player2Wins = 1;

            const readiness = await service.describeMatchReadiness(1, 3);

            expect(readiness.state).toBe('blocked');
            expect(readiness.message).toMatch(/chain bid/);
        });

        it('is ready for Adaptive game three once the bid is settled', async function () {
            tournament.AdaptiveBo3 = true;
            match.Player1Wins = 1;
            match.Player2Wins = 1;
            match.AdaptiveState = JSON.stringify({ resolved: true });

            expect((await service.describeMatchReadiness(1, 3)).state).toBe('ready');
        });

        it('does not treat Adaptive game two as waiting on a bid', async function () {
            tournament.AdaptiveBo3 = true;
            match.Player1Wins = 1;

            expect((await service.describeMatchReadiness(1, 3)).state).toBe('ready');
        });
    });

    describe('the series score carried to the table', function () {
        it('names each seat’s wins so the engine knows a decided series', async function () {
            tournament.GameFormat = 'archon';
            tournament.BestOf = 3;
            match.BestOf = 3;
            match.Player1Wins = 1;
            match.Player2Wins = 0;

            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "Tournaments"')) {
                    return [tournament];
                }

                if (sql.includes('FROM "TournamentMatchGames"')) {
                    return [];
                }

                if (sql.includes('FROM "TournamentMatches"')) {
                    return [match];
                }

                if (sql.includes('FROM "TournamentPlayers"')) {
                    return [
                        { UserId: 1, Username: 'alice', DeckId: null },
                        { UserId: 2, Username: 'bob', DeckId: null }
                    ];
                }

                return [];
            });

            const [info] = await service.getMatchesNeedingGames(1);

            expect(info.gameNumber).toBe(2);
            expect(info.wins).toEqual({ alice: 1, bob: 0 });
        });
    });

    describe('what the player is told when no table opens', function () {
        it('gives the blocker as the reason', async function () {
            tournament.Triad = true;
            tournament.Mode = 'online';

            const tournamentEvents = require('../../../../server/services/tournament/tournamentEvents');
            // The lobby answering "nothing to open".
            const listener = async () => null;
            tournamentEvents.on('ensureMatchGame', listener);

            try {
                const result = await service.ensureGameForMatch(1, 3, { id: 1 });

                expect(result.success).toBe(false);
                expect(result.message).toMatch(/Triad/);
            } finally {
                tournamentEvents.removeListener('ensureMatchGame', listener);
            }
        });

        it('still reports success when no lobby is listening at all', async function () {
            const result = await service.ensureGameForMatch(1, 3, { id: 1 });

            expect(result).toEqual({ success: true });
        });
    });

    describe('what a player has to do about a schedule', function () {
        const row = (overrides) => ({
            ScheduledAt: null,
            ProposedTime: null,
            ProposedBy: null,
            TheirOffer: false,
            ...overrides
        });

        it('says respond when the other player has an offer on the table, whoever offered soonest', function () {
            // I offered the soonest time; they offered a later one. ProposedBy
            // names me, and the old rule called that "waiting".
            expect(
                service.scheduleActionFor(
                    row({ ProposedTime: '2026-08-20 19:00:00', ProposedBy: 1, TheirOffer: true }),
                    1
                )
            ).toBe('respond');
        });

        it('says waiting when every live offer is mine', function () {
            expect(
                service.scheduleActionFor(
                    row({ ProposedTime: '2026-08-20 19:00:00', ProposedBy: 1, TheirOffer: false }),
                    1
                )
            ).toBe('waiting');
        });

        it('says play when a time is agreed and propose when nothing is', function () {
            expect(service.scheduleActionFor(row({ ScheduledAt: '2026-08-20 19:00:00' }), 1)).toBe(
                'play'
            );
            expect(service.scheduleActionFor(row(), 1)).toBe('propose');
        });

        it('falls back to the soonest offer’s proposer on an older row shape', function () {
            expect(
                service.scheduleActionFor(
                    { ProposedTime: '2026-08-20 19:00:00', ProposedBy: 2, ScheduledAt: null },
                    1
                )
            ).toBe('respond');
            expect(
                service.scheduleActionFor(
                    { ProposedTime: '2026-08-20 19:00:00', ProposedBy: 1, ScheduledAt: null },
                    1
                )
            ).toBe('waiting');
        });
    });
});
