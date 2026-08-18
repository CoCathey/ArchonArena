const ArchonIntelligenceService = require('../../../../server/services/membership/ArchonIntelligenceService');

/**
 * ARCHON: the meta cache, and — more importantly — what it refuses to cache.
 *
 * A full Archon Intelligence page load is on the order of twenty queries plus
 * twenty-five parsed replay documents, and every change of the set filter
 * re-runs the lot. The meta aggregates are the part worth memoising: they are
 * one answer shared by every viewer, measured over a window of days, so a
 * minute of staleness is invisible and one player's read warms it for
 * everybody.
 *
 * The restriction to the meta reads is the design, not an oversight, and the
 * tests below pin it. Caching a player's own record would hold one account's
 * games in memory keyed by their id — a privacy surface — and would show
 * somebody a page that has not noticed the game they just finished, in
 * exchange for a hit rate of roughly zero.
 *
 * A fake clock and a counting db keep this a unit test: no PostgreSQL, and
 * expiry is deterministic rather than a sleep.
 */
describe('Archon Intelligence meta caching', function () {
    let queries;
    let clock;
    let intelligence;

    const rows = [{ house: 'brobnar', houseName: 'Brobnar', appearances: 6, wins: 3 }];

    beforeEach(function () {
        queries = [];
        clock = 0;

        const db = {
            query: async (sql, params) => {
                queries.push({ sql, params });

                return rows;
            }
        };

        intelligence = new ArchonIntelligenceService(db, {
            ttlMs: 60000,
            now: () => clock
        });
    });

    it('answers a repeated read without going back to the database', async function () {
        await intelligence.metaHouses({ days: 30 });
        await intelligence.metaHouses({ days: 30 });
        await intelligence.metaHouses({ days: 30 });

        expect(queries).toHaveLength(1);
    });

    it('recomputes once the entry has expired', async function () {
        await intelligence.metaHouses({ days: 30 });
        clock += 60001;
        await intelligence.metaHouses({ days: 30 });

        expect(queries).toHaveLength(2);
    });

    /**
     * The cache key has to carry everything that changes the answer, or two
     * players looking at different formats are served each other's numbers -
     * which is worse than no cache at all.
     */
    it('keeps different windows and different set filters apart', async function () {
        await intelligence.metaHouses({ days: 30 });
        await intelligence.metaHouses({ days: 7 });
        await intelligence.metaHouses({ days: 30, sets: [800] });
        await intelligence.metaHouses({ days: 30, sets: [341] });

        expect(queries).toHaveLength(4);
    });

    // `sets=800,341` and `sets=341,800` are the same question; two entries for
    // it would halve the hit rate for no reason.
    it('treats a reordered set filter as the same question', async function () {
        await intelligence.metaHouses({ days: 30, sets: [800, 341] });
        await intelligence.metaHouses({ days: 30, sets: [341, 800] });

        expect(queries).toHaveLength(1);
    });

    it('does not let one meta read answer another', async function () {
        await intelligence.metaHouses({ days: 30 });
        await intelligence.metaSummary({ days: 30 });
        await intelligence.metaSets({ days: 30 });

        expect(queries).toHaveLength(3);
    });

    /**
     * safeQuery degrades a failed aggregate to an unavailable panel. Holding
     * that for a minute would turn one blip into a minute of blank cards for
     * everyone, so a failure is retried rather than remembered.
     */
    it('never caches a failure', async function () {
        let fail = true;
        const flaky = {
            query: async () => {
                queries.push({});

                if (fail) {
                    throw new Error('database went away');
                }

                return rows;
            }
        };
        const service = new ArchonIntelligenceService(flaky, { now: () => clock });

        const first = await service.metaHouses({ days: 30 });
        expect(first.available).toBe(false);

        fail = false;
        const second = await service.metaHouses({ days: 30 });

        expect(queries).toHaveLength(2);
        expect(second.available).toBe(true);
    });

    /**
     * The line the cache must not cross. These are one person's own record.
     */
    it('leaves every per-player read uncached', async function () {
        await intelligence.playerByOwnHouse(1, {});
        await intelligence.playerByOwnHouse(1, {});
        await intelligence.playerBySet(1);
        await intelligence.playerBySet(1);

        expect(queries).toHaveLength(4);
    });

    it('does not serve one player the cached answer of another', async function () {
        await intelligence.playerDeckRankings(1, {});
        await intelligence.playerDeckRankings(2, {});

        expect(queries).toHaveLength(2);
        expect(queries[0].params[0]).toBe(1);
        expect(queries[1].params[0]).toBe(2);
    });

    it('can be emptied', async function () {
        await intelligence.metaHouses({ days: 30 });
        intelligence.clearCache();
        await intelligence.metaHouses({ days: 30 });

        expect(queries).toHaveLength(2);
    });
});
