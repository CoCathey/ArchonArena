const {
    visibleRows,
    compareSortValues,
    matchesColumnFilters
} = require('../../client/Components/Table/tableRows');

/**
 * ARCHON: the table's rows, and the one rule that made "My Decks" lie.
 *
 * The deck list is paged by the server - fifteen rows of a collection that can
 * run to hundreds - and the table sorted whatever rows it held. Clicking SAS
 * therefore reordered the fifteen rows on screen: the deck at the top was the
 * best deck on that page, presented identically to the best deck you own. No
 * error, no empty state, no way to tell.
 *
 * So the remote path asserts an absence: given a page, `visibleRows` returns it
 * untouched, in the order it arrived. The sort belongs to the query, which is
 * the only party that can see the whole collection. The local path keeps
 * sorting, because there a table's rows and the collection are the same thing.
 */
describe('table rows', function () {
    const column = (id) => ({ id, accessorKey: id });
    const columnById = { sas: column('sas'), name: column('name') };

    const page = [
        { id: 1, sas: 70, name: 'Beta' },
        { id: 2, sas: 90, name: 'Alpha' },
        { id: 3, sas: 80, name: 'Gamma' }
    ];

    describe('remote mode', function () {
        it('returns the server page in the server order', function () {
            const rows = visibleRows({
                rows: page,
                remote: true,
                columnById,
                sortDescriptor: { column: 'sas', direction: 'descending' }
            });

            // Not 90, 80, 70. Those three rows are page one of an order the
            // query already chose; re-ranking them here would answer "highest
            // SAS" with "highest SAS among these fifteen".
            expect(rows.map((row) => row.id)).toEqual([1, 2, 3]);
        });

        it('leaves filtering to the query as well', function () {
            const rows = visibleRows({
                rows: page,
                remote: true,
                columnFilters: { name: 'zzz' },
                columnById
            });

            // A filter applied to a page hides rows the pager is still counting,
            // so the reader gets "3 items" over an empty table.
            expect(rows).toHaveLength(3);
        });

        it('still tags rows with react ids', function () {
            const rows = visibleRows({ rows: page, remote: true, columnById });

            expect(rows.map((row) => row.__reactTableId)).toEqual(['1', '2', '3']);
            expect(rows[2].__reactTableIndex).toBe(2);
        });
    });

    describe('local mode', function () {
        it('sorts, because here the rows are the whole collection', function () {
            const rows = visibleRows({
                rows: page,
                columnById,
                sortDescriptor: { column: 'sas', direction: 'descending' }
            });

            expect(rows.map((row) => row.sas)).toEqual([90, 80, 70]);
        });

        it('sorts ascending when asked', function () {
            const rows = visibleRows({
                rows: page,
                columnById,
                sortDescriptor: { column: 'name', direction: 'ascending' }
            });

            expect(rows.map((row) => row.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
        });

        it('filters on a substring, case-insensitively', function () {
            const rows = visibleRows({ rows: page, columnFilters: { name: 'ET' }, columnById });

            expect(rows.map((row) => row.name)).toEqual(['Beta']);
        });

        it('leaves the order alone when no column is sorted', function () {
            const rows = visibleRows({ rows: page, columnById, sortDescriptor: {} });

            expect(rows.map((row) => row.id)).toEqual([1, 2, 3]);
        });

        it('ignores a sort on a column the table does not have', function () {
            const rows = visibleRows({
                rows: page,
                columnById,
                sortDescriptor: { column: 'nope', direction: 'descending' }
            });

            expect(rows.map((row) => row.id)).toEqual([1, 2, 3]);
        });
    });

    describe('comparison', function () {
        it('compares numbers as numbers, not as text', function () {
            expect(compareSortValues(9, 80)).toBeLessThan(0);
        });

        // A deck DoK has never rated is not a deck rated zero: unknown sorts
        // before known ascending, which puts it last in a "highest first" list.
        it('sorts a missing value before a present one', function () {
            expect(compareSortValues(null, 0)).toBe(-1);
            expect(compareSortValues(undefined, 0)).toBe(-1);
            expect(compareSortValues(null, null)).toBe(0);
        });

        it('drops rows with no value for an active filter', function () {
            expect(matchesColumnFilters({ name: null }, { name: 'a' }, columnById)).toBe(false);
        });

        it('treats a blank filter as no filter', function () {
            expect(matchesColumnFilters({ name: null }, { name: '   ' }, columnById)).toBe(true);
        });
    });
});
