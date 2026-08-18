const db = require('../../../server/db');
const logger = require('../../../server/log');

/**
 * ARCHON: sorting a collection, not sorting a page.
 *
 * "My Decks" reads fifteen rows at a time out of a collection that can run to
 * hundreds, so the ONLY component that can answer "show me my highest-SAS deck"
 * is the query. The client cannot: it holds one page, and reordering a page
 * produces the best deck on that page while looking exactly like the best deck
 * you own.
 *
 * Two things made that happen, and both are pinned here. A sort column the
 * query did not recognise fell through to LastUpdated silently - so the request
 * was answered with the wrong ordering and no trace anywhere. And ARI, which is
 * the stored rating for a deck the engine has played and the SAS/AERC seed for
 * every other deck, had no SQL form at all, so it could not be ordered by even
 * in principle.
 *
 * The third test is about paging rather than sorting: SAS, ARI, set and win
 * rate all repeat across a collection, and ties left unordered are free for
 * Postgres to return in a different order per page - which drops rows out of a
 * paged list entirely.
 */
describe('deck list sorting', function () {
    let DeckService;
    let queries;
    let originalQuery;
    let warnings;

    const listQuery = () => queries.find((entry) => /FROM "Decks" d/.test(entry.sql)).sql;
    const orderBy = () => listQuery().match(/ORDER BY [^)]*/)[0];

    beforeEach(function () {
        queries = [];
        warnings = [];
        originalQuery = db.query;

        db.query = vi.fn(async (sql, params) => {
            queries.push({ sql, params });

            return [];
        });

        vi.spyOn(logger, 'warn').mockImplementation((message) => warnings.push(message));

        DeckService = require('../../../server/services/DeckService');
    });

    afterEach(function () {
        db.query = originalQuery;
        vi.restoreAllMocks();
    });

    const findWith = (options) => new DeckService({}, {}).findForUser({ id: 3 }, options);

    it('orders by SAS in the database when SAS is the column', async function () {
        await findWith({ page: 1, pageSize: 15, sort: 'sasRating', sortDir: 'desc' });

        expect(orderBy()).toContain('"SasRating" DESC');
    });

    it('orders by the EFFECTIVE ARI, seed included', async function () {
        await findWith({ page: 1, pageSize: 15, sort: 'ari', sortDir: 'desc' });

        const sql = listQuery();

        // The ordering runs on a computed column, not on DeckAri."Ari": a deck
        // no sparring game has touched yet still has an ARI (its SAS/AERC
        // midpoint), and ordering on the stored value alone would file every
        // one of them behind the handful the engine happens to have played.
        expect(orderBy()).toContain('"EffectiveAri" DESC');
        expect(sql).toContain('AS "EffectiveAri"');
        expect(sql).toContain('COALESCE(da."Ari"');
        expect(sql).toContain('ds."SasRating"');
        expect(sql).toContain('ds."AercScore"');
        expect(orderBy()).not.toContain('"LastUpdated" DESC');
    });

    it('says so when asked for a sort it cannot express', async function () {
        await findWith({ page: 1, pageSize: 15, sort: 'someNewColumn', sortDir: 'desc' });

        // Still a valid query - a bad sort must not be a failed request - but
        // the fallback is now audible instead of silent.
        expect(orderBy()).toContain('"LastUpdated" DESC');
        expect(warnings.join(' ')).toMatch(/someNewColumn/);
    });

    it('does not warn about the ordinary columns', async function () {
        for (const sort of ['lastUpdated', 'name', 'expansion', 'winRate', 'sasRating', 'ari']) {
            await findWith({ page: 1, pageSize: 15, sort, sortDir: 'asc' });
        }

        expect(warnings).toEqual([]);
    });

    it('breaks every tie on the deck id, so pages cannot overlap', async function () {
        await findWith({ page: 1, pageSize: 15, sort: 'sasRating', sortDir: 'desc' });

        // Sixty decks all rated 70 have no order of their own; without a total
        // order, page two can repeat rows page one already showed and skip
        // others entirely - the reader's collection appears to change size.
        expect(orderBy()).toMatch(/NULLS LAST, "Id" ASC/);
    });

    it('counts the same collection the page comes from', async function () {
        await new DeckService({}, {}).getNumDecksForUser(
            { id: 3 },
            { filter: [{ name: 'sasMin', value: 70 }] }
        );

        const count = queries.find((entry) => /COUNT\(\*\) AS "NumDecks"/.test(entry.sql)).sql;

        // Every join the page's filters can name has to exist here too, or the
        // pager counts rows the page will not return.
        expect(count).toContain('LEFT JOIN "DeckSas" ds');
        expect(count).toContain('LEFT JOIN "DeckAri" da');
        expect(count).toContain('ds."SasRating" >=');
    });
});
