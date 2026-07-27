const db = require('../db');

/**
 * ARCHON: site-wide statistics reset, for clearing beta and playtest data
 * before launch.
 *
 * The only reset that existed was per-player, per-pool (`adminResetRatings`),
 * which is useless for "we have been playtesting for three months and want the
 * ladder to start clean on launch day".
 *
 * Deliberately scoped per category rather than one opaque button, because these
 * are very different acts: wiping ratings is recoverable by playing again,
 * while wiping games destroys history that produced them. Accounts, decks,
 * clubs, stores and tournaments are never touched by any category - this resets
 * play data, not the community.
 *
 * Every call is a dry run unless `confirm` is true, so the caller can always
 * show exactly what is about to be destroyed first.
 */

const CATEGORIES = {
    // Order matters: children before parents, so foreign keys never block a
    // delete and a partially-selected reset cannot strand orphan rows.
    ratings: {
        label: 'Ratings and rating history (Amber)',
        tables: ['RatingHistory', 'Ratings']
    },
    replays: {
        label: 'Recorded game replays',
        tables: ['GameReplays']
    },
    games: {
        label: 'Game records (also removes replays and rating history)',
        tables: ['GameReplays', 'RatingHistory', 'GamePlayers', 'Games']
    },
    seasons: {
        label: 'Season records',
        tables: ['Seasons']
    }
};

class AdminResetService {
    constructor(database = db, options = {}) {
        this.db = database;
        // Injected so the statistics cache can be dropped after a reset;
        // without it the site would keep serving pre-reset aggregates.
        this.statisticsService = options.statisticsService;
    }

    /** The categories a caller may select, for the admin UI. */
    static categories() {
        return Object.entries(CATEGORIES).map(([key, value]) => ({
            key,
            label: value.label,
            tables: value.tables
        }));
    }

    /**
     * Tables covered by the requested categories, de-duplicated but kept in
     * child-before-parent order.
     */
    tablesFor(categories) {
        const selected = (categories || []).filter((key) => CATEGORIES[key]);
        const ordered = [];

        for (const key of Object.keys(CATEGORIES)) {
            if (!selected.includes(key)) {
                continue;
            }

            for (const table of CATEGORIES[key].tables) {
                if (!ordered.includes(table)) {
                    ordered.push(table);
                }
            }
        }

        return ordered;
    }

    async countRows(table) {
        const rows = await this.db.query(`SELECT COUNT(*) AS "count" FROM "${table}"`);

        return Number(rows && rows[0] ? rows[0].count : 0);
    }

    /**
     * @param {object} options
     * @param {string[]} options.categories  category keys to reset
     * @param {boolean} [options.confirm]    false/absent = dry run, delete nothing
     * @param {string} [options.actor]       username, for the log
     */
    async reset({ categories, confirm = false, actor } = {}) {
        const unknown = (categories || []).filter((key) => !CATEGORIES[key]);

        if (unknown.length > 0) {
            return { success: false, message: `Unknown categories: ${unknown.join(', ')}` };
        }

        const tables = this.tablesFor(categories);

        if (tables.length === 0) {
            return { success: false, message: 'Select at least one category to reset.' };
        }

        // Count first, always - a dry run returns exactly this and stops.
        const counts = {};
        for (const table of tables) {
            counts[table] = await this.countRows(table);
        }

        const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

        if (!confirm) {
            return { success: true, dryRun: true, tables, counts, total };
        }

        // One transaction: a reset that half-applied would leave, say, ratings
        // without the history that justifies them.
        const client = await this.db.startTransaction();

        try {
            for (const table of tables) {
                await this.db.queryTran(client, `DELETE FROM "${table}"`);
            }

            await this.db.queryTran(client, 'COMMIT');
        } catch (err) {
            await this.db.queryTran(client, 'ROLLBACK').catch(() => {});
            client.release();

            throw err;
        }

        client.release();

        if (this.statisticsService) {
            this.statisticsService.clearCache();
        }

        return { success: true, dryRun: false, tables, counts, total, actor };
    }
}

module.exports = AdminResetService;
module.exports.CATEGORIES = CATEGORIES;
