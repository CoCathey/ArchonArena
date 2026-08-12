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
});
