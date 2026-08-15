// ESM, and `it` comes from vitest rather than the global: the suite-wide
// helper re-wraps the global `it` and drops the per-test timeout argument.
import { it } from 'vitest';
import { createRequire } from 'node:module';

import scratchPostgres from '../../../helpers/scratchPostgres.js';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const AercAnalyticsService = require('../../../../server/services/membership/AercAnalyticsService');

const DB = 'archonarena_aerc';

/**
 * ARCHON: AERC analysis, against real PostgreSQL.
 *
 * A mock cannot test this. Every figure comes out of a jsonb column - the DoK
 * payload cached in `DeckSas.RawData` - through `->> 'trait'` casts, quartile
 * cut points computed with `percentile_cont`, and CASE expressions built from
 * those cut points at runtime. All of that is SQL. A fake `db.query` would be
 * testing that the strings I concatenated match the strings I expected, which
 * proves nothing about whether the numbers are right.
 *
 * The fixture below is arranged so that a wrong answer is a WRONG NUMBER rather
 * than an equal one: the player's record differs sharply by band, and the two
 * sides (own deck vs opponent deck) disagree with each other, so a query that
 * reads the wrong deck's traits produces a visibly different result instead of
 * quietly agreeing.
 *
 * Skips - it does not fail - where no PostgreSQL is available.
 */
describe('AERC analytics, against real PostgreSQL', function () {
    let pg;
    let pool;
    let db;
    let service;

    const available = scratchPostgres.available();

    const ALICE = 1;
    const BOB = 2;
    // Æmber Skies and Call of the Archons, real rows from the seeded schema.
    const AS_ROW = 12;
    const COTA_ROW = 4;

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
        db = { query: async (sql, params) => (await pool.query(sql, params)).rows };
        service = new AercAnalyticsService(db);

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
     * Twelve decks with amberControl spread 1..12, so the site-wide quartiles
     * land at 3.75 / 6.5 / 9.25 and the four bands hold three decks each.
     *
     * Alice owns decks 1-6 (amberControl 1..6) and plays every one of Bob's
     * decks 7-12 (amberControl 7..12).
     *
     * Her results are then arranged so the two sides tell OPPOSITE stories:
     *
     *   by her own deck's amber control   low band wins, high band loses
     *   by her opponent's amber control   she beats high, loses to low
     *
     * A query that reads the wrong side therefore inverts the answer rather
     * than agreeing with the right one.
     */
    async function seed() {
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

        // One card on every deck, plus a second card only on Alice's low decks,
        // so the per-card query has something to separate.
        await db.query(
            'INSERT INTO "Cards" ("CardId", "Name", "ExpansionId", "HouseId", "Type") ' +
                "VALUES ('c-common', 'Common Card', $1, 1, 'action'), " +
                "('c-lucky', 'Lucky Card', $1, 1, 'action')",
            [AS_ROW]
        );

        for (let deckId = 1; deckId <= 12; deckId++) {
            const owner = deckId <= 6 ? ALICE : BOB;
            // Alice's decks alternate set so the set filter has something real
            // to bite on; Bob's are all Æmber Skies.
            const expansionRow = owner === ALICE && deckId % 2 === 0 ? COTA_ROW : AS_ROW;

            await db.query(
                'INSERT INTO "Decks" ("Id", "UserId", "Uuid", "Identity", "Name", ' +
                    '"IncludeInSealed", "LastUpdated", "Verified", "ExpansionId", "Flagged", ' +
                    '"Banned", "IsAlliance") ' +
                    'VALUES ($1, $2, $3, $4, $5, true, now(), true, $6, false, false, false)',
                [
                    deckId,
                    owner,
                    `uuid-${deckId}`,
                    `identity-${deckId}`,
                    `Deck ${deckId}`,
                    expansionRow
                ]
            );

            // House 1 on every deck, house 2 as well on Alice's odd decks, so
            // the houses-versus-trait table has two houses to rank.
            await db.query('INSERT INTO "DeckHouses" ("DeckId", "HouseId") VALUES ($1, 1)', [
                deckId
            ]);

            if (owner === ALICE && deckId % 2 === 1) {
                await db.query('INSERT INTO "DeckHouses" ("DeckId", "HouseId") VALUES ($1, 2)', [
                    deckId
                ]);
            }

            await db.query(
                'INSERT INTO "DeckCards" ("CardId", "Count", "DeckId", "IsNonDeck") ' +
                    "VALUES ('c-common', 1, $1, false)",
                [deckId]
            );

            if (owner === ALICE && deckId <= 3) {
                await db.query(
                    'INSERT INTO "DeckCards" ("CardId", "Count", "DeckId", "IsNonDeck") ' +
                        "VALUES ('c-lucky', 1, $1, false)",
                    [deckId]
                );
            }

            // amberControl 1..12; creatureControl deliberately the reverse, so
            // a query that hardcodes the wrong trait key cannot pass.
            await db.query(
                'INSERT INTO "DeckSas" ("Uuid", "SasRating", "AercScore", "RawData", "FetchedAt") ' +
                    "VALUES ($1, $2, $2, $3::jsonb, now() AT TIME ZONE 'utc')",
                [
                    `uuid-${deckId}`,
                    60 + deckId,
                    JSON.stringify({
                        amberControl: deckId,
                        creatureControl: 13 - deckId,
                        expectedAmber: 5
                    })
                ]
            );
        }

        let gameId = 1000;

        /**
         * Alice's deck `mine` versus Bob's deck `theirs`, played `count` times,
         * of which she wins `wins`.
         */
        const play = async (mine, theirs, count, wins) => {
            for (let index = 0; index < count; index++) {
                gameId++;
                const aliceWon = index < wins;

                await db.query(
                    'INSERT INTO "Games" ("Id", "GameId", "StartedAt", "FinishedAt", "WinnerId", "WinReason") ' +
                        "VALUES ($1, $2, now() - interval '1 hour', now(), $3, 'keys')",
                    [gameId, `game-${gameId}`, aliceWon ? ALICE : BOB]
                );

                for (const [playerId, deckId] of [
                    [ALICE, mine],
                    [BOB, theirs]
                ]) {
                    await db.query(
                        'INSERT INTO "GamePlayers" ("GameId", "PlayerId", "DeckId", "Keys", "Turn") ' +
                            'VALUES ($1, $2, $3, 3, 12)',
                        [gameId, playerId, deckId]
                    );
                }
            }
        };

        // Alice's LOW decks (1-3, amberControl 1-3) beat Bob's HIGH decks
        // (10-12, amberControl 10-12): 12 games, 9 wins.
        await play(1, 10, 4, 3);
        await play(2, 11, 4, 3);
        await play(3, 12, 4, 3);

        // Alice's MID decks (4-6, amberControl 4-6) lose to Bob's LOW-ish decks
        // (7-9, amberControl 7-9): 12 games, 3 wins.
        await play(4, 7, 4, 1);
        await play(5, 8, 4, 1);
        await play(6, 9, 4, 1);
    }

    const skipUnlessPg = () => !available || !pg;

    describe('trait guarding', function () {
        // Pure, so it runs with or without a database. The trait name is
        // interpolated into SQL as a JSON key, so this is the boundary.
        it('accepts only known trait keys', function () {
            expect(AercAnalyticsService.isTrait('amberControl')).toBe(true);
            expect(AercAnalyticsService.isTrait('creatureControl')).toBe(true);
            expect(AercAnalyticsService.isTrait('nonsense')).toBe(false);
            expect(AercAnalyticsService.isTrait("' OR 1=1 --")).toBe(false);
            expect(AercAnalyticsService.isTrait(undefined)).toBe(false);
        });

        it('refuses to compute anything for an unknown trait', async function () {
            if (skipUnlessPg()) {
                return;
            }

            expect(await service.bandCuts('nonsense')).toBeNull();
            expect(await service.byOwnTrait(ALICE, 'nonsense', {})).toBeNull();
            expect(await service.byOpponentTrait(ALICE, 'nonsense', {})).toBeNull();
        });
    });

    describe('band cut points', function () {
        it('cuts at the site-wide quartiles of the trait', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const cuts = await service.bandCuts('amberControl');

            expect(cuts.decks).toBe(12);
            // 1..12 evenly spread.
            expect(cuts.q1).toBeCloseTo(3.75, 5);
            expect(cuts.q2).toBeCloseTo(6.5, 5);
            expect(cuts.q3).toBeCloseTo(9.25, 5);
        });

        // Every panel needs them and they move only as decks are imported.
        it('computes them once and reuses them', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const fresh = new AercAnalyticsService(db);
            const spy = vi.spyOn(fresh, 'safeQuery');

            await fresh.bandCuts('amberControl');
            await fresh.bandCuts('amberControl');

            expect(spy).toHaveBeenCalledTimes(1);
            spy.mockRestore();
        });
    });

    describe('your own decks', function () {
        it('splits your record by the trait of the deck you brought', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const result = await service.byOwnTrait(ALICE, 'amberControl', {});
            const band = (name) => result.bands.find((row) => row.band === name);

            // Decks 1-3 sit in Low, and won 9 of 12.
            expect(band('Low').games).toBe(12);
            expect(band('Low').winRate).toBeCloseTo(0.75, 5);
            // Decks 4-6 sit in Mid, and won 3 of 12.
            expect(band('Mid').games).toBe(12);
            expect(band('Mid').winRate).toBeCloseTo(0.25, 5);
            // She owns nothing in the top two bands.
            expect(band('High').games).toBe(0);
            expect(band('High').winRate).toBeNull();
        });

        it('reports every band, in order, with the range each one covers', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const result = await service.byOwnTrait(ALICE, 'amberControl', {});

            expect(result.bands.map((row) => row.band)).toEqual([
                'Low',
                'Mid',
                'High',
                'Very high'
            ]);
            // Open at both ends, so no value can fall outside the scale.
            expect(result.bands[0].from).toBeNull();
            expect(result.bands[3].to).toBeNull();
            expect(result.bands[1].from).toBeCloseTo(result.cuts.q1, 5);
        });
    });

    describe('what beats you', function () {
        /**
         * The fixture makes the two sides disagree on purpose: Alice does WELL
         * against high amber control and BADLY against low. Reading her own
         * decks instead would report the opposite, so this cannot pass by
         * accident.
         */
        it('splits your record by the trait of the deck you faced', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const result = await service.byOpponentTrait(ALICE, 'amberControl', {});
            const band = (name) => result.bands.find((row) => row.band === name);

            // Bob's decks 10-12 are Very high, and she beat them 9 of 12.
            expect(band('Very high').games).toBe(12);
            expect(band('Very high').winRate).toBeCloseTo(0.75, 5);
            // Bob's 7-9 straddle Mid and High, and she won 3 of those 12.
            expect(band('Mid').wins + band('High').wins).toBe(3);
            expect(band('Mid').games + band('High').games).toBe(12);
        });

        it('marks a band as unreliable below the confidence threshold', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const result = await service.byOpponentTrait(ALICE, 'amberControl', {});

            for (const band of result.bands) {
                expect(band.confident).toBe(band.games >= AercAnalyticsService.MIN_CONFIDENT_GAMES);
            }
        });
    });

    describe('the set filter', function () {
        // The filter applies to the player's OWN deck: "when I bring this, what
        // beats me" is the question worth answering.
        it('narrows to games played with decks from those sets', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const all = await service.byOwnTrait(ALICE, 'amberControl', {});
            // Alice's even decks (2, 4, 6) are Call of the Archons.
            const cota = await service.byOwnTrait(ALICE, 'amberControl', { sets: [341] });

            const total = (result) => result.bands.reduce((sum, row) => sum + row.games, 0);

            expect(total(all)).toBe(24);
            expect(total(cota)).toBe(12);
        });
    });

    describe('what to lean into', function () {
        it('ranks your houses against each opposing band', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const result = await service.housesVsOpponentTrait(ALICE, 'amberControl', {
                minGames: 1
            });
            const veryHigh = result.bands.find((row) => row.band === 'Very high');

            // Untamed is on every deck; the second house only on her odd decks,
            // which are exactly the ones that beat high amber control.
            expect(veryHigh.houses.length).toBeGreaterThanOrEqual(2);
            expect(veryHigh.houses[0].winRate).toBeGreaterThanOrEqual(
                veryHigh.houses[veryHigh.houses.length - 1].winRate
            );
        });

        it('drops houses with too few games to rank', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const result = await service.housesVsOpponentTrait(ALICE, 'amberControl', {
                minGames: 999
            });

            expect(result.bands.every((band) => band.houses.length === 0)).toBe(true);
        });
    });

    describe('the headline findings', function () {
        it('leads with the widest gap between two bands that both hold up', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const findings = await service.findings(ALICE, {});

            expect(findings.length).toBeGreaterThan(0);

            const top = findings[0];
            expect(top.gap).toBeCloseTo(Math.abs(top.best.winRate - top.worst.winRate), 10);
            // Both ends have to clear the bar, or the headline is noise.
            expect(top.best.confident).toBe(true);
            expect(top.worst.confident).toBe(true);
            expect(findings).toEqual([...findings].sort((a, b) => b.gap - a.gap));
        });

        /**
         * The failure this guards against: a 2-game 100% band is always the
         * widest gap on the page, and would be the headline every time.
         */
        it('never builds a finding out of a band below the threshold', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const findings = await service.findings(ALICE, {});

            for (const finding of findings) {
                expect(finding.best.games).toBeGreaterThanOrEqual(
                    AercAnalyticsService.MIN_CONFIDENT_GAMES
                );
                expect(finding.worst.games).toBeGreaterThanOrEqual(
                    AercAnalyticsService.MIN_CONFIDENT_GAMES
                );
            }
        });
    });

    describe('the field in AERC terms', function () {
        it('reports the mean and median of each trait actually being brought', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const profile = await service.metaTraitProfile({ days: 30 });
            const amber = profile.traits.find((trait) => trait.key === 'amberControl');

            expect(profile.available).toBe(true);
            // 48 deck-games: 24 of Alice's and 24 of Bob's.
            expect(profile.decks).toBe(48);
            expect(amber.mean).toBeGreaterThan(0);
            expect(amber.median).toBeGreaterThan(0);
        });

        it('narrows to a set, so two formats can be compared', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const all = await service.metaTraitProfile({ days: 30 });
            const cota = await service.metaTraitProfile({ days: 30, sets: [341] });

            expect(cota.decks).toBeLessThan(all.decks);
            expect(cota.decks).toBe(12);
        });
    });

    describe('cards', function () {
        it('ranks decks containing each card, above a game threshold', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const cards = await service.byCard(ALICE, { minGames: 5 });
            const lucky = cards.find((row) => row.card === 'Lucky Card');
            const common = cards.find((row) => row.card === 'Common Card');

            // Lucky Card is only on decks 1-3 - the ones that win.
            expect(lucky.games).toBe(12);
            expect(lucky.winRate).toBeCloseTo(0.75, 5);
            // Common Card is on everything, so it is her overall record.
            expect(common.games).toBe(24);
            expect(common.winRate).toBeCloseTo(0.5, 5);
        });

        it('says nothing about a card with too few games behind it', async function () {
            if (skipUnlessPg()) {
                return;
            }

            const cards = await service.byCard(ALICE, { minGames: 20 });

            expect(cards.map((row) => row.card)).toEqual(['Common Card']);
        });
    });
});
