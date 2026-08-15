/**
 * ARCHON: filtering anything by set, in one place.
 *
 * ## Two different numbers are both called an expansion id
 *
 * `Expansions` carries both:
 *
 *   "Id"          1, 2, 3 …    a surrogate key, meaningless outside the database
 *   "ExpansionId" 341, 800 …   the set code the whole world uses
 *
 * `Decks."ExpansionId"` is a foreign key to the FIRST of those - the surrogate -
 * while everything a player or an organiser ever types is the SECOND. The client
 * constants, an event's AllowedSets, the deck picker's filters and the URLs on
 * these endpoints all speak in set codes.
 *
 * Confusing the two does not produce an error. It produces a comparison between
 * 15 and 907 that is simply false, and a filter that silently matches nothing.
 * That is exactly what had happened in tournament deck validation, where a
 * set-restricted event rejected every deck that was registered for it.
 *
 * So no query in the intelligence services writes its own set predicate. They
 * all call `setPredicate`, which emits the join as an EXISTS - meaning it can be
 * bolted onto any query with a deck alias without adding a row-multiplying JOIN
 * or disturbing a GROUP BY.
 */

/**
 * Normalise whatever arrived - a query string, an array, a single number - into
 * a list of set codes.
 *
 * Unparseable entries are dropped rather than rejected: a filter is a narrowing
 * convenience, and failing a whole analytics request because one id in a URL was
 * junk would be a worse outcome than ignoring it.
 *
 * @param {string|number|Array} value
 * @returns {number[]} set codes, deduplicated; empty means "every set"
 */
const parseSets = (value) => {
    if (value === undefined || value === null || value === '') {
        return [];
    }

    const entries = Array.isArray(value) ? value : String(value).split(',');
    const codes = entries
        .map((entry) => parseInt(entry, 10))
        // Set codes are positive; the cap keeps a hostile URL from becoming a
        // pile of parameters.
        .filter((code) => Number.isFinite(code) && code > 0);

    return [...new Set(codes)].slice(0, 40);
};

/**
 * A SQL fragment restricting a deck to a set of set codes, appending the
 * parameter to `params` as it goes.
 *
 * Returns '' for an empty list, which every caller wants to mean "no
 * restriction" rather than "no results".
 *
 * @param {number[]} sets set codes from parseSets
 * @param {Array} params the query's parameter array, appended to in place
 * @param {string} deckAlias the alias of the "Decks" row to restrict
 */
const setPredicate = (sets, params, deckAlias = 'd') => {
    if (!sets || !sets.length) {
        return '';
    }

    params.push(sets);

    return (
        ` AND EXISTS (SELECT 1 FROM "Expansions" xset WHERE xset."Id" = ${deckAlias}."ExpansionId"` +
        ` AND xset."ExpansionId" = ANY($${params.length}))`
    );
};

/**
 * The columns to select, and the GROUP BY to match, when a query reports which
 * set each row belongs to. Kept together so the two cannot drift apart.
 */
const SET_COLUMNS = 'xe."ExpansionId" AS "setId", xe."Code" AS "setCode", xe."Name" AS "setName"';
const SET_JOIN = (deckAlias = 'd') =>
    ` JOIN "Expansions" xe ON xe."Id" = ${deckAlias}."ExpansionId"`;
const SET_GROUP_BY = 'xe."ExpansionId", xe."Code", xe."Name"';

/** The shape every endpoint returns a set in, so the client renders one thing. */
const asSet = (row) =>
    row && row.setId ? { id: Number(row.setId), code: row.setCode, name: row.setName } : null;

module.exports = {
    parseSets,
    setPredicate,
    SET_COLUMNS,
    SET_JOIN,
    SET_GROUP_BY,
    asSet
};
