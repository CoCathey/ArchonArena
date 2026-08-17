/**
 * Which rows a table shows, and in what order.
 *
 * This lived inside ReactTable as one `useMemo`, and it held a defect that is
 * hard to see from inside a render function: it sorted whatever rows it had.
 * For a local table that is every row, and sorting them is the whole job. For a
 * REMOTE table the rows are one page of a collection the server ordered - so
 * re-sorting them reorders fifteen rows out of nine hundred and presents the
 * result as "sorted by SAS". Every value on screen is real, the order is real,
 * and the answer is wrong: it is the top of a page, not the top of a
 * collection, and nothing about it looks wrong.
 *
 * So the rule is stated once, here, with a name: in remote mode the server's
 * order IS the order, and a column the server cannot sort by has to be fixed at
 * the server rather than papered over on the client. Same for filtering, which
 * the remote path has always deferred - a filter applied to one page would drop
 * rows from the page while the pager kept counting them.
 */

/** A stable react key for a row, preferring whatever id the data carries. */
export const getRowId = (row, fallback = 0) => String(row?.id ?? row?.uuid ?? row?.key ?? fallback);

/** The value a column displays for a row, however the column names it. */
export const getColumnValue = (column, rowData) => {
    if (typeof column?.accessorFn === 'function') {
        return column.accessorFn(rowData);
    }

    if (column?.accessorKey) {
        return rowData?.[column.accessorKey];
    }

    return rowData?.[column?.id];
};

/**
 * Ascending comparison of two cell values. Missing values sort first, which
 * ascending order reads as "unknown before known"; descending flips it, so an
 * unrated deck never opens a "highest first" list.
 */
export const compareSortValues = (left, right) => {
    if (left == null && right == null) {
        return 0;
    }

    if (left == null) {
        return -1;
    }

    if (right == null) {
        return 1;
    }

    if (typeof left === 'number' && typeof right === 'number') {
        return left - right;
    }

    return String(left).localeCompare(String(right), undefined, { sensitivity: 'base' });
};

/** Does this row pass every active column filter? Substring, case-insensitive. */
export const matchesColumnFilters = (row, columnFilters = {}, columnById = {}) =>
    Object.entries(columnFilters).every(([columnId, value]) => {
        if (value === undefined || value === null || String(value).trim() === '') {
            return true;
        }

        const column = columnById[columnId];
        if (!column) {
            return true;
        }

        const cellValue = getColumnValue(column, row);
        if (cellValue === undefined || cellValue === null) {
            return false;
        }

        return String(cellValue).toLowerCase().includes(String(value).toLowerCase());
    });

/**
 * The rows to render, tagged with their react ids.
 *
 * @param {object} options
 * @param {object[]} options.rows Rows as received - every row locally, one page remotely.
 * @param {boolean} [options.remote] True when the server did the filtering, ordering and paging.
 * @param {object} [options.columnFilters] columnId -> filter text.
 * @param {object} [options.columnById] The table's columns, by id.
 * @param {{column?: string, direction?: string}} [options.sortDescriptor] The header the reader clicked.
 * @returns {object[]}
 */
export const visibleRows = ({
    rows,
    remote = false,
    columnFilters = {},
    columnById = {},
    sortDescriptor
} = {}) => {
    const tagged = (rows || [])
        .filter((row) => (remote ? true : matchesColumnFilters(row, columnFilters, columnById)))
        .map((row, index) => ({
            ...row,
            __reactTableId: getRowId(row, index),
            __reactTableIndex: index
        }));

    // The load-bearing line. A remote page arrives in the order the query
    // produced, over the whole collection; re-sorting it here can only turn a
    // correct answer into a plausible one.
    if (remote) {
        return tagged;
    }

    const sortColumn = columnById[sortDescriptor?.column];
    if (!sortColumn) {
        return tagged;
    }

    const direction = sortDescriptor?.direction === 'descending' ? -1 : 1;

    return [...tagged].sort(
        (left, right) =>
            compareSortValues(getColumnValue(sortColumn, left), getColumnValue(sortColumn, right)) *
            direction
    );
};
