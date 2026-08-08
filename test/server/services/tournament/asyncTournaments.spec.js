const TournamentService = require('../../../../server/services/tournament/TournamentService');
const tournamentEvents = require('../../../../server/services/tournament/tournamentEvents');

/**
 * ARCHON (N14): asynchronous tournaments - rounds paced in days, with the two
 * players of each match agreeing between themselves when to play it.
 *
 * The load-bearing properties: an async event's round clock is days rather
 * than minutes, it does not park a lobby table per pairing, only the two
 * players may schedule their match, a counter-proposal replaces the live
 * offer, accepting consumes the exact offer it read, and a passed deadline is
 * announced once and decides nothing by itself.
 */
describe('Asynchronous tournaments', function () {
    let service;
    let db;
    let tournament;
    let match;
    let emitted;

    const alice = { id: 1, username: 'alice' };
    const bob = { id: 2, username: 'bob' };
    const organizer = { id: 9, username: 'org' };

    const EVENTS = [
        'matchTimeProposed',
        'matchTimeAccepted',
        'matchScheduleCleared',
        'roundDeadlinePassed'
    ];

    beforeEach(function () {
        emitted = [];
        tournament = {
            Id: 1,
            Name: 'Async League',
            Status: 'active',
            OrganizerId: organizer.id,
            Mode: 'online',
            Pacing: 'async',
            RoundDeadlineDays: 3,
            CurrentRound: 1,
            BestOf: 1
        };
        match = {
            Id: 3,
            TournamentId: 1,
            Round: 1,
            Player1Id: alice.id,
            Player2Id: bob.id,
            BestOf: 1,
            Player1Wins: 0,
            Player2Wins: 0,
            ScheduledAt: null,
            ProposedTime: null,
            ProposedBy: null,
            ScheduleNote: null
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

        for (const event of EVENTS) {
            tournamentEvents.on(event, (payload) => emitted.push({ event, payload }));
        }
    });

    afterEach(function () {
        // The emitter is process-wide; listeners left behind would make every
        // later case fire the previous ones too.
        for (const event of EVENTS) {
            tournamentEvents.removeAllListeners(event);
        }
    });

    const soon = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const updateFor = (fragment) => db.query.mock.calls.find(([sql]) => sql.includes(fragment));

    describe('creating an event', function () {
        it('paces an async event in days and a live one in minutes', function () {
            const config = service.getConfig();

            const async = service.parseEventOptions(
                { name: 'League', format: 'swiss', pacing: 'async', roundDeadlineDays: 5 },
                config
            );
            expect(async.errors).toEqual([]);
            expect(async.values.pacing).toBe('async');
            expect(async.values.roundDeadlineDays).toBe(5);

            // A live event never carries a day deadline, even if one is sent -
            // its clock is the minutes timer.
            const live = service.parseEventOptions(
                { name: 'Live', format: 'swiss', pacing: 'live', roundDeadlineDays: 5 },
                config
            );
            expect(live.values.pacing).toBe('live');
            expect(live.values.roundDeadlineDays).toBeNull();
        });

        it('gives an async event a deadline even when none was chosen', function () {
            const { values } = service.parseEventOptions(
                { name: 'League', format: 'swiss', pacing: 'async' },
                service.getConfig()
            );

            expect(values.roundDeadlineDays).toBe(3);
        });

        it('rejects an unknown pacing and an out-of-range deadline', function () {
            const config = service.getConfig();

            expect(
                service.parseEventOptions(
                    { name: 'League', format: 'swiss', pacing: 'whenever' },
                    config
                ).errors
            ).toContain('Unknown pacing');

            expect(
                service
                    .parseEventOptions(
                        { name: 'League', format: 'swiss', pacing: 'async', roundDeadlineDays: 99 },
                        config
                    )
                    .errors.join(' ')
            ).toMatch(/between 1 and 30 days/);
        });
    });

    describe('proposing a time', function () {
        it('stores the offer and tells the opponent', async function () {
            const time = soon();

            const result = await service.proposeMatchTime(1, 3, alice, time, 'after work?');

            expect(result.success).toBe(true);

            const [, params] = updateFor('"ProposedTime" = $2');
            expect(new Date(params[1]).toISOString()).toBe(new Date(time).toISOString());
            expect(params[2]).toBe(alice.id);
            expect(params[3]).toBe('after work?');

            const event = emitted.find((entry) => entry.event === 'matchTimeProposed');
            expect(event.payload.byUserId).toBe(alice.id);
            expect(event.payload.player2Id).toBe(bob.id);
        });

        it('refuses a time that is not a time, is past, or is absurdly far off', async function () {
            expect((await service.proposeMatchTime(1, 3, alice, 'soonish')).success).toBe(false);
            expect(
                (await service.proposeMatchTime(1, 3, alice, new Date(Date.now() - 86400000)))
                    .success
            ).toBe(false);
            expect(
                (
                    await service.proposeMatchTime(
                        1,
                        3,
                        alice,
                        new Date(Date.now() + 200 * 86400000).toISOString()
                    )
                ).success
            ).toBe(false);
            expect(updateFor('"ProposedTime" = $2')).toBeUndefined();
        });

        // Scheduling is the players' business. The organizer has judge tools
        // for the match; they do not get to book other people's evenings.
        it('refuses anyone who is not one of the two players', async function () {
            const result = await service.proposeMatchTime(1, 3, organizer, soon());

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/only the players/i);
        });

        it('refuses a match that is already decided', async function () {
            match.WinnerId = alice.id;

            const result = await service.proposeMatchTime(1, 3, alice, soon());

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/already has a result/i);
        });

        it('refuses a bracket slot that does not have both players yet', async function () {
            match.Player2Id = null;

            expect((await service.proposeMatchTime(1, 3, alice, soon())).success).toBe(false);
        });

        it('truncates a note rather than storing an essay', async function () {
            await service.proposeMatchTime(1, 3, alice, soon(), 'x'.repeat(500));

            const [, params] = updateFor('"ProposedTime" = $2');
            expect(params[3]).toHaveLength(280);
        });
    });

    describe('answering a proposal', function () {
        beforeEach(function () {
            match.ProposedTime = new Date(Date.now() + 86400000);
            match.ProposedBy = alice.id;
        });

        it('turns the offer into the agreed time', async function () {
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "Tournaments"')) {
                    return [tournament];
                }
                if (sql.includes('RETURNING "ScheduledAt"')) {
                    return [{ ScheduledAt: match.ProposedTime }];
                }
                if (sql.includes('FROM "TournamentMatches"')) {
                    return [match];
                }

                return [];
            });

            const result = await service.acceptMatchTime(1, 3, bob);

            expect(result.success).toBe(true);
            expect(emitted.some((entry) => entry.event === 'matchTimeAccepted')).toBe(true);
        });

        it('will not let the proposer accept their own offer', async function () {
            const result = await service.acceptMatchTime(1, 3, alice);

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/other player/i);
        });

        it('says so when there is nothing to accept', async function () {
            match.ProposedTime = null;
            match.ProposedBy = null;

            expect((await service.acceptMatchTime(1, 3, bob)).success).toBe(false);
        });

        // The accept must consume the exact offer it read. A counter-proposal
        // landing in between means the acceptor is agreeing to a time they
        // never saw, so the write matches on the old offer and finds nothing.
        it('does not agree to a proposal that changed underneath it', async function () {
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "Tournaments"')) {
                    return [tournament];
                }
                if (sql.includes('RETURNING "ScheduledAt"')) {
                    return []; // the guarded UPDATE matched nothing
                }
                if (sql.includes('FROM "TournamentMatches"')) {
                    return [match];
                }

                return [];
            });

            const result = await service.acceptMatchTime(1, 3, bob);

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/changed while you were looking/i);
        });

        it('clears an offer or an agreed time for either player', async function () {
            const result = await service.clearMatchSchedule(1, 3, bob);

            expect(result.success).toBe(true);
            expect(updateFor('"ScheduledAt" = NULL')).toBeDefined();
            expect(emitted.some((entry) => entry.event === 'matchScheduleCleared')).toBe(true);
        });
    });

    describe('lobby tables', function () {
        beforeEach(function () {
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "Tournaments"')) {
                    return [tournament];
                }

                return [];
            });
        });

        // A table opened when the round is paired would sit empty for days.
        it('does not open a table per pairing in an async event', async function () {
            expect(await service.getMatchesNeedingGames(1, { forPairing: true })).toEqual([]);
        });

        it("still opens live events' tables at pairing time", async function () {
            tournament.Pacing = 'live';

            // Reaches the real query path rather than returning early.
            await service.getMatchesNeedingGames(1, { forPairing: true });

            expect(
                db.query.mock.calls.some(([sql]) => sql.includes('FROM "TournamentMatches"'))
            ).toBe(true);
        });
    });

    describe('the deadline sweep', function () {
        const overdue = {
            Id: 1,
            Name: 'Async League',
            OrganizerId: organizer.id,
            CurrentRound: 1,
            RoundEndsAt: new Date(Date.now() - 3600000)
        };

        it('announces a passed deadline once, with what is still open', async function () {
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('SELECT "Id" FROM "Tournaments"')) {
                    return [{ Id: 1 }];
                }
                if (sql.includes('"DeadlineNotifiedAt" = now()')) {
                    return [overdue];
                }
                if (sql.includes('FROM "TournamentMatches"')) {
                    return [match];
                }

                return [];
            });

            const result = await service.sweepRoundDeadlines();

            expect(result.notified).toBe(1);

            const event = emitted.find((entry) => entry.event === 'roundDeadlinePassed');
            expect(event.payload.organizerId).toBe(organizer.id);
            expect(event.payload.openMatches).toHaveLength(1);
            expect(event.payload.openMatches[0].matchId).toBe(match.Id);
        });

        // Several lobby instances run this sweep. The marker write is the
        // claim, so only the one that flips it announces.
        it('stays silent when another instance claimed the event first', async function () {
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('SELECT "Id" FROM "Tournaments"')) {
                    return [{ Id: 1 }];
                }
                if (sql.includes('"DeadlineNotifiedAt" = now()')) {
                    return []; // somebody else got there
                }

                return [];
            });

            expect(await service.sweepRoundDeadlines()).toEqual({ notified: 0 });
            expect(emitted).toHaveLength(0);
        });

        it('never throws when the scan fails', async function () {
            db.query.mockRejectedValue(new Error('db down'));

            await expect(service.sweepRoundDeadlines()).resolves.toEqual({ notified: 0 });
        });

        // A deadline is the organizer's cue, not a verdict: an automatic
        // forfeit cannot know which player ghosted whom.
        it('decides nothing by itself', async function () {
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('SELECT "Id" FROM "Tournaments"')) {
                    return [{ Id: 1 }];
                }
                if (sql.includes('"DeadlineNotifiedAt" = now()')) {
                    return [overdue];
                }
                if (sql.includes('FROM "TournamentMatches"')) {
                    return [match];
                }

                return [];
            });

            await service.sweepRoundDeadlines();

            expect(
                db.query.mock.calls.some(([sql]) =>
                    sql.includes('UPDATE "TournamentMatches" SET "WinnerId"')
                )
            ).toBe(false);
        });
    });

    describe('the round clock', function () {
        // Every path that opens a round - start, nextRound, the playoff cut -
        // sets the deadline through one shared expression. This asserts on the
        // SQL that actually reaches the database, which is the real contract:
        // an async round is measured in days, a live one in minutes, and both
        // branches have to be present or one pacing silently loses its clock.
        const clockSqlFrom = (calls) =>
            calls.map(([sql]) => sql).find((sql) => sql.includes('"RoundEndsAt" = CASE'));

        it('knows both pacings wherever a round opens', async function () {
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "Tournaments"')) {
                    return [{ ...tournament, Status: 'registration', Format: 'swiss' }];
                }
                if (sql.includes('FROM "TournamentPlayers"')) {
                    return [
                        { UserId: alice.id, Username: 'alice', Seed: 1 },
                        { UserId: bob.id, Username: 'bob', Seed: 2 }
                    ];
                }

                return [];
            });

            await service.start(1, organizer);

            const sql = clockSqlFrom(db.query.mock.calls);

            expect(sql).toBeDefined();
            expect(sql).toContain('"Pacing" = \'async\'');
            expect(sql).toContain('"RoundDeadlineDays" * interval \'1 day\'');
            expect(sql).toContain('"RoundTimerMinutes" * interval \'1 minute\'');
            // A fresh round is a fresh deadline, so the overdue notice re-arms.
            expect(sql).toContain('"DeadlineNotifiedAt" = NULL');
        });

        // A moved deadline is a new deadline: if it passes too, that is worth
        // saying again.
        it('re-arms the overdue notice when the deadline moves', async function () {
            await service.adjustRoundClock(1, organizer, 24 * 60);

            const [sql] = updateFor('"RoundEndsAt" =');
            expect(sql).toContain('"DeadlineNotifiedAt" = NULL');
        });
    });

    describe('what a player owes across events', function () {
        it('says what each open match is waiting on', async function () {
            const now = new Date();
            db.query.mockResolvedValue([
                {
                    Id: 10,
                    Round: 1,
                    TournamentId: 1,
                    TournamentName: 'League',
                    Pacing: 'async',
                    Mode: 'online',
                    BestOf: 1,
                    Player1Id: alice.id,
                    Player2Id: bob.id,
                    OpponentId: bob.id,
                    OpponentName: 'bob',
                    ScheduledAt: null,
                    ProposedTime: null,
                    ProposedBy: null,
                    RoundEndsAt: now
                },
                {
                    Id: 11,
                    Round: 1,
                    TournamentId: 2,
                    TournamentName: 'Other',
                    Pacing: 'async',
                    Mode: 'online',
                    BestOf: 3,
                    Player1Id: alice.id,
                    Player2Id: 5,
                    OpponentId: 5,
                    OpponentName: 'carol',
                    ScheduledAt: null,
                    ProposedTime: now,
                    ProposedBy: 5,
                    RoundEndsAt: now
                },
                {
                    Id: 12,
                    Round: 2,
                    TournamentId: 3,
                    TournamentName: 'Third',
                    Pacing: 'async',
                    Mode: 'online',
                    BestOf: 1,
                    Player1Id: alice.id,
                    Player2Id: 6,
                    OpponentId: 6,
                    OpponentName: 'dan',
                    ScheduledAt: null,
                    ProposedTime: now,
                    ProposedBy: alice.id,
                    RoundEndsAt: now
                },
                {
                    Id: 13,
                    Round: 1,
                    TournamentId: 4,
                    TournamentName: 'Fourth',
                    Pacing: 'async',
                    Mode: 'online',
                    BestOf: 1,
                    Player1Id: alice.id,
                    Player2Id: 7,
                    OpponentId: 7,
                    OpponentName: 'erin',
                    ScheduledAt: now,
                    ProposedTime: null,
                    ProposedBy: null,
                    RoundEndsAt: now
                }
            ]);

            const mine = await service.myOpenMatches(alice);

            expect(mine.map((entry) => entry.needsAction)).toEqual([
                'propose',
                'respond',
                'waiting',
                'play'
            ]);
            expect(mine[1].opponent).toBe('carol');
        });

        it('is empty for a signed-out visitor', async function () {
            expect(await service.myOpenMatches(null)).toEqual([]);
        });
    });
});
