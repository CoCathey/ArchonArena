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
    let slots;
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

        // ARCHON: an offered time is a ROW now, not a column. Several can be
        // live at once, which is the whole point - a player offers three
        // evenings and the other picks one, instead of a round trip per
        // candidate between two people in different time zones.
        slots = [];

        db = {
            query: vi.fn().mockImplementation(async (sql, params = []) => {
                if (sql.includes('INSERT INTO "TournamentMatchTimeSlots"')) {
                    const [, proposedBy, slotTime, zone] = params;

                    if (!slots.some((slot) => slot.SlotTime === slotTime)) {
                        slots.push({
                            Id: slots.length + 1,
                            MatchId: match.Id,
                            SlotTime: slotTime,
                            ProposedBy: proposedBy,
                            ProposerZone: zone,
                            Username: `user${proposedBy}`
                        });
                    }

                    return [];
                }

                if (sql.startsWith('DELETE FROM "TournamentMatchTimeSlots"')) {
                    if (sql.includes('"Id" = $1')) {
                        // "your own offers are yours to withdraw" is a
                        // condition in the SQL, so the fake has to apply it -
                        // otherwise it agrees that anybody may withdraw
                        // anything.
                        const index = slots.findIndex(
                            (slot) =>
                                slot.Id === params[0] &&
                                (!sql.includes('"ProposedBy" = $3') ||
                                    slot.ProposedBy === params[2])
                        );

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
                    // ORDER BY "SlotTime" - the fake sorts because the service
                    // relies on the order and an unsorted fake would pass
                    // against a query that forgot to.
                    return [...slots].sort((a, b) =>
                        String(a.SlotTime).localeCompare(String(b.SlotTime))
                    );
                }

                // syncProposedTime: the match's columns summarise the rows.
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

                if (
                    sql.includes('"ProposedTime" = NULL, "ProposedBy" = NULL') &&
                    slots.length === 0
                ) {
                    match.ProposedTime = null;
                    match.ProposedBy = null;

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

            const result = await service.proposeMatchTime(
                1,
                3,
                alice,
                time,
                'after work?',
                'America/Chicago'
            );

            expect(result.success).toBe(true);

            const offers = await service.getTimeSlots(3);

            expect(offers).toHaveLength(1);
            expect(new Date(offers[0].time).toISOString()).toBe(new Date(time).toISOString());
            expect(offers[0].proposedById).toBe(alice.id);
            // The zone is advisory and exists for one sentence: "8pm your
            // time, 3am theirs".
            expect(offers[0].zone).toBe('America/Chicago');

            const event = emitted.find((entry) => entry.event === 'matchTimeProposed');
            expect(event.payload.byUserId).toBe(alice.id);
            expect(event.payload.player2Id).toBe(bob.id);
        });

        /**
         * The reason this stopped being one column. A player offers three
         * evenings at once; the other picks one. The old model replaced the
         * live offer each time, which is a round trip per candidate between two
         * people who are usually asleep when the other is awake.
         */
        it('keeps every time offered, soonest first', async function () {
            const day = 24 * 60 * 60 * 1000;
            const thursday = new Date(Date.now() + 3 * day).toISOString();
            const tuesday = new Date(Date.now() + 1 * day).toISOString();
            const wednesday = new Date(Date.now() + 2 * day).toISOString();

            for (const time of [thursday, tuesday, wednesday]) {
                expect((await service.proposeMatchTime(1, 3, alice, time)).success).toBe(true);
            }

            const offers = await service.getTimeSlots(3);

            expect(offers).toHaveLength(3);
            expect(offers.map((offer) => new Date(offer.time).toISOString())).toEqual([
                tuesday,
                wednesday,
                thursday
            ]);
        });

        // Offering a time somebody already offered is agreement, not a second
        // option, and a list that shows it twice reads as a disagreement.
        it('does not list the same time twice', async function () {
            const time = soon();

            await service.proposeMatchTime(1, 3, alice, time);
            await service.proposeMatchTime(1, 3, bob, time);

            expect(await service.getTimeSlots(3)).toHaveLength(1);
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
            expect(await service.getTimeSlots(3)).toHaveLength(0);
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

            const [, params] = updateFor('"ScheduleNote" = $2');
            expect(params[1]).toHaveLength(280);
        });

        // An IANA name or nothing. It is never computed with - the instant is
        // UTC - so a bad one costs only the "their time" sentence.
        it('keeps a real zone and drops a made-up one', async function () {
            await service.proposeMatchTime(1, 3, alice, soon(), null, 'Europe/Berlin');
            await service.proposeMatchTime(
                1,
                3,
                alice,
                new Date(Date.now() + 2 * 86400000).toISOString(),
                null,
                'definitely; not a zone'
            );

            const offers = await service.getTimeSlots(3);

            expect(offers[0].zone).toBe('Europe/Berlin');
            expect(offers[1].zone).toBeUndefined();
        });
    });

    describe('answering a proposal', function () {
        beforeEach(async function () {
            await service.proposeMatchTime(1, 3, alice, soon());
        });

        it('turns the offer into the agreed time', async function () {
            const result = await service.acceptMatchTime(1, 3, bob);

            expect(result.success, result.message).toBe(true);
            expect(emitted.some((entry) => entry.event === 'matchTimeAccepted')).toBe(true);
            // Agreeing consumes every offer: the rest are moot.
            expect(await service.getTimeSlots(3)).toHaveLength(0);
        });

        it('picks the named one out of several', async function () {
            const day = 24 * 60 * 60 * 1000;

            await service.proposeMatchTime(
                1,
                3,
                alice,
                new Date(Date.now() + 2 * day).toISOString()
            );
            await service.proposeMatchTime(
                1,
                3,
                alice,
                new Date(Date.now() + 3 * day).toISOString()
            );

            const offers = await service.getTimeSlots(3);
            const chosen = offers[2];

            const result = await service.acceptMatchTime(1, 3, bob, chosen.id);

            expect(result.success, result.message).toBe(true);

            const agreed = emitted.find((entry) => entry.event === 'matchTimeAccepted');

            expect(new Date(agreed.payload.time).toISOString()).toBe(
                new Date(chosen.time).toISOString()
            );
        });

        // Naming one is required once there are several: silently taking the
        // soonest would book somebody's evening for them.
        it('will not guess when several times are on offer', async function () {
            await service.proposeMatchTime(
                1,
                3,
                alice,
                new Date(Date.now() + 2 * 86400000).toISOString()
            );

            const result = await service.acceptMatchTime(1, 3, bob);

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/pick the one/i);
        });

        it('will not let the proposer accept their own offer', async function () {
            const result = await service.acceptMatchTime(1, 3, alice);

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/other player/i);
        });

        // A player takes one of their three offers back without cancelling the
        // negotiation.
        it('lets a player withdraw one of their own times', async function () {
            await service.proposeMatchTime(
                1,
                3,
                alice,
                new Date(Date.now() + 2 * 86400000).toISOString()
            );

            const offers = await service.getTimeSlots(3);
            const mine = offers[0];

            expect((await service.withdrawMatchTime(1, 3, bob, mine.id)).success).toBe(false);
            expect((await service.withdrawMatchTime(1, 3, alice, mine.id)).success).toBe(true);
            expect(await service.getTimeSlots(3)).toHaveLength(1);
        });

        it('says so when there is nothing to accept', async function () {
            const [offer] = await service.getTimeSlots(3);

            await service.withdrawMatchTime(1, 3, alice, offer.id);

            expect((await service.acceptMatchTime(1, 3, bob)).success).toBe(false);
        });

        /**
         * The accept must consume the exact offer it read. Withdrawn in
         * between means agreeing to a time nobody is offering.
         *
         * The compare-and-swap is now a delete by primary key rather than a
         * match on the timestamp - which, besides being unambiguous, cannot be
         * defeated by how a Date is serialised. The old comparison bound a Date
         * that node-postgres rendered with the host's offset, so on any host
         * not set to UTC it matched nothing and told both players the proposal
         * had changed, forever.
         */
        it('does not agree to an offer that was withdrawn underneath it', async function () {
            // A second offer stays on the table, so this is "that one is gone"
            // rather than "there is nothing to accept" - two different
            // sentences, and the player needs the first.
            await service.proposeMatchTime(
                1,
                3,
                alice,
                new Date(Date.now() + 2 * 86400000).toISOString()
            );

            const [offer] = await service.getTimeSlots(3);

            await service.withdrawMatchTime(1, 3, alice, offer.id);

            const result = await service.acceptMatchTime(1, 3, bob, offer.id);

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/no longer on offer/i);
        });
    });
});
