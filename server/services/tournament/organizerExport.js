/**
 * ARCHON (N12): event exports - the first thing behind ORGANIZER_TOOLS.
 *
 * Vault Master promises "extra capability for running events for other people".
 * The gap that promise was written about is a real one and organisers hit it on
 * the day of every event: everything the platform knows about their tournament
 * is on a web page, and the moment they need it anywhere else - a prize
 * spreadsheet, a league table kept elsewhere, a results post, a stewards'
 * enquiry into one match - they are retyping it out of a browser.
 *
 * So: the event's own data, as CSV, for the people running it.
 *
 * ## Why this file is pure
 *
 * Every dataset is built from the payload `TournamentService.getDetail` already
 * returns - the same object the tournament page renders from. Nothing here
 * queries. That means an export cannot disagree with the screen the organiser
 * is looking at (a class of bug that is very hard to notice and very annoying
 * to be on the wrong end of at an event), and it means the whole module is
 * testable without a database.
 *
 * ## Authorisation is NOT here
 *
 * `getDetail` is called with the requesting user and reports `canManage`. The
 * route checks that, and the capability, before calling any of this. This file
 * assumes it is being handed data its caller was already entitled to read - it
 * does not redact, because a half-redacted export is worse than no export: an
 * organiser cannot tell which columns are missing.
 */

/**
 * The datasets an organiser can take away.
 *
 * Each is a flat table on purpose. CSV is what it is because it opens in the
 * thing the organiser already uses, and nesting does not survive that trip.
 */
const DATASETS = Object.freeze({
    STANDINGS: 'standings',
    PAIRINGS: 'pairings',
    PLAYERS: 'players'
});

const DATASET_IDS = Object.values(DATASETS);

/** A blank cell, so a missing value never renders as 'null' or 'undefined'. */
const blank = (value) => (value === null || value === undefined ? '' : value);

const yesNo = (value) => (value ? 'yes' : 'no');

/** Percentages as they are read, not as they are stored. */
const percent = (rate) =>
    rate === null || rate === undefined ? '' : `${(Number(rate) * 100).toFixed(1)}%`;

const isoOrBlank = (value) => {
    if (!value) {
        return '';
    }

    const date = value instanceof Date ? value : new Date(value);

    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};

/**
 * Final standings, in the order the page shows them.
 *
 * Tiebreakers are included as their own columns rather than folded into a rank,
 * because "why am I eighth and not seventh" is the single most common question
 * an organiser is asked, and the answer is a column.
 */
function standingsRows(detail) {
    const decksByUser = new Map((detail.players || []).map((player) => [player.userId, player]));

    return {
        columns: [
            'rank',
            'player',
            'matchPoints',
            'wins',
            'losses',
            'byes',
            'gameWins',
            'gameLosses',
            'matchWinRate',
            'gameWinRate',
            'opponentMatchWinRate',
            'opponentGameWinRate',
            'dropped',
            'finalRank',
            'deck',
            'deckSas'
        ],
        rows: (detail.standings || []).map((entry, index) => {
            const player = decksByUser.get(entry.id) || {};

            return [
                // `rank` on the entry is the live standings position; when an
                // event is complete the page has already re-sorted by
                // finalRank, so the row number is what the reader sees.
                index + 1,
                blank(entry.username),
                blank(entry.points),
                blank(entry.wins),
                blank(entry.losses),
                blank(entry.byes),
                blank(entry.gameWins),
                blank(entry.gameLosses),
                percent(entry.matchWinRate),
                percent(entry.gameWinRate),
                percent(entry.opponentMatchWinRate),
                percent(entry.opponentGameWinRate),
                yesNo(entry.dropped),
                blank(entry.finalRank),
                blank(player.deckName),
                blank(player.deckSas)
            ];
        })
    };
}

/**
 * Every pairing, every round.
 *
 * Includes the rows that are not decided yet - an organiser exporting mid-event
 * is usually doing it precisely to see what is outstanding - and says who
 * reported a result and whether the opponent confirmed it, because that is the
 * paperwork behind a disputed match.
 */
function pairingsRows(detail) {
    const nameById = new Map(
        (detail.players || []).map((player) => [player.userId, player.username])
    );
    const nameOf = (id) => (id ? nameById.get(id) || '' : '');

    return {
        columns: [
            'round',
            'table',
            'bracket',
            'player1',
            'player2',
            'player1Wins',
            'player2Wins',
            'winner',
            'result',
            'confirmed',
            'disputedBy',
            'scheduledAt'
        ],
        rows: (detail.matches || [])
            .slice()
            .sort((a, b) => a.round - b.round || (a.table || 0) - (b.table || 0))
            .map((match) => [
                blank(match.round),
                blank(match.table),
                blank(match.bracket),
                blank(match.player1 || nameOf(match.player1Id)),
                // A bye has no second player. Saying so beats an empty cell the
                // reader has to interpret.
                match.player2 || nameOf(match.player2Id) || 'bye',
                blank(match.player1Wins),
                blank(match.player2Wins),
                nameOf(match.winnerId),
                blank(match.resultType),
                match.winnerId ? yesNo(match.confirmed) : '',
                nameOf(match.disputedBy),
                isoOrBlank(match.scheduledAt)
            ])
    };
}

/**
 * The entry list, as the desk needs it: who is in, who paid, who checked in,
 * what they registered.
 */
function playersRows(detail) {
    const feeCharged = !!(detail.tournament && detail.tournament.entryFeeCents);

    const columns = [
        'player',
        'seed',
        'status',
        'checkedIn',
        'deck',
        'deckSas',
        'amber',
        'eventChains',
        'finalRank'
    ];

    // Payment columns only where there is a fee to pay: an empty 'paid' column
    // on a free event reads as "nobody has paid".
    if (feeCharged) {
        columns.splice(4, 0, 'paid', 'paidAt', 'paidBy');
    }

    const statusOf = (player) => {
        if (player.dropped) {
            return 'dropped';
        }

        return player.waitlisted ? 'waitlisted' : 'registered';
    };

    return {
        columns,
        rows: (detail.players || []).map((player) => {
            const row = [
                blank(player.username),
                blank(player.seed),
                statusOf(player),
                yesNo(player.checkedIn)
            ];

            if (feeCharged) {
                row.push(yesNo(player.paid), isoOrBlank(player.paidAt), blank(player.paidBy));
            }

            row.push(
                blank(player.deckName),
                blank(player.deckSas),
                blank(player.amber),
                blank(player.eventChains),
                blank(player.finalRank)
            );

            return row;
        })
    };
}

const BUILDERS = {
    [DATASETS.STANDINGS]: standingsRows,
    [DATASETS.PAIRINGS]: pairingsRows,
    [DATASETS.PLAYERS]: playersRows
};

/**
 * A cell, escaped for CSV.
 *
 * Two separate concerns, and only one of them is CSV:
 *
 *  1. RFC 4180 quoting, so a deck called `Ortannu, the Chained` does not become
 *     two columns.
 *  2. Formula injection. A spreadsheet treats a cell beginning `=`, `+`, `-`,
 *     `@`, or a lone tab/CR as a formula, and player-supplied strings reach
 *     this file - usernames, deck names, dispute notes. An export is a file an
 *     organiser opens on their own machine, which makes it the one place on
 *     this site where hostile text gets to be code. Prefixing with an
 *     apostrophe is the standard defence and is invisible in every spreadsheet
 *     that understands it.
 */
function csvCell(value) {
    let text = value === null || value === undefined ? '' : String(value);

    if (/^[=+\-@\t\r]/.test(text)) {
        text = `'${text}`;
    }

    if (/["\n\r,]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }

    return text;
}

/**
 * @param {{columns: string[], rows: Array<Array>}} table
 * @returns {string}
 */
function toCsv(table) {
    // CRLF: RFC 4180, and the thing that stops Excel on Windows reading the
    // whole file as one row.
    return [table.columns, ...table.rows]
        .map((row) => row.map(csvCell).join(','))
        .join('\r\n')
        .concat('\r\n');
}

/** A filename an organiser can find again a week later. */
function exportFilename(detail, dataset) {
    const name = String((detail.tournament && detail.tournament.name) || 'tournament')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);

    return `${name || 'tournament'}-${dataset}.csv`;
}

/**
 * Build one dataset from a `getDetail` payload.
 *
 * @param {object} detail
 * @param {string} dataset one of DATASETS
 * @returns {{dataset: string, columns: string[], rows: Array<Array>, filename: string}|null}
 *          null for an unknown dataset, so the route can 400 rather than
 *          serving an empty file that looks like an event with no players in it
 */
function buildExport(detail, dataset) {
    const build = BUILDERS[dataset];

    if (!build || !detail) {
        return null;
    }

    const table = build(detail);

    return {
        dataset,
        columns: table.columns,
        rows: table.rows,
        filename: exportFilename(detail, dataset)
    };
}

module.exports = {
    DATASETS,
    DATASET_IDS,
    buildExport,
    toCsv,
    csvCell,
    exportFilename
};
