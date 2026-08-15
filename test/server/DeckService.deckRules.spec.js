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

    /**
     * The roll takes two queries - count the eligible decks, then take the
     * row at a cryptographically chosen offset - so the collection is sized
     * first and the pick made in Node rather than by Postgres's `random()`.
     * `owning(n)` stands in for a collection of n decks.
     */
    const owning = (total, row = { Id: 42 }) =>
        query.mockResolvedValueOnce([{ Total: total }]).mockResolvedValueOnce([row]);

    const countCall = () => query.mock.calls[0];
    const fetchCall = () => query.mock.calls[1];

    describe('getRandomDeckIdForUser', function () {
        it('draws from all of a user own decks, ordered by chance', async function () {
            owning(5);

            const id = await service.getRandomDeckIdForUser(11, {
                isAlliance: false,
                unchainedOnly: false
            });

            expect(id).toBe(42);

            const [sql, params] = fetchCall();
            expect(sql).toContain('ORDER BY d."Id" OFFSET $3 LIMIT 1');
            expect(sql).toContain('d."UserId" = $1');
            expect(sql).toContain('d."IsAlliance" = $2');
            expect(sql).toContain('e."ExpansionId" <> 601');
            expect(params.slice(0, 2)).toEqual([11, false]);
            expect(params[2]).toBeGreaterThanOrEqual(0);
            expect(params[2]).toBeLessThan(5);
        });

        /**
         * The one way a counted offset goes wrong: if the two queries disagree
         * about what is eligible, the offset indexes into a set that is not the
         * one that was measured - which either picks an ineligible deck or
         * falls off the end and reports the user has none.
         */
        it('counts exactly the set it then reads from', async function () {
            owning(9);

            await service.getRandomDeckIdForUser(11, {
                isAlliance: true,
                sasMin: 60,
                sasMax: 80
            });

            // The count has no ORDER BY, so its filter runs to the end.
            const where = (sql) => {
                const ordered = sql.indexOf('ORDER BY');

                return sql.slice(sql.indexOf('WHERE'), ordered === -1 ? undefined : ordered).trim();
            };

            expect(where(countCall()[0])).toBe(where(fetchCall()[0]));
            expect(where(fetchCall()[0])).toContain('ds."SasRating"');
            expect(fetchCall()[1].slice(0, -1)).toEqual(countCall()[1]);
        });

        // Every deck must be reachable - including the first and the last,
        // which an off-by-one in the offset is exactly what would lose.
        it('can reach every deck in the collection', async function () {
            const seen = new Set();

            for (let roll = 0; roll < 300; roll++) {
                query.mockClear();
                owning(4);
                await service.getRandomDeckIdForUser(11, {});
                seen.add(fetchCall()[1].at(-1));
            }

            expect([...seen].sort()).toEqual([0, 1, 2, 3]);
        });

        it('restricts an unchained game to the unchained set', async function () {
            owning(3);

            await service.getRandomDeckIdForUser(11, { isAlliance: false, unchainedOnly: true });

            const [sql] = fetchCall();
            expect(sql).toContain('e."ExpansionId" = 601');
            expect(sql).not.toContain('<> 601');
        });

        it('leaves alliance membership open when the game does', async function () {
            owning(3);

            await service.getRandomDeckIdForUser(11, {});

            const [sql, params] = fetchCall();
            expect(sql).not.toContain('"IsAlliance"');
            expect(params.slice(0, -1)).toEqual([11]);
        });

        // The SAS comparisons ride on the DeckSas join; NULL fails both, so a
        // deck DoK has not rated can never be rolled into a bounded game.
        it('applies a SAS bound to the roll', async function () {
            owning(3);

            await service.getRandomDeckIdForUser(11, {
                isAlliance: false,
                sasMin: 60,
                sasMax: 80
            });

            const [sql, params] = fetchCall();
            expect(sql).toContain('ds."SasRating" >= $3');
            expect(sql).toContain('ds."SasRating" <= $4');
            expect(params.slice(0, -1)).toEqual([11, false, 60, 80]);
        });

        it('reports no deck as null, both for empty results and for errors', async function () {
            // Nothing eligible: the count answers zero and no row is read.
            expect(await service.getRandomDeckIdForUser(11, {})).toBeNull();
            expect(query).toHaveBeenCalledTimes(1);

            query.mockRejectedValue(new Error('db down'));
            expect(await service.getRandomDeckIdForUser(11, {})).toBeNull();
        });
    });

    /**
     * ARCHON: the Unchained set (601) is playable only in an Unchained game and
     * is the only thing playable there.
     *
     * getRandomDeckIdForUser has always applied this. The deck LIST never did,
     * so "roll me a deck" and "let me choose one" disagreed about what was
     * legal - the dice would refuse a deck the list had just offered.
     */
    describe('the Unchained set filter', function () {
        it('restricts the list to the Unchained set in an Unchained game', function () {
            const params = [1];
            const filter = service.processFilter(2, params, [{ name: 'unchained', value: true }]);

            expect(filter).toContain('AND e."ExpansionId" = 601');
            // A constant, not input - it must not consume a placeholder.
            expect(params).toEqual([1]);
        });

        it('excludes the Unchained set everywhere else', function () {
            const filter = service.processFilter(2, [1], [{ name: 'unchained', value: false }]);

            expect(filter).toContain('AND e."ExpansionId" <> 601');
        });

        it('leaves the set alone when no opinion is given', function () {
            // The deck library outside a game lists everything.
            const filter = service.processFilter(2, [1], [{ name: 'name', value: 'fun' }]);

            expect(filter).not.toContain('ExpansionId');
        });

        it('filters the list the same way the dice do', function () {
            // The two paths must agree; the whole bug was that they did not.
            const listed = service.processFilter(2, [1], [{ name: 'unchained', value: true }]);

            expect(listed).toContain('e."ExpansionId" = 601');
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
