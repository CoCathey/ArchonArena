const TournamentService = require('../../../../server/services/tournament/TournamentService');
const tournamentEvents = require('../../../../server/services/tournament/tournamentEvents');

/**
 * ARCHON: offering a WINDOW of time rather than an instant.
 *
 * "Any time Thursday evening" used to be five separate offers or a note nobody
 * could act on. An offer can now carry an end; the other player accepts it by
 * naming a time inside it, and everything downstream still sees one agreed
 * instant. These hold the service against a fake of the slots table that
 * implements the same ON CONFLICT rule the real one does.
 */
describe('match time windows', function () {
    let service;
    let db;
    let slots;
    let tournament;
    let match;
    let emitted;

    const alice = { id: 1, username: 'alice' };
    const bob = { id: 2, username: 'bob' };

    const hours = (count) => count * 60 * 60 * 1000;
    // Anchored once per test, so two calls with the same offset name the same
    // instant however long the test takes between them.
    let base;
    const at = (hoursFromNow) => new Date(base + hours(hoursFromNow)).toISOString();

    beforeEach(function () {
        base = Date.now();
        emitted = [];
        slots = [];
        tournament = {
            Id: 1,
            Name: 'Async League',
            Status: 'active',
            OrganizerId: 9,
            Mode: 'online',
            Pacing: 'async',
            CurrentRound: 1,
            BestOf: 1,
            RoundEndsAt: null
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
            query: vi.fn().mockImplementation(async (sql, params = []) => {
                if (sql.includes('INSERT INTO "TournamentMatchTimeSlots"')) {
                    const [, proposedBy, slotTime, zone, slotEnd] = params;
                    const existing = slots.find((slot) => slot.SlotTime === slotTime);

                    if (existing) {
                        // GREATEST(existing, excluded), NULLs ignored - the
                        // rule the real constraint applies.
                        const ends = [existing.SlotEnd, slotEnd].filter(Boolean).sort();

                        existing.SlotEnd = ends.length ? ends[ends.length - 1] : null;
                    } else {
                        slots.push({
                            Id: slots.length + 1,
                            MatchId: match.Id,
                            SlotTime: slotTime,
                            SlotEnd: slotEnd || null,
                            ProposedBy: proposedBy,
                            ProposerZone: zone,
                            Username: `user${proposedBy}`
                        });
                    }

                    return [];
                }

                if (sql.startsWith('DELETE FROM "TournamentMatchTimeSlots"')) {
                    if (sql.includes('"Id" = $1')) {
                        const index = slots.findIndex((slot) => slot.Id === params[0]);

                        if (index === -1) {
                            return [];
                        }

                        const [removed] = slots.splice(index, 1);

                        return [removed];
                    }

                    slots = [];

                    return [];
                }

                if (sql.includes('FROM "TournamentMatchTimeSlots"')) {
                    return [...slots].sort((a, b) =>
                        String(a.SlotTime).localeCompare(String(b.SlotTime))
                    );
                }

                if (sql.includes('"ProposedTime" = s."SlotTime"')) {
                    const soonest = [...slots].sort((a, b) =>
                        String(a.SlotTime).localeCompare(String(b.SlotTime))
                    )[0];

                    if (soonest) {
                        match.ProposedTime = soonest.SlotTime;
                        match.ProposedBy = soonest.ProposedBy;
                    }

                    return [];
                }

                if (sql.includes('SET "ProposedTime" = NULL, "ProposedBy" = NULL WHERE')) {
                    if (slots.length === 0) {
                        match.ProposedTime = null;
                        match.ProposedBy = null;
                    }

                    return [];
                }

                if (sql.includes('SET "ScheduledAt" = $2')) {
                    match.ScheduledAt = params[1];
                    match.ProposedTime = null;
                    match.ProposedBy = null;

                    return [];
                }

                if (sql.includes('SET "ScheduleNote"')) {
                    match.ScheduleNote = params[1];

                    return [];
                }

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

        for (const event of ['matchTimeProposed', 'matchTimeAccepted']) {
            tournamentEvents.on(event, (payload) => emitted.push({ event, ...payload }));
        }
    });

    afterEach(function () {
        tournamentEvents.removeAllListeners('matchTimeProposed');
        tournamentEvents.removeAllListeners('matchTimeAccepted');
    });

    describe('offering a window', function () {
        it('stores the start and the end, and lists both', async function () {
            const result = await service.proposeMatchTime(
                1,
                3,
                alice,
                at(24),
                null,
                'America/Chicago',
                at(27)
            );

            expect(result.success, result.message).toBe(true);

            const [offer] = await service.getTimeSlots(3);

            expect(offer.time).toBe(at(24));
            expect(offer.end).toBeTruthy();
            expect(new Date(offer.end).getTime() - new Date(offer.time).getTime()).toBe(hours(3));
        });

        it('tells the other player it is a window', async function () {
            await service.proposeMatchTime(1, 3, alice, at(24), 'evening works', null, at(27));

            const [event] = emitted;

            expect(event.event).toBe('matchTimeProposed');
            expect(event.endTime).toBeTruthy();
            expect(new Date(event.endTime).getTime() - new Date(event.time).getTime()).toBe(
                hours(3)
            );
            expect(event.note).toBe('evening works');
        });

        it('leaves a single time with no end, as before', async function () {
            await service.proposeMatchTime(1, 3, alice, at(24));

            const [offer] = await service.getTimeSlots(3);

            expect(offer.end).toBeNull();
            expect(emitted[0].endTime).toBeNull();
        });

        it('refuses a window that ends before it starts', async function () {
            const result = await service.proposeMatchTime(1, 3, alice, at(27), null, null, at(24));

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/end after it starts/);
            expect(slots).toHaveLength(0);
        });

        it('refuses an end that is not a time at all', async function () {
            const result = await service.proposeMatchTime(
                1,
                3,
                alice,
                at(24),
                null,
                null,
                'whenever'
            );

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/valid end time/);
        });

        it('refuses a window longer than a week', async function () {
            const result = await service.proposeMatchTime(
                1,
                3,
                alice,
                at(24),
                null,
                null,
                at(24 + 8 * 24)
            );

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/at most 7 days/);
        });

        it('holds the whole window inside the round deadline, not just its start', async function () {
            tournament.RoundEndsAt = at(26);

            const result = await service.proposeMatchTime(
                1,
                3,
                alice,
                at(24),
                null,
                'America/Chicago',
                at(28)
            );

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/This round ends/);
            // In the proposer's zone, not UTC: Chicago is on daylight or
            // standard time, and the label says which.
            expect(result.message).toMatch(/C[DS]T/);
            expect(result.message).not.toMatch(/UTC/);
        });

        it('widens an existing offer when the same start is offered with a later end', async function () {
            await service.proposeMatchTime(1, 3, alice, at(24), null, null, at(26));
            await service.proposeMatchTime(1, 3, bob, at(24), null, null, at(28));

            const offers = await service.getTimeSlots(3);

            expect(offers).toHaveLength(1);
            expect(new Date(offers[0].end).getTime() - new Date(offers[0].time).getTime()).toBe(
                hours(4)
            );
        });
    });

    describe('accepting a window', function () {
        beforeEach(async function () {
            await service.proposeMatchTime(1, 3, alice, at(24), null, null, at(27));
        });

        it('books the time the other player names inside it', async function () {
            const [offer] = await service.getTimeSlots(3);
            const chosen = at(25.5);

            const result = await service.acceptMatchTime(1, 3, bob, offer.id, chosen);

            expect(result.success, result.message).toBe(true);
            expect(new Date(match.ScheduledAt).getTime()).toBe(new Date(chosen).getTime());
            expect(slots).toHaveLength(0);

            const accepted = emitted.find((event) => event.event === 'matchTimeAccepted');

            expect(new Date(accepted.time).getTime()).toBe(new Date(chosen).getTime());
        });

        it('books the start when no time is named', async function () {
            const [offer] = await service.getTimeSlots(3);

            const result = await service.acceptMatchTime(1, 3, bob, offer.id);

            expect(result.success).toBe(true);
            expect(new Date(match.ScheduledAt).getTime()).toBe(new Date(at(24)).getTime());
        });

        it('refuses a time outside the window and keeps the offer', async function () {
            const [offer] = await service.getTimeSlots(3);

            const result = await service.acceptMatchTime(1, 3, bob, offer.id, at(30));

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/inside the offered window/);
            expect(slots).toHaveLength(1);
            expect(match.ScheduledAt).toBeNull();
        });

        it('refuses a time that is not a time', async function () {
            const [offer] = await service.getTimeSlots(3);

            const result = await service.acceptMatchTime(1, 3, bob, offer.id, 'eightish');

            expect(result.success).toBe(false);
            expect(slots).toHaveLength(1);
        });

        it('still lets only the other player accept', async function () {
            const [offer] = await service.getTimeSlots(3);

            const result = await service.acceptMatchTime(1, 3, alice, offer.id, at(25));

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/other player/);
        });
    });

    describe('accepting a single time', function () {
        it('is unchanged when no time is named', async function () {
            await service.proposeMatchTime(1, 3, alice, at(24));

            const result = await service.acceptMatchTime(1, 3, bob);

            expect(result.success).toBe(true);
            expect(new Date(match.ScheduledAt).getTime()).toBe(new Date(at(24)).getTime());
        });

        it('refuses a different time than the one offered', async function () {
            await service.proposeMatchTime(1, 3, alice, at(24));
            const [offer] = await service.getTimeSlots(3);

            const result = await service.acceptMatchTime(1, 3, bob, offer.id, at(25));

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/accept it as offered/);
            expect(slots).toHaveLength(1);
        });

        it('accepts the offered time when it is named exactly', async function () {
            await service.proposeMatchTime(1, 3, alice, at(24));
            const [offer] = await service.getTimeSlots(3);

            const result = await service.acceptMatchTime(1, 3, bob, offer.id, at(24));

            expect(result.success, result.message).toBe(true);
        });
    });
});
