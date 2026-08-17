const MemberDirectoryService = require('../../../../server/services/community/MemberDirectoryService');

/**
 * ARCHON (F9): the member directory lists PEOPLE.
 *
 * The practice bots are ordinary accounts on purpose - that is what lets
 * them hold a lobby seat, a deck and a picture without a second kind of
 * player existing anywhere. The cost of that decision is that surfaces
 * about the community have to say "people only" explicitly, and this is the
 * one that would otherwise offer thirteen computers as members to browse
 * and to search for.
 */
describe('the member directory', function () {
    const capture = () => {
        const queries = [];

        return {
            queries,
            db: {
                query: async (sql, params) => {
                    queries.push({ sql, params });

                    return [{ Total: '2', Joined24h: '1' }];
                }
            }
        };
    };

    it('leaves the bots out of the browsable list', async function () {
        const { db, queries } = capture();

        await new MemberDirectoryService(db).search({ limit: 25 });

        expect(queries[0].sql).toContain("NOT LIKE '%@archon-bots.invalid'");
    });

    it('leaves them out of a search by name, so they cannot be looked up', async function () {
        const { db, queries } = capture();

        await new MemberDirectoryService(db).search({ query: 'HelperBot' });

        expect(queries[0].sql).toContain("NOT LIKE '%@archon-bots.invalid'");
        expect(queries[0].params).toContain('%HelperBot%');
    });

    it('counts the same population it lists', async function () {
        const { db, queries } = capture();

        await new MemberDirectoryService(db).stats();

        // A tile that counted bots would overstate a directory nobody can
        // page through to them.
        expect(queries[0].sql).toContain("NOT LIKE '%@archon-bots.invalid'");
    });
});
