// ESM, and `it` comes from vitest rather than the global: the suite-wide
// helper re-wraps the global `it` and drops the per-test timeout argument.
// Starting a PostgreSQL does not fit in the default 5s.
import { it } from 'vitest';
import { createRequire } from 'node:module';

import scratchPostgres from '../../../helpers/scratchPostgres.js';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const ArchonIntelligenceService = require('../../../../server/services/membership/ArchonIntelligenceService');
const TournamentLabService = require('../../../../server/services/membership/TournamentLabService');
const TournamentService = require('../../../../server/services/tournament/TournamentService');
const { parseSets } = require('../../../../server/services/membership/setFilter');

const DB = 'archonarena_setintel';

/**
 * ARCHON: set filtering, against real SQL.
 *
 * This has to run against PostgreSQL rather than a mocked `db.query`, for one
 * specific reason: the thing most likely to be wrong here is not the JavaScript
 * but WHICH COLUMN the filter compares, and a mock will happily agree with a
 * query that compares the wrong two numbers.
 *
 * `Expansions` carries two integers that are both called an expansion id:
 *
 *   "Id"           a surrogate key - 1, 2, 3 …
 *   "ExpansionId"  the set code everyone actually uses - 341, 800 …
 *
 * `Decks."ExpansionId"` is a foreign key to the FIRST. Every filter a user
 * writes is in terms of the SECOND. Comparing them does not raise an error; it
 * just quietly matches nothing.
 *
 * The seed below deliberately makes those two numbers differ for every set, so
 * a query that reaches for the wrong one returns zero rows and the test fails
 * rather than passing by coincidence.
 *
 * Skips - it does not fail - where no PostgreSQL is available.
 */
describe('set-aware intelligence, against real PostgreSQL', function () {
    let pg;
    let pool;
    let db;
    let intelligence;
    let lab;

    const available = scratchPostgres.available();

    /**
     * The real seeded rows, from `99 - Data.sql` - not invented ones, so the
     * mismatch under test is the production one. Note how far apart the two
     * numbers are in every case:
     *
     *   row 4  is set 341    row 12 is set 800    row 19 is set 928
     */
    const SETS = [
        { row: 4, code: 341, short: 'CotA', name: 'Call of the Archons' },
        { row: 12, code: 800, short: 'AS', name: 'Æmber Skies' },
        { row: 19, code: 928, short: 'DM', name: 'Draconian Measures' }
    ];

    const ALICE = 1;
    const BOB = 2;

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

        pool = new Pool({ connectionString: `${pg.uri}/${DB}` });
        db = {
            query: async (sql, params) => (await pool.query(sql, params)).rows
        };

        intelligence = new ArchonIntelligenceService(db);
        lab = new TournamentLabService(db, intelligence);

        await seed();
    }, 180000);

    afterAll(async function () {
        if (pool) {
            await pool.end();
        }

        if (pg) {
            pg.stop();
        }
    });

    /**
     * A small but complete world: two players, decks in three sets, and games
     * whose results differ BY SET so a filter that does nothing is visible as a
     * wrong number rather than as an equal one.
     *
     * Alice's record is arranged so that the sets disagree:
     *   CotA  3 games, 3 wins   (100%)
     *   AS    4 games, 1 win    (25%)
     *   DM    2 games, 1 win    (50%)
     * Unfiltered that is 9 games and 5 wins - a number that matches no set.
     */
    async function seed() {
        // Expansions and Houses are seeded by the schema itself; using those
        // rows rather than inventing any is the point.
        for (const [id, name] of [
            [ALICE, 'alice'],
            [BOB, 'bob']
        ]) {
            await db.query(
                'INSERT INTO "Users" ("Id", "Username", "Email", "Password", "Registered", "Verified") ' +
                    "VALUES ($1, $2, $2 || '@example.com', 'x', now(), true)",
                [id, name]
            );
        }

        // deckId -> owner, Expansions row. Alice's first, then Bob's opponents.
        const decks = [
            [10, ALICE, SETS[0].row],
            [11, ALICE, SETS[1].row],
            [12, ALICE, SETS[2].row],
            [20, BOB, SETS[0].row],
            [21, BOB, SETS[1].row],
            [22, BOB, SETS[2].row]
        ];

        for (const [deckId, userId, expansionRowId] of decks) {
            await db.query(
                'INSERT INTO "Decks" ("Id", "UserId", "Uuid", "Identity", "Name", ' +
                    '"IncludeInSealed", "LastUpdated", "Verified", "ExpansionId", "Flagged", ' +
                    '"Banned", "IsAlliance") ' +
                    'VALUES ($1, $2, $3, $4, $5, true, now(), true, $6, false, false, false)',
                // Identity is unique per user, so each deck needs its own.
                [
                    deckId,
                    userId,
                    `uuid-${deckId}`,
                    `identity-${deckId}`,
                    `Deck ${deckId}`,
                    expansionRowId
                ]
            );
            // One house on every deck keeps the house tables countable.
            await db.query('INSERT INTO "DeckHouses" ("DeckId", "HouseId") VALUES ($1, 1)', [
                deckId
            ]);
        }

        // [aliceDeck, bobDeck, aliceWon] - counts per set as documented above.
        const games = [
            [10, 20, true],
            [10, 20, true],
            [10, 20, true],
            [11, 21, true],
            [11, 21, false],
            [11, 21, false],
            [11, 21, false],
            [12, 22, true],
            [12, 22, false]
        ];

        let gameId = 100;

        for (const [aliceDeck, bobDeck, aliceWon] of games) {
            gameId++;

            await db.query(
                'INSERT INTO "Games" ("Id", "GameId", "StartedAt", "FinishedAt", "WinnerId", "WinReason") ' +
                    "VALUES ($1, $2, now() - interval '1 hour', now(), $3, 'keys')",
                [gameId, `game-${gameId}`, aliceWon ? ALICE : BOB]
            );

            for (const [playerId, deckId] of [
                [ALICE, aliceDeck],
                [BOB, bobDeck]
            ]) {
                await db.query(
                    'INSERT INTO "GamePlayers" ("GameId", "PlayerId", "DeckId", "Keys", "Turn") ' +
                        'VALUES ($1, $2, $3, 3, 12)',
                    [gameId, playerId, deckId]
                );
            }
        }
    }

    const skipUnlessPg = () => !available || !pg;

    describe('parseSets', function () {
        // Pure, so it runs with or without a database.
        it('takes a query string, an array or a single value', function () {
            expect(parseSets('800,928')).toEqual([800, 928]);
            expect(parseSets([800, '928'])).toEqual([800, 928]);
            expect(parseSets(800)).toEqual([800]);
        });

        it('treats absent, empty and unparseable as no filter rather than no results', function () {
            expect(parseSets(undefined)).toEqual([]);
            expect(parseSets('')).toEqual([]);
            expect(parseSets('nonsense')).toEqual([]);
            // The junk goes, the real one stays.
            expect(parseSets('800,nonsense,-4,0')).toEqual([800]);
        });

        it('deduplicates, so a repeated id cannot skew a count', function () {
            expect(parseSets('800,800,341')).toEqual([800, 341]);
        });
    });

    describe('player intelligence', function () {
        it('narrows a record to one set, and the sets disagree', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const all = await intelligence.playerBySet(ALICE);
            const byCode = Object.fromEntries(all.map((row) => [row.set.id, row]));

            expect(all).toHaveLength(3);
            expect(byCode[341].games).toBe(3);
            expect(byCode[341].winRate).toBe(1);
            expect(byCode[800].games).toBe(4);
            expect(byCode[800].winRate).toBe(0.25);
            expect(byCode[928].games).toBe(2);

            // One set per deck, so these are real shares and sum to 1.
            expect(all.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 10);
        });

        it('filters deck rankings to the requested set', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const everything = await intelligence.playerDeckRankings(ALICE, {});
            const skiesOnly = await intelligence.playerDeckRankings(ALICE, { sets: [800] });

            expect(everything).toHaveLength(3);
            expect(skiesOnly).toHaveLength(1);
            expect(skiesOnly[0].deckId).toBe(11);
            // The set travels with the row so the UI never has to guess.
            expect(skiesOnly[0].set).toEqual({ id: 800, code: 'AS', name: 'Æmber Skies' });
        });

        it('accepts several sets at once', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const two = await intelligence.playerDeckRankings(ALICE, { sets: [341, 928] });

            expect(two.map((row) => row.deckId).sort()).toEqual([10, 12]);
        });

        /**
         * The regression that matters. A filter comparing Decks."ExpansionId"
         * (1, 2, 3 here) against a set code would return nothing for 800 and -
         * far worse - would return Alice's CotA deck for a filter of 2.
         */
        it('filters on the set code, not on the surrogate key', async function () {
            if (skipUnlessPg()) {
                return;
            }

            // 2 is the surrogate Id of Aember Skies. As a set code it is nobody.
            const bySurrogate = await intelligence.playerDeckRankings(ALICE, { sets: [2] });

            expect(bySurrogate).toEqual([]);
        });

        it('filters the house table too, since houses are not spread evenly across sets', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const all = await intelligence.playerByOwnHouse(ALICE, {});
            const skies = await intelligence.playerByOwnHouse(ALICE, { sets: [800] });

            expect(all[0].games).toBe(9);
            expect(skies[0].games).toBe(4);
            expect(skies[0].winRate).toBe(0.25);
        });
    });

    describe('meta intelligence', function () {
        it('reports the field by set, summing to one', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const meta = await intelligence.metaSets({ days: 30 });

            expect(meta.available).toBe(true);
            // Both players' rows: 18 deck-games across 9 games.
            expect(meta.totalGames).toBe(18);
            expect(meta.rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 10);

            const skies = meta.rows.find((row) => row.set.id === 800);
            expect(skies.games).toBe(8);
            expect(skies.decks).toBe(2);
        });

        it('narrows the house table and the summary to a set', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const all = await intelligence.metaSummary({ days: 30 });
            const skies = await intelligence.metaSummary({ days: 30, sets: [800] });

            expect(all.games).toBe(18);
            expect(skies.games).toBe(8);
            expect(skies.decks).toBe(2);
        });
    });

    describe('deck intelligence', function () {
        it('carries the deck own set on its record', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const overview = await intelligence.deckOverview(11, { userId: ALICE });

            expect(overview.available).toBe(true);
            expect(overview.set).toEqual({ id: 800, code: 'AS', name: 'Æmber Skies' });
        });

        /**
         * Unlike the house split, these rows sum to the game count: a deck has
         * three houses but exactly one set.
         */
        it('splits a deck record by the set it faced, summing to its games', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const bySet = await intelligence.deckByOpposingSet(11, { userId: ALICE });

            expect(bySet.available).toBe(true);
            expect(bySet.rows).toHaveLength(1);
            expect(bySet.rows[0].set.id).toBe(800);
            expect(bySet.rows[0].games).toBe(4);
        });
    });

    describe('the tournament lab', function () {
        it('offers only decks from the sets it was scoped to', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const all = await lab.candidates(ALICE, {});
            const skies = await lab.candidates(ALICE, { sets: [800] });

            expect(all).toHaveLength(3);
            expect(skies.map((row) => row.deckId)).toEqual([11]);
            expect(skies[0].set.code).toBe('AS');
        });

        it('takes its scope from a real event, over anything the caller passed', async function () {
            if (skipUnlessPg()) {
                return;
            }

            await db.query(
                'INSERT INTO "Tournaments" ("Id", "Name", "OrganizerId", "Format", "Status", "AllowedSets", "CreatedAt") ' +
                    "VALUES (500, 'Skies Only', $1, 'swiss', 'registration', $2, now())",
                [ALICE, JSON.stringify([800])]
            );

            // Caller asks for CotA; the event says Aember Skies. The event wins.
            const comparison = await lab.compare(ALICE, [], {
                sets: [341],
                tournamentId: 500
            });

            expect(comparison.scoping.sets).toEqual([800]);
            expect(comparison.scoping.tournament.name).toBe('Skies Only');
            expect(comparison.candidates.map((row) => row.deckId)).toEqual([11]);
        });

        /**
         * An event with no set restriction is not an event with an empty one.
         * Reporting them the same way would leave a player wondering why
         * scoping to their event filtered nothing.
         */
        it('says so when the event allows every set', async function () {
            if (skipUnlessPg()) {
                return;
            }

            await db.query(
                'INSERT INTO "Tournaments" ("Id", "Name", "OrganizerId", "Format", "Status", "CreatedAt") ' +
                    "VALUES (501, 'Open', $1, 'swiss', 'registration', now())",
                [ALICE]
            );

            const comparison = await lab.compare(ALICE, [], { tournamentId: 501 });

            expect(comparison.scoping.tournamentAllowsAllSets).toBe(true);
            expect(comparison.scoping.sets).toEqual([]);
            expect(comparison.candidates).toHaveLength(3);
        });

        /**
         * The production instance of the same trap, and the reason this file
         * exists in the shape it does.
         *
         * `validateDeck` compared AllowedSets - set codes, straight from the
         * organiser's checkboxes - against `Decks."ExpansionId"`, the surrogate
         * row id. Those are never equal, so a set-restricted event rejected
         * every deck submitted to it, including the legal ones. Nothing threw
         * and no log line said anything was wrong; the event simply could not
         * be registered for.
         *
         * Against the old comparison the first of these two fails.
         */
        it('lets a legal deck into a set-restricted event, and keeps an illegal one out', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const tournaments = new TournamentService(db);
            const skiesOnly = { GameFormat: 'archon', AllowedSets: JSON.stringify([800]) };

            // Deck 11 IS Æmber Skies. Its row id is 12; the code is 800.
            const legal = await tournaments.validateDeck(skiesOnly, ALICE, 11);
            // Deck 10 is Call of the Archons, and genuinely is not allowed.
            const illegal = await tournaments.validateDeck(skiesOnly, ALICE, 10);

            expect(legal.success).toBe(true);
            expect(illegal.success).toBe(false);
            expect(illegal.message).toMatch(/set this event does not allow/i);
        });

        it('leaves an unrestricted event accepting everything', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const tournaments = new TournamentService(db);
            const open = { GameFormat: 'archon', AllowedSets: null };

            for (const deckId of [10, 11, 12]) {
                expect((await tournaments.validateDeck(open, ALICE, deckId)).success).toBe(true);
            }
        });

        it('narrows the meta panel to the same sets as the comparison', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const comparison = await lab.compare(ALICE, [11], { sets: [800] });

            expect(comparison.decks).toHaveLength(1);
            expect(comparison.decks[0].set.code).toBe('AS');
            // 8 deck-games in Aember Skies, one house on each.
            expect(comparison.meta.totalAppearances).toBe(8);
        });
    });
});
