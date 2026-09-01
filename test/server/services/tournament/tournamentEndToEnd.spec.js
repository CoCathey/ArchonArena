// ESM, and `it` comes from vitest rather than the global: the suite-wide
// helper in test/helpers/integrationhelper.js re-wraps the global `it` to bind
// `this` and drops the per-test timeout argument. Starting a PostgreSQL and
// loading sixty schema files does not fit in the default 5s.
import { it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, types } from 'pg';

import scratchPostgres from '../../../helpers/scratchPostgres.js';
import TournamentService from '../../../../server/services/tournament/TournamentService.js';

const DB = 'archonarena_tournament_e2e';

/**
 * ARCHON: a whole tournament, against a real PostgreSQL.
 *
 * Every other tournament test runs against an in-memory fake of the database
 * that routes on SQL fragments. That fake is good enough to exercise the
 * lifecycle logic and it is fast, but it agrees with itself by construction:
 * it cannot fail on a column this service writes and the schema does not have,
 * a type that does not round-trip, a constraint the code violates, or a query
 * whose real result is ordered differently from the array the fake hands back.
 * Those are exactly the failures that reach production looking like "the
 * feature doesn't work" with every test green - which is how the replay
 * feature got reported broken.
 *
 * So this runs one complete event through the real thing, on the real schema:
 * create, register, register decks, check in, start, play a round through
 * recorded game results, pair the next one, cut to a playoff, finish, and read
 * the standings and the player's event history back out. Then the deck lock,
 * which is the rule with the most SQL behind it.
 *
 * Skips - it does not fail - where no PostgreSQL is available, because a
 * machine without one is a legitimate place to run the rest of the suite.
 */
describe('a tournament end to end, on real PostgreSQL', function () {
    let pg;
    let pool;
    let db;
    let service;
    const users = {};

    const available = scratchPostgres.available();

    beforeAll(async function () {
        if (!available) {
            return;
        }

        pg = await scratchPostgres.start();

        if (!pg) {
            return;
        }

        pg.createDatabase(DB);
        pg.loadSchema(DB);

        // The same UTC parsing server/db installs; without it every timestamp
        // this test reads back would be off by the host's offset.
        types.setTypeParser(1114, (value) =>
            value === null ? null : new Date(`${value.replace(' ', 'T')}Z`)
        );

        pool = new Pool({ connectionString: `${pg.uri}/${DB}` });
        db = {
            query: async (text, params = []) => (await pool.query(text, params)).rows
        };

        service = new TournamentService(db);

        // Decks point at an expansion, and the schema ships the table empty.
        await db.query(
            'INSERT INTO "Expansions" ("Id", "ExpansionId", "Code", "Name") ' +
                "VALUES (341, 341, 'CotA', 'Call of the Archons') ON CONFLICT (\"Id\") DO NOTHING"
        );

        // Eight players and a deck each. Real rows, real foreign keys - the
        // service's inserts have to satisfy them.
        for (let index = 1; index <= 8; index++) {
            const username = `player${index}`;
            const [user] = await db.query(
                'INSERT INTO "Users" ("Username", "Password", "Email", "Registered", "Verified") ' +
                    "VALUES ($1, 'x', $2, now() AT TIME ZONE 'utc', true) RETURNING \"Id\"",
                [username, `${username}@example.test`]
            );

            users[username] = { id: user.Id, username, permissions: {} };
            users[username].deckId = await makeDeck(user.Id, `${username} deck`);
        }
    }, 240000);

    /**
     * A deck row the tournament service will accept as this user's. Identity
     * is unique per user in the real schema (IX_Decks_Identity_UserId), which
     * a fake has no way to tell you.
     */
    const makeDeck = async (userId, name) => {
        const slug = `${name.replace(/\s+/g, '-')}-${userId}`;
        const [deck] = await db.query(
            'INSERT INTO "Decks" ("UserId", "Name", "Uuid", "Identity", "Banned", "IncludeInSealed", ' +
                '"LastUpdated", "ExpansionId", "Verified") ' +
                "VALUES ($1, $2, $3, $4, false, true, now() AT TIME ZONE 'utc', 341, true) " +
                'RETURNING "Id"',
            [userId, name, `uuid-${slug}`, `identity-${slug}`]
        );

        return deck.Id;
    };

    afterAll(async function () {
        if (pool) {
            await pool.end();
        }

        if (pg) {
            pg.stop();
        }
    }, 60000);

    const maybe = (name, body, timeout = 60000) =>
        it(
            name,
            async function () {
                if (!available || !pg) {
                    return;
                }

                await body();
            },
            timeout
        );

    const organizer = () => users.player1;

    // Play out every open match in the current round through the same path a
    // real game takes: a table, then a GAMEWIN. Lower seat number wins, so the
    // results are deterministic and the standings are predictable.
    const playRound = async (id) => {
        const detail = await service.getDetail(id, organizer());
        const round = detail.tournament.currentRound;
        const open = detail.matches.filter(
            (match) => match.round === round && !match.winnerId && !match.resultType
        );

        for (const match of open) {
            if (!match.player2Id) {
                continue;
            }

            const winnerId = Math.min(match.player1Id, match.player2Id);
            const winner = Object.values(users).find((user) => user.id === winnerId);
            const uuid = `game-${id}-${match.id}`;

            await service.attachGame(id, match.id, 1, uuid);
            await service.recordGameWin({
                gameId: uuid,
                winner: winner.username,
                tournament: { tournamentId: id, matchId: match.id }
            });
        }

        return open.length;
    };

    maybe(
        'runs a Swiss event with a top cut from creation to final standings',
        async function () {
            const created = await service.create(organizer(), {
                name: 'Real Postgres Open',
                description: 'Every row of this event is a real row.',
                format: 'swiss',
                roundCount: 2,
                cutTo: 4,
                playoffBestOf: 1,
                mode: 'online',
                requireDeckRegistration: true,
                deckSwapPolicy: 'locked'
            });

            expect(created.success, created.message).toBe(true);
            const id = created.id;

            // --- registration ------------------------------------------------
            for (const user of Object.values(users)) {
                const registered = await service.register(id, user, { deckId: user.deckId });

                expect(registered.success, `${user.username}: ${registered.message}`).toBe(true);
            }

            const open = await service.getDetail(id, organizer());
            expect(open.players).toHaveLength(8);
            expect(open.players.every((player) => player.hasDeck)).toBe(true);

            // --- check-in ----------------------------------------------------
            expect((await service.openCheckIn(id, organizer())).success).toBe(true);

            for (const user of Object.values(users)) {
                expect((await service.checkIn(id, user)).success).toBe(true);
            }

            // --- the event ---------------------------------------------------
            const started = await service.start(id, organizer());
            expect(started.success, started.message).toBe(true);

            expect(await playRound(id)).toBe(4);

            const second = await service.nextRound(id, organizer());
            expect(second.success, second.message).toBe(true);
            expect(second.round).toBe(2);

            // Swiss pairs on record, so nobody meets the same opponent twice.
            const afterPairing = await service.getDetail(id, organizer());
            const pairings = afterPairing.matches.map((match) =>
                [match.player1Id, match.player2Id].sort().join('-')
            );
            expect(new Set(pairings).size).toBe(pairings.length);

            expect(await playRound(id)).toBe(4);

            // --- the cut -----------------------------------------------------
            const cut = await service.cutToPlayoff(id, organizer());
            expect(cut.success, cut.message).toBe(true);

            const inPlayoff = await service.getDetail(id, organizer());
            expect(inPlayoff.tournament.stage).toBe('playoff');
            expect(inPlayoff.matches.filter((match) => match.bracket).length).toBeGreaterThan(0);

            // Semi-finals, then the final.
            expect(await playRound(id)).toBe(2);
            expect((await service.nextRound(id, organizer())).success).toBe(true);
            expect(await playRound(id)).toBe(1);

            // --- the finish --------------------------------------------------
            const finished = await service.finish(id, organizer());
            expect(finished.success, finished.message).toBe(true);

            const complete = await service.getDetail(id, organizer());
            expect(complete.tournament.status).toBe('complete');

            // Everyone placed, exactly one champion, and the ranks are a real
            // ordering rather than eight ties.
            const ranks = complete.players.map((player) => player.finalRank);
            expect(ranks.every((rank) => rank >= 1)).toBe(true);
            expect(ranks.filter((rank) => rank === 1)).toHaveLength(1);

            // Lowest user id won every game it played, so it is the champion.
            const champion = complete.players.find((player) => player.finalRank === 1);
            const lowestId = Math.min(...Object.values(users).map((user) => user.id));
            expect(champion.userId).toBe(lowestId);

            // And it comes back out of the history query the profile uses.
            const history = await service.history(champion.username);
            const entry = history.find((event) => event.id === id);

            expect(entry).toBeDefined();
            expect(entry.finalRank).toBe(1);
            expect(entry.playerCount).toBe(8);
        },
        180000
    );

    /**
     * ARCHON: the other three formats, run to a champion on real rows.
     *
     * A bracket is where the SQL gets hardest: propagateBracket walks winners
     * (and, in double elimination, losers) into matches that already exist by
     * following P1SourceMatchId / P2SourceMatchId, and it is doing it against
     * rows the same transaction just wrote. The fake resolves those links from
     * an array it controls, which is a different thing entirely from resolving
     * them from the table.
     */
    const runToCompletion = async (id, organizerUser) => {
        // Bounded so a bracket that fails to advance ends the test rather than
        // the run - an infinite loop here is a hang, not a failure.
        for (let guard = 0; guard < 20; guard++) {
            const played = await playRound(id);
            const advanced = await service.nextRound(id, organizerUser);

            if (!advanced.success) {
                // Nothing left to pair: either the bracket is exhausted or the
                // scheduled rounds are done.
                if (played === 0) {
                    break;
                }

                const finished = await service.finish(id, organizerUser);

                if (finished.success) {
                    return finished;
                }

                break;
            }
        }

        return await service.finish(id, organizerUser);
    };

    maybe(
        'runs single elimination, double elimination and round robin to a champion',
        async function () {
            const organizerUser = users.player1;

            for (const format of ['single-elim', 'double-elim', 'round-robin']) {
                const created = await service.create(organizerUser, {
                    name: `Real ${format} Cup`,
                    format,
                    mode: 'online'
                });

                expect(created.success, `${format}: ${created.message}`).toBe(true);

                for (const user of Object.values(users)) {
                    expect(
                        (await service.register(created.id, user, {})).success,
                        `${format}: ${user.username} could not register`
                    ).toBe(true);
                }

                expect(
                    (await service.start(created.id, organizerUser)).success,
                    `${format} would not start`
                ).toBe(true);

                const finished = await runToCompletion(created.id, organizerUser);
                expect(finished.success, `${format}: ${finished.message}`).toBe(true);

                const complete = await service.getDetail(created.id, organizerUser);

                expect(complete.tournament.status, `${format} did not complete`).toBe('complete');

                // Exactly one winner, and every entrant placed - a bracket that
                // failed to propagate leaves players with no rank at all.
                const ranks = complete.players.map((player) => player.finalRank);

                expect(
                    ranks.filter((rank) => rank === 1),
                    `${format} champions`
                ).toHaveLength(1);

                // playRound gives every match to the lower user id, so the
                // globally lowest never loses a game in any format and has to
                // come first. A bracket that advanced the wrong side of a
                // match would still produce one champion - just not this one.
                const champion = complete.players.find((player) => player.finalRank === 1);
                const lowestId = Math.min(...Object.values(users).map((user) => user.id));

                expect(champion.userId, `${format} crowned the wrong player`).toBe(lowestId);
                expect(
                    ranks.every((rank) => rank !== null && rank !== undefined),
                    `${format} left a player unplaced`
                ).toBe(true);

                // Every match that was created got decided.
                const undecided = complete.matches.filter(
                    (match) =>
                        match.player1Id && match.player2Id && !match.winnerId && !match.resultType
                );
                expect(undecided, `${format} left matches open`).toHaveLength(0);

                if (format !== 'round-robin') {
                    // The bracket rows are what BracketView draws from; without
                    // them the page has nothing to show.
                    expect(
                        complete.matches.some((match) => match.bracket),
                        `${format} produced no bracket matches`
                    ).toBe(true);
                }

                if (format === 'round-robin') {
                    // Everyone met everyone: 8 players, 7 rounds, 28 matches.
                    expect(complete.matches).toHaveLength(28);
                }
            }
        },
        240000
    );

    /**
     * The deck lock, over real rows. The window is defined by a join between
     * TournamentMatches and TournamentMatchGames, which is precisely the sort
     * of thing the fake answers from an array.
     */
    maybe(
        'holds the deck lock against real match and game rows',
        async function () {
            const alice = users.player1;
            const bob = users.player2;

            const spareId = await makeDeck(alice.id, 'Spare deck');

            const locked = await service.create(alice, {
                name: 'Locked Decks Cup',
                format: 'swiss',
                roundCount: 1,
                deckSwapPolicy: 'locked'
            });

            await service.register(locked.id, alice, { deckId: alice.deckId });
            await service.register(locked.id, bob, { deckId: bob.deckId });
            await service.start(locked.id, alice);

            const refused = await service.registerDeck(locked.id, alice, spareId);
            expect(refused.success).toBe(false);
            expect(refused.message).toMatch(/locks you to one deck/i);

            // The event still reports the deck it froze, which is what the
            // table pins the seat to.
            const detail = await service.getDetail(locked.id, alice);
            expect(detail.tournament.myDeckId).toBe(alice.deckId);
            expect(detail.tournament.canSwapDeck).toBe(false);

            // --- and the swapping half ---------------------------------------
            const swaps = await service.create(alice, {
                name: 'Swap Decks Cup',
                format: 'swiss',
                roundCount: 2,
                deckSwapPolicy: 'between-rounds'
            });

            await service.register(swaps.id, alice, { deckId: alice.deckId });
            await service.register(swaps.id, bob, { deckId: bob.deckId });
            await service.start(swaps.id, alice);

            // Paired but unplayed: the window is open.
            expect((await service.getDetail(swaps.id, alice)).tournament.canSwapDeck).toBe(true);
            expect((await service.registerDeck(swaps.id, alice, spareId)).success).toBe(true);

            const match = (await service.getDetail(swaps.id, alice)).matches.find(
                (entry) => entry.player1Id && entry.player2Id
            );

            // A game on the table shuts it.
            await service.attachGame(swaps.id, match.id, 1, `swap-game-${match.id}`);

            expect((await service.getDetail(swaps.id, alice)).tournament.canSwapDeck).toBe(false);

            const midMatch = await service.registerDeck(swaps.id, alice, alice.deckId);
            expect(midMatch.success).toBe(false);
            expect(midMatch.message).toMatch(/already started/i);

            // The deck they swapped to is the one that stuck.
            expect((await service.getDetail(swaps.id, alice)).tournament.myDeckId).toBe(spareId);
        },
        120000
    );

    /**
     * Asynchronous events are the pacing where the platform, not a room full
     * of people, is doing the organizing - so the SQL that moves the deadline
     * with each round is the part that has to be right.
     */
    maybe(
        'paces an asynchronous round by days and opens tables on demand',
        async function () {
            const alice = users.player3;
            const bob = users.player4;

            const league = await service.create(alice, {
                name: 'Real Async League',
                format: 'swiss',
                roundCount: 1,
                pacing: 'async',
                roundDeadlineDays: 4
            });

            await service.register(league.id, alice, {});
            await service.register(league.id, bob, {});
            await service.start(league.id, alice);

            const detail = await service.getDetail(league.id, alice);

            expect(detail.tournament.pacing).toBe('async');
            expect(detail.tournament.roundDeadlineDays).toBe(4);

            // The deadline is a real timestamp four days out, not a null the
            // client would render as "no deadline".
            const endsAt = new Date(detail.tournament.roundEndsAt);
            const daysAway = (endsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);

            expect(daysAway).toBeGreaterThan(3.9);
            expect(daysAway).toBeLessThan(4.1);

            // Async events do not open a table for every pairing...
            expect(await service.getMatchesNeedingGames(league.id, { forPairing: true })).toEqual(
                []
            );

            // ...but a player can ask for theirs.
            const match = detail.matches.find((entry) => entry.player1Id && entry.player2Id);
            expect((await service.ensureGameForMatch(league.id, match.id, alice)).success).toBe(
                true
            );

            // And the two of them can agree a time inside the deadline.
            const when = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
            const proposed = await service.proposeMatchTime(
                league.id,
                match.id,
                alice,
                when,
                'tomorrow evening?'
            );
            expect(proposed.success, proposed.message).toBe(true);

            const accepted = await service.acceptMatchTime(league.id, match.id, bob);
            expect(accepted.success, accepted.message).toBe(true);

            const scheduled = (await service.getDetail(league.id, alice)).matches.find(
                (entry) => entry.id === match.id
            );
            expect(scheduled.scheduledAt).toBeTruthy();
        },
        120000
    );

    /**
     * ARCHON: the tournament listing, for every kind of caller.
     *
     * list() builds its WHERE clause conditionally and binds parameters to
     * match. It used to push actor.id and then, for a site TO or admin, skip
     * the clause that referenced it - leaving a bound value with no
     * placeholder, which Postgres rejects outright. Every listing therefore
     * threw for exactly the people who can see every event and for nobody
     * else, so the site owner got "No tournaments here yet - create the first
     * one!" while their players saw the events perfectly well.
     *
     * A fake database cannot catch this in principle: it is handed the SQL and
     * the parameter array and never checks that they agree. Only a real server
     * refuses the bind.
     */
    maybe(
        'lists events for anonymous, player, organiser and admin callers alike',
        async function () {
            const organiserUser = users.player1;
            const listed = await service.create(organiserUser, {
                name: 'Visible To Everyone Cup',
                format: 'swiss',
                visibility: 'public'
            });

            expect(listed.success, listed.message).toBe(true);

            const seenBy = async (actor, status) =>
                (await service.list(status, actor)).some((event) => event.id === listed.id);

            // Anonymous, and an ordinary signed-in player.
            expect(await seenBy(null)).toBe(true);
            expect(await seenBy(users.player2)).toBe(true);

            // The two permission shapes that skip the visibility clause. Each
            // is checked with and without a status filter, because the
            // parameter count differs between the two.
            for (const permissions of [{ canManageTournaments: true }, { isAdmin: true }]) {
                const staff = { ...users.player3, permissions };

                expect(await seenBy(staff), `${JSON.stringify(permissions)} / all`).toBe(true);
                expect(
                    await seenBy(staff, 'registration'),
                    `${JSON.stringify(permissions)} / filtered`
                ).toBe(true);
            }
        },
        120000
    );

    /**
     * ARCHON: a cancelled event is a tombstone, not a listing.
     *
     * Nobody can register for one or play in one, and they accumulate at the
     * top of the browse page - a scene that tries a few configurations before
     * its first real event ends up with a list that is mostly abandoned
     * drafts. They stay reachable by their own URL and by asking for them.
     */
    maybe(
        'keeps cancelled events out of the listing unless asked for',
        async function () {
            const alice = users.player1;
            const live = await service.create(alice, {
                name: 'Still Running Cup',
                format: 'swiss'
            });
            const dead = await service.create(alice, { name: 'Abandoned Cup', format: 'swiss' });

            expect((await service.cancel(dead.id, alice)).success).toBe(true);

            const ids = async (status) =>
                (await service.list(status, alice)).map((event) => event.id);

            const browsing = await ids();

            expect(browsing).toContain(live.id);
            expect(browsing).not.toContain(dead.id);

            // Asked for by name, it is still there - an organizer looking for
            // the one they cancelled can find it.
            expect(await ids('cancelled')).toContain(dead.id);

            // And an anonymous visitor sees the same thing.
            const anonymous = (await service.list(undefined, null)).map((event) => event.id);

            expect(anonymous).not.toContain(dead.id);
        },
        120000
    );

    /**
     * ARCHON: the SAS band - the deck power range an event will accept.
     *
     * Enforced on registration through validateDeck, which means it is only as
     * good as the join between Decks and DeckSas. That join is exactly what a
     * fake db answers from an array, so it is worth proving on the real one:
     * a deck's rating lives in a separate table keyed by Uuid, not on the deck
     * row, and a deck DoK has never rated has no row there at all.
     */
    maybe(
        'only lets decks inside the SAS band register',
        async function () {
            const alice = users.player1;

            const rated = async (name, sas) => {
                const deckId = await makeDeck(alice.id, name);
                const [deck] = await db.query('SELECT "Uuid" FROM "Decks" WHERE "Id" = $1', [
                    deckId
                ]);

                if (sas !== null) {
                    await db.query(
                        'INSERT INTO "DeckSas" ("Uuid", "SasRating", "FetchedAt") ' +
                            "VALUES ($1, $2, now() AT TIME ZONE 'utc')",
                        [deck.Uuid, sas]
                    );
                }

                return deckId;
            };

            const weak = await rated('Weak deck', 45);
            const justRight = await rated('Middling deck', 62);
            const strong = await rated('Strong deck', 88);
            const unrated = await rated('Unrated deck', null);

            const banded = await service.create(alice, {
                name: 'SAS Banded Cup',
                format: 'swiss',
                roundCount: 1,
                sasMin: 50,
                sasMax: 75
            });

            expect(banded.success, banded.message).toBe(true);
            await service.register(banded.id, alice, {});

            const below = await service.registerDeck(banded.id, alice, weak);
            expect(below.success).toBe(false);
            expect(below.message).toMatch(/below the event minimum of 50/i);

            const above = await service.registerDeck(banded.id, alice, strong);
            expect(above.success).toBe(false);
            expect(above.message).toMatch(/above the event maximum of 75/i);

            // A deck nobody has rated is refused rather than waved through -
            // otherwise it would be the hole in the band.
            const noRating = await service.registerDeck(banded.id, alice, unrated);
            expect(noRating.success).toBe(false);
            expect(noRating.message).toMatch(/no SAS rating yet/i);

            const accepted = await service.registerDeck(banded.id, alice, justRight);
            expect(accepted.success, accepted.message).toBe(true);

            // And the band reaches the browse listing, so a player can tell
            // which events their decks are eligible for before clicking in.
            const listed = (await service.list('registration', alice)).find(
                (event) => event.id === banded.id
            );

            expect(listed.sasMin).toBe(50);
            expect(listed.sasMax).toBe(75);
        },
        120000
    );

    /**
     * ARCHON: the reminders that fire before something happens.
     *
     * Everything an async event used to send was a report of the past - a
     * round was paired, a time was agreed, a deadline had passed. Two players
     * agreed to meet on Thursday and nothing reminded either of them; a round
     * ended on Sunday and the first anyone heard was Monday, when matches
     * started being decided by the clock instead of by play.
     *
     * These are pure SQL time windows over real timestamp columns, which is
     * precisely what a fake db cannot check: it would compare whatever JS
     * values the fake chose to store.
     */
    maybe(
        'warns before a round deadline and before an agreed match time, once each',
        async function () {
            const alice = users.player1;
            const bob = users.player2;

            {
                const league = await service.create(alice, {
                    name: 'Reminder League',
                    format: 'swiss',
                    roundCount: 1,
                    pacing: 'async',
                    roundDeadlineDays: 7
                });

                await service.register(league.id, alice, {});
                await service.register(league.id, bob, {});
                await service.start(league.id, alice);

                // Nothing is close yet, so nothing fires.
                expect(await service.sweepScheduleReminders()).toEqual({
                    warned: 0,
                    reminded: 0
                });

                // Bring the round deadline inside the warning window and the
                // agreed match time inside the reminder window.
                await db.query(
                    'UPDATE "Tournaments" SET "RoundEndsAt" = ' +
                        "(now() AT TIME ZONE 'utc') + interval '2 hours' WHERE \"Id\" = $1",
                    [league.id]
                );

                const match = (await service.getDetail(league.id, alice)).matches.find(
                    (entry) => entry.player1Id && entry.player2Id
                );

                await db.query(
                    'UPDATE "TournamentMatches" SET "ScheduledAt" = ' +
                        "(now() AT TIME ZONE 'utc') + interval '10 minutes' WHERE \"Id\" = $1",
                    [match.id]
                );

                const swept = await service.sweepScheduleReminders();

                expect(swept.warned).toBe(1);
                expect(swept.reminded).toBe(1);

                // Once each, ever: the write that announces IS the claim, so a
                // second sweep - or a second lobby process - says nothing. The
                // markers are the mechanism, so they are what is asserted on.
                expect(await service.sweepScheduleReminders()).toEqual({
                    warned: 0,
                    reminded: 0
                });

                const [stamped] = await db.query(
                    'SELECT "DeadlineWarnedAt" FROM "Tournaments" WHERE "Id" = $1',
                    [league.id]
                );
                expect(stamped.DeadlineWarnedAt).toBeTruthy();

                // Rescheduling is a new thing to be reminded about.
                await service.clearMatchSchedule(league.id, match.id, alice);
                await db.query(
                    'UPDATE "TournamentMatches" SET "ScheduledAt" = ' +
                        "(now() AT TIME ZONE 'utc') + interval '10 minutes' WHERE \"Id\" = $1",
                    [match.id]
                );

                expect((await service.sweepScheduleReminders()).reminded).toBe(1);
            }
        },
        120000
    );

    /**
     * ARCHON: deleting a deck you are registered with.
     *
     * TournamentPlayers."DeckId" is ON DELETE SET NULL, so the delete does not
     * fail - it silently unpins the seat, and a null pin is not "locked but
     * missing", it is UNPINNED: the table's deck picker goes live again with
     * none of the event's rules applied to what gets chosen next. That made
     * deleting a deck a way through the deck lock. The behaviour turns
     * entirely on what the real schema does with the foreign key, which is
     * exactly what a fake cannot tell you.
     */
    maybe(
        'a registered deck is still registered after someone tries to delete it',
        async function () {
            const alice = users.player7;
            const doomed = await makeDeck(alice.id, 'Doomed deck');

            const locked = await service.create(alice, {
                name: 'Deck Deletion Cup',
                format: 'swiss',
                roundCount: 1,
                deckSwapPolicy: 'locked'
            });

            await service.register(locked.id, alice, { deckId: doomed });
            await service.register(locked.id, users.player8, {});
            await service.start(locked.id, alice);

            // The guard the delete routes consult.
            const committed = await service.findLiveEventDeckCommitments(alice.id, [doomed]);

            expect(committed).toHaveLength(1);
            expect(committed[0].tournamentId).toBe(locked.id);
            expect(committed[0].tournamentName).toBe('Deck Deletion Cup');

            // And this is what it is protecting against: the raw delete the
            // route would otherwise have performed unpins the seat rather than
            // failing, which is why a guard is needed at all.
            await db.query('DELETE FROM "Decks" WHERE "Id" = $1', [doomed]);

            const after = await db.query(
                'SELECT "DeckId" FROM "TournamentPlayers" WHERE "TournamentId" = $1 AND "UserId" = $2',
                [locked.id, alice.id]
            );

            expect(after[0].DeckId, 'the FK really is ON DELETE SET NULL').toBeNull();
        },
        120000
    );

    /**
     * ARCHON: accepting a time on a host that is not UTC.
     *
     * Every timestamp column here is `timestamp without time zone` holding UTC
     * wall-clock, and db/index.js parses it back as UTC. But node-postgres
     * serialises a Date PARAMETER using the host's offset, and Postgres
     * casting that to an unzoned column keeps the wall clock and throws the
     * offset away. acceptMatchTime bound the proposal it had just read as a
     * Date, so its compare-and-swap looked for a time hours from the one
     * stored, matched nothing, and told both players "the proposal changed
     * while you were looking" - every time, forever, on any host outside UTC.
     *
     * This is the test that could catch it: a real Postgres, and a process
     * clock that is not UTC. A mocked db compares JS values and agrees with
     * itself, and CI runs UTC where the bug is invisible - which is exactly
     * how it survived.
     *
     * It runs in a CHILD PROCESS with TZ set at spawn, which is not
     * ceremony: vitest uses `pool: 'threads'`, and setting process.env.TZ
     * inside a worker thread does not move V8's timezone, so the obvious
     * version of this test passes just as happily against the bug.
     */
    maybe(
        'accepts a proposed time on a host whose clock is not UTC',
        async function () {
            const alice = users.player5;
            const bob = users.player6;

            const league = await service.create(alice, {
                name: 'Off-UTC League',
                format: 'swiss',
                roundCount: 1,
                pacing: 'async',
                roundDeadlineDays: 7
            });

            await service.register(league.id, alice, {});
            await service.register(league.id, bob, {});
            await service.start(league.id, alice);

            const match = (await service.getDetail(league.id, alice)).matches.find(
                (entry) => entry.player1Id && entry.player2Id
            );
            const when = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();

            // Six hours off UTC, and not a whole-day offset, so a shifted
            // binding cannot land on the right value by accident.
            const output = execFileSync(
                process.execPath,
                [
                    path.join(
                        path.dirname(fileURLToPath(import.meta.url)),
                        'offUtcScheduleProbe.cjs'
                    )
                ],
                {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        TZ: 'America/Chicago',
                        PROBE_PG_URI: `${pg.uri}/${DB}`,
                        PROBE_TOURNAMENT: String(league.id),
                        PROBE_MATCH: String(match.id),
                        PROBE_PROPOSER: String(alice.id),
                        PROBE_ACCEPTER: String(bob.id),
                        PROBE_TIME: when
                    }
                }
            );

            const result = JSON.parse(output.trim().split('\n').pop());

            expect(result.offsetMinutes, 'the child did not actually run off UTC').not.toBe(0);
            expect(result.proposed.success, result.proposed.message).toBe(true);
            expect(result.accepted.success, result.accepted.message).toBe(true);

            // And the time agreed is the time offered, not one shifted by the
            // host's offset.
            const after = (await service.getDetail(league.id, alice)).matches.find(
                (entry) => entry.id === match.id
            );

            expect(after.scheduledAt).toBeTruthy();
            expect(after.proposedTime).toBeFalsy();
            expect(Math.abs(new Date(after.scheduledAt).getTime() - new Date(when).getTime())).toBe(
                0
            );
        },
        120000
    );

    /**
     * ARCHON: the buy-in and prize split survive being written and re-read.
     *
     * Three things here can only be checked against a real database. The
     * INSERT gained four more placeholders, and a miscount is not a wrong
     * answer but a thrown query - the same class of bug that made the event
     * listing 500 for exactly the people allowed to see every event. The splits
     * are jsonb, so what comes back out is not necessarily the shape that went
     * in. And updateSettings re-writes every column from a merged snapshot of
     * the row: a column present in the UPDATE but missing from that snapshot is
     * parsed as "not set" and written back null, which would mean an organizer
     * fixing a typo in the event name silently deletes the prize table that
     * everybody paid into.
     */
    maybe(
        'records the buy-in and prize split, and does not lose them on an unrelated edit',
        async function () {
            const alice = users.player1;

            const created = await service.create(alice, {
                name: 'Prize Pool Cup',
                format: 'swiss',
                roundCount: 1,
                entryFeeCents: 1000,
                prizeCurrency: 'USD',
                prizeSplits: [
                    { rank: 2, bps: 2000 },
                    { rank: 1, bps: 7500 }
                ],
                prizeNote: 'Cash at the counter, paid out on the night.'
            });

            expect(created.success, created.message).toBe(true);

            const detail = await service.getDetail(created.id, alice);

            expect(detail.tournament.entryFeeCents).toBe(1000);
            expect(detail.tournament.prizeCurrency).toBe('USD');
            expect(detail.tournament.prizeNote).toMatch(/Cash at the counter/);
            // Sorted by place on the way in, so the prize table reads top-down
            // wherever it is rendered.
            expect(detail.tournament.prizeSplits).toEqual([
                { rank: 1, bps: 7500 },
                { rank: 2, bps: 2000 }
            ]);

            // The buy-in reaches the browse listing: nobody should have to open
            // an event to find out it costs money to enter.
            const listed = (await service.list('registration', alice)).find(
                (event) => event.id === created.id
            );

            expect(listed.entryFeeCents).toBe(1000);
            expect(listed.prizeCurrency).toBe('USD');

            // Now the edit that must not touch the money.
            const renamed = await service.updateSettings(created.id, alice, {
                name: 'Prize Pool Cup (Friday)'
            });

            expect(renamed.success, renamed.message).toBe(true);

            const afterEdit = await service.getDetail(created.id, alice);

            expect(afterEdit.tournament.name).toBe('Prize Pool Cup (Friday)');
            expect(afterEdit.tournament.entryFeeCents).toBe(1000);
            expect(afterEdit.tournament.prizeSplits).toEqual([
                { rank: 1, bps: 7500 },
                { rank: 2, bps: 2000 }
            ]);
            expect(afterEdit.tournament.prizeNote).toMatch(/Cash at the counter/);

            // A table that cannot be paid is refused rather than stored, and
            // the message says the number so the organizer can see what they
            // typed.
            const overAllocated = await service.updateSettings(created.id, alice, {
                prizeSplits: [
                    { rank: 1, bps: 8000 },
                    { rank: 2, bps: 4000 }
                ]
            });

            expect(overAllocated.success).toBe(false);
            expect(overAllocated.message).toMatch(/120\.00%/);

            // And the refusal changed nothing.
            const untouched = await service.getDetail(created.id, alice);

            expect(untouched.tournament.prizeSplits).toEqual([
                { rank: 1, bps: 7500 },
                { rank: 2, bps: 2000 }
            ]);

            // Once the event is under way the money is frozen, because people
            // have already paid against the announced split.
            await service.register(created.id, alice, {});
            await service.register(created.id, users.player2, {});
            await service.start(created.id, alice);

            const lateChange = await service.updateSettings(created.id, alice, {
                entryFeeCents: 2000
            });

            expect(lateChange.success).toBe(false);
            expect((await service.getDetail(created.id, alice)).tournament.entryFeeCents).toBe(
                1000
            );
        },
        120000
    );
    /**
     * ARCHON: who has paid, and an event that will not start until they have.
     *
     * The platform takes no money and moves none - this is a register the
     * organizer keeps, in the place everybody is already looking. It earns its
     * keep at eight players on a Friday, where "who has handed me ten dollars"
     * is genuinely hard to hold in your head: people pay at different times,
     * some pay a judge rather than the organizer, and somebody always says they
     * paid last week.
     *
     * Real PostgreSQL because the enforcement is a query over a real column
     * and a real join, and because the fake would agree with any of it.
     */
    maybe(
        'records who has paid and refuses to start until everyone has',
        async function () {
            const alice = users.player3;
            const bob = users.player4;
            const carol = users.player5;

            const paid = await service.create(alice, {
                name: 'Paid Entry Cup',
                format: 'swiss',
                roundCount: 1,
                entryFeeCents: 1000,
                paymentInstructions: 'Cash at the counter before the first round.',
                requirePayment: true
            });

            expect(paid.success, paid.message).toBe(true);

            for (const player of [alice, bob, carol]) {
                await service.register(paid.id, player, {});
            }

            const opened = await service.getDetail(paid.id, alice);

            expect(opened.tournament.paymentInstructions).toMatch(/Cash at the counter/);
            expect(opened.tournament.requirePayment).toBe(true);
            // Nobody has paid yet, and the roster says so rather than staying
            // quiet about it.
            expect(opened.players.every((player) => player.paid === false)).toBe(true);

            // Starting names the people the organizer has to go and find.
            const tooEarly = await service.start(paid.id, alice);

            expect(tooEarly.success).toBe(false);
            expect(tooEarly.message).toMatch(/have not paid/i);
            expect(tooEarly.message).toContain(bob.username);
            expect(tooEarly.message).toContain(carol.username);

            // A player cannot tick their own name: a register anybody can sign
            // is not a register.
            const selfServe = await service.setPaid(paid.id, bob, bob.id, true);

            expect(selfServe.success).toBe(false);
            expect(selfServe.message).toMatch(/organizer or a judge/i);

            for (const player of [alice, bob, carol]) {
                const marked = await service.setPaid(paid.id, alice, player.id, true);

                expect(marked.success, marked.message).toBe(true);
            }

            const afterPaying = await service.getDetail(paid.id, alice);

            expect(afterPaying.players.every((player) => player.paid)).toBe(true);
            // Named, because "which judge marked me paid" is what settles a
            // disagreement and a boolean cannot answer it.
            expect(afterPaying.players[0].paidBy).toBe(alice.username);
            expect(afterPaying.players[0].paidAt).toBeTruthy();

            const started = await service.start(paid.id, alice);

            expect(started.success, started.message).toBe(true);
        },
        120000
    );

    maybe(
        'leaves a free event and an unenforced fee alone',
        async function () {
            const alice = users.player6;
            const bob = users.player7;

            // A fee, but the organizer collects as people arrive and does not
            // want the start button arguing about it.
            const relaxed = await service.create(alice, {
                name: 'Relaxed Paid Cup',
                format: 'swiss',
                roundCount: 1,
                entryFeeCents: 500,
                requirePayment: false
            });

            await service.register(relaxed.id, alice, {});
            await service.register(relaxed.id, bob, {});

            const started = await service.start(relaxed.id, alice);

            expect(started.success, started.message).toBe(true);

            // And a free event has no register at all - a "paid" column of
            // meaningless ticks is worse than no column.
            const free = await service.create(alice, { name: 'Free Cup', format: 'swiss' });

            await service.register(free.id, alice, {});

            const detail = await service.getDetail(free.id, alice);

            expect(detail.tournament.requirePayment).toBe(false);
            expect(detail.players[0].paid).toBeUndefined();

            const noFee = await service.setPaid(free.id, alice, alice.id, true);

            expect(noFee.success).toBe(false);
            expect(noFee.message).toMatch(/no entry fee/i);
        },
        120000
    );
    /**
     * ARCHON: several times on the table at once, each carrying the zone it
     * was offered from.
     *
     * Real PostgreSQL because all of it is SQL the fake cannot check: a unique
     * constraint that turns "I can do Thursday too" into agreement rather than
     * a duplicate row, an ORDER BY the service relies on, a delete-by-key
     * compare-and-swap, and a summary column kept in step with the rows it
     * summarises.
     */
    maybe(
        'keeps several offered times, in order, and agrees to the one picked',
        async function () {
            const alice = users.player1;
            const bob = users.player2;
            const day = 24 * 60 * 60 * 1000;

            const league = await service.create(alice, {
                name: 'Time Slots League',
                format: 'swiss',
                roundCount: 1,
                pacing: 'async',
                roundDeadlineDays: 14
            });

            await service.register(league.id, alice, {});
            await service.register(league.id, bob, {});
            await service.start(league.id, alice);

            const match = (await service.getDetail(league.id, alice)).matches.find(
                (entry) => entry.player1Id && entry.player2Id
            );

            const thursday = new Date(Date.now() + 3 * day).toISOString();
            const tuesday = new Date(Date.now() + 1 * day).toISOString();
            const wednesday = new Date(Date.now() + 2 * day).toISOString();

            // Alice offers three evenings in one go, from Chicago.
            for (const time of [thursday, tuesday, wednesday]) {
                const offered = await service.proposeMatchTime(
                    league.id,
                    match.id,
                    alice,
                    time,
                    null,
                    'America/Chicago'
                );

                expect(offered.success, offered.message).toBe(true);
            }

            let slots = await service.getTimeSlots(match.id);

            expect(slots).toHaveLength(3);
            expect(slots.map((slot) => new Date(slot.time).toISOString())).toEqual([
                tuesday,
                wednesday,
                thursday
            ]);
            expect(slots[0].zone).toBe('America/Chicago');
            expect(slots[0].proposedBy).toBe(alice.username);

            // Bob says Thursday works for him too. That is agreement, not a
            // fourth option, and the unique constraint absorbs it.
            await service.proposeMatchTime(
                league.id,
                match.id,
                bob,
                thursday,
                null,
                'Europe/Berlin'
            );
            expect(await service.getTimeSlots(match.id)).toHaveLength(3);

            // Bob adds one of his own and the list stays sorted.
            const friday = new Date(Date.now() + 4 * day).toISOString();

            await service.proposeMatchTime(league.id, match.id, bob, friday, null, 'Europe/Berlin');
            slots = await service.getTimeSlots(match.id);
            expect(slots).toHaveLength(4);
            expect(new Date(slots[3].time).toISOString()).toBe(friday);

            // The summary columns track the soonest live offer, because the
            // reminders and the schedule panel read them.
            const withOffers = (await service.getDetail(league.id, alice)).matches.find(
                (entry) => entry.id === match.id
            );

            expect(new Date(withOffers.proposedTime).toISOString()).toBe(tuesday);
            expect(withOffers.timeSlots).toHaveLength(4);

            // Naming one is required with several on the table: silently taking
            // the soonest would book somebody's evening for them.
            const guessed = await service.acceptMatchTime(league.id, match.id, bob);

            expect(guessed.success).toBe(false);
            expect(guessed.message).toMatch(/pick the one/i);

            // Bob picks Wednesday.
            const wednesdaySlot = slots.find(
                (slot) => new Date(slot.time).toISOString() === wednesday
            );
            const agreed = await service.acceptMatchTime(
                league.id,
                match.id,
                bob,
                wednesdaySlot.id
            );

            expect(agreed.success, agreed.message).toBe(true);

            const settled = (await service.getDetail(league.id, alice)).matches.find(
                (entry) => entry.id === match.id
            );

            expect(new Date(settled.scheduledAt).toISOString()).toBe(wednesday);
            // Agreeing consumes every offer, and the summary goes with them.
            expect(settled.timeSlots).toHaveLength(0);
            expect(settled.proposedTime).toBeFalsy();
        },
        120000
    );

    maybe(
        'lets a player take back one of their own times, and nobody elses',
        async function () {
            const alice = users.player3;
            const bob = users.player4;
            const day = 24 * 60 * 60 * 1000;

            const league = await service.create(alice, {
                name: 'Withdraw League',
                format: 'swiss',
                roundCount: 1,
                pacing: 'async',
                roundDeadlineDays: 14
            });

            await service.register(league.id, alice, {});
            await service.register(league.id, bob, {});
            await service.start(league.id, alice);

            const match = (await service.getDetail(league.id, alice)).matches.find(
                (entry) => entry.player1Id && entry.player2Id
            );

            await service.proposeMatchTime(
                league.id,
                match.id,
                alice,
                new Date(Date.now() + day).toISOString()
            );
            await service.proposeMatchTime(
                league.id,
                match.id,
                alice,
                new Date(Date.now() + 2 * day).toISOString()
            );

            const [first] = await service.getTimeSlots(match.id);

            expect(
                (await service.withdrawMatchTime(league.id, match.id, bob, first.id)).success
            ).toBe(false);
            expect(
                (await service.withdrawMatchTime(league.id, match.id, alice, first.id)).success
            ).toBe(true);

            const left = await service.getTimeSlots(match.id);

            expect(left).toHaveLength(1);

            // The summary follows: the soonest live offer is now the second one.
            const after = (await service.getDetail(league.id, alice)).matches.find(
                (entry) => entry.id === match.id
            );

            expect(new Date(after.proposedTime).toISOString()).toBe(
                new Date(left[0].time).toISOString()
            );

            // And with the last one gone there is no offer at all.
            await service.withdrawMatchTime(league.id, match.id, alice, left[0].id);

            const empty = (await service.getDetail(league.id, alice)).matches.find(
                (entry) => entry.id === match.id
            );

            expect(empty.proposedTime).toBeFalsy();
            expect(empty.timeSlots).toHaveLength(0);
        },
        120000
    );

    /**
     * ARCHON (N9): the Adaptive Bo3 chain bid's timeout, over a real jsonb
     * column. The unit suite proves the state machine against a fake that
     * hands state straight back; this proves `turnStartedAt` survives an
     * actual round trip through Postgres as a number the timeout arithmetic
     * can still do math on, not a string it silently NaNs on.
     */
    maybe(
        'force-resolves a stalled Adaptive Bo3 chain bid as a pass once the round timer expires',
        async function () {
            const alice = users.player7;
            const bob = users.player8;

            const created = await service.create(alice, {
                name: 'Adaptive Chain Cup',
                format: 'swiss',
                roundCount: 1,
                adaptiveBo3: true,
                pacing: 'live',
                roundTimerMinutes: 5
            });

            expect(created.success, created.message).toBe(true);
            const id = created.id;

            await service.register(id, alice, { deckId: alice.deckId });
            await service.register(id, bob, { deckId: bob.deckId });
            await service.start(id, alice);

            const match = (await service.getDetail(id, alice)).matches.find(
                (entry) => entry.player1Id && entry.player2Id
            );

            // Games 1 and 2 split - the only way a series reaches the bid.
            await service.attachGame(id, match.id, 1, `adaptive-${match.id}-g1`);
            await service.recordGameWin({
                gameId: `adaptive-${match.id}-g1`,
                winner: alice.username,
                tournament: { tournamentId: id, matchId: match.id }
            });
            await service.attachGame(id, match.id, 2, `adaptive-${match.id}-g2`);
            await service.recordGameWin({
                gameId: `adaptive-${match.id}-g2`,
                winner: bob.username,
                tournament: { tournamentId: id, matchId: match.id }
            });

            const now = Date.now();
            vi.spyOn(Date, 'now').mockReturnValue(now);

            const opened = await service.getAdaptiveState(id, match.id, alice);

            expect(opened.gameNumber).toBe(3);
            expect(opened.bidding.resolved).toBe(false);
            expect(opened.bidding.turnDeadlineAt).toBe(now + 5 * 60 * 1000);

            const turnUserId = opened.bidding.turnUserId;

            Date.now.mockReturnValue(now + 5 * 60 * 1000 + 1);

            const settled = await service.getAdaptiveState(id, match.id, alice);

            expect(settled.bidding.resolved).toBe(true);
            expect(settled.bidding.highBidderId).not.toBe(turnUserId);
            expect(settled.bidding.currentBid).toBe(0);

            Date.now.mockRestore();

            // And it really persisted - a real Postgres row, not the service's
            // own idea of one.
            const [row] = await db.query(
                'SELECT "AdaptiveState" FROM "TournamentMatches" WHERE "Id" = $1',
                [match.id]
            );

            expect(row.AdaptiveState.resolved).toBe(true);
            expect(row.AdaptiveState.turnStartedAt).toBe(now);
        },
        60000
    );
});
