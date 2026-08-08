const DeckService = require('../../server/services/DeckService');
const db = require('../../server/db');

/**
 * ARCHON: the queries behind the deck rules - the Lucky Dice random pick and
 * the SAS range filters the deck picker sends for a SAS-bound game.
 *
 * These assert what SQL leaves the service; the SQL itself is exercised
 * against a real Postgres schema in the deploy-time checks, not here.
 */
describe('DeckService deck rules', function () {
    let service;
    let query;

    beforeEach(function () {
        service = new DeckService({}, {});
        query = vi.spyOn(db, 'query').mockResolvedValue([]);
    });

    afterEach(function () {
        query.mockRestore();
    });

    describe('getRandomDeckIdForUser', function () {
        it('draws from all of a user own decks, ordered by chance', async function () {
            query.mockResolvedValue([{ Id: 42 }]);

            const id = await service.getRandomDeckIdForUser(11, {
                isAlliance: false,
                unchainedOnly: false
            });

            expect(id).toBe(42);

            const [sql, params] = query.mock.calls[0];
            expect(sql).toContain('ORDER BY random() LIMIT 1');
            expect(sql).toContain('d."UserId" = $1');
            expect(sql).toContain('d."IsAlliance" = $2');
            expect(sql).toContain('e."ExpansionId" <> 601');
            expect(params).toEqual([11, false]);
        });

        it('restricts an unchained game to the unchained set', async function () {
            await service.getRandomDeckIdForUser(11, { isAlliance: false, unchainedOnly: true });

            const [sql] = query.mock.calls[0];
            expect(sql).toContain('e."ExpansionId" = 601');
            expect(sql).not.toContain('<> 601');
        });

        it('leaves alliance membership open when the game does', async function () {
            await service.getRandomDeckIdForUser(11, {});

            const [sql, params] = query.mock.calls[0];
            expect(sql).not.toContain('"IsAlliance"');
            expect(params).toEqual([11]);
        });

        // The SAS comparisons ride on the DeckSas join; NULL fails both, so a
        // deck DoK has not rated can never be rolled into a bounded game.
        it('applies a SAS bound to the roll', async function () {
            await service.getRandomDeckIdForUser(11, {
                isAlliance: false,
                sasMin: 60,
                sasMax: 80
            });

            const [sql, params] = query.mock.calls[0];
            expect(sql).toContain('ds."SasRating" >= $3');
            expect(sql).toContain('ds."SasRating" <= $4');
            expect(params).toEqual([11, false, 60, 80]);
        });

        it('reports no deck as null, both for empty results and for errors', async function () {
            expect(await service.getRandomDeckIdForUser(11, {})).toBeNull();

            query.mockRejectedValue(new Error('db down'));
            expect(await service.getRandomDeckIdForUser(11, {})).toBeNull();
        });
    });

    describe('the SAS range filter', function () {
        it('turns sasMin/sasMax into range comparisons on the DeckSas join', function () {
            const params = [1];
            const filter = service.processFilter(2, params, [
                { name: 'sasMin', value: 60 },
                { name: 'sasMax', value: 80 }
            ]);

            expect(filter).toContain('AND ds."SasRating" >= $2');
            expect(filter).toContain('AND ds."SasRating" <= $3');
            expect(params).toEqual([1, 60, 80]);
        });

        it('ignores bounds that are not numbers instead of breaking the query', function () {
            const params = [1];
            const filter = service.processFilter(2, params, [
                { name: 'sasMin', value: 'sixty' },
                { name: 'name', value: 'fun' }
            ]);

            expect(filter).not.toContain('SasRating');
            expect(filter).toContain('lower(d."Name") LIKE $2');
            expect(params).toEqual([1, '%fun%']);
        });

        // The list and its count must agree about what exists: both queries
        // need the DeckSas join or a bounded page would count unbounded rows.
        it('counts through the same DeckSas join the page reads through', async function () {
            await service.getNumDecksForUser(
                { id: 1 },
                { filter: [{ name: 'sasMin', value: 60 }] }
            );

            const [sql, params] = query.mock.calls[0];
            expect(sql).toContain('LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid"');
            expect(sql).toContain('AND ds."SasRating" >= $2');
            expect(params).toEqual([1, 60]);
        });
    });
});
