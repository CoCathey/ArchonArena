const logger = require('../../log');
const { previewById } = require('./previews');
const { COSMETICS, defaultChoice } = require('./cosmetics');

/**
 * ARCHON (N12): reads and writes what a member has CHOSEN - preview switches
 * and cosmetic slots.
 *
 * Deliberately not part of MembershipService. That service answers "what has
 * this account bought", which every authenticated request needs; this one
 * answers "what have they picked", which only the pages that render a choice
 * need. Merging them would put two extra joins on the checkauth path for data
 * almost nothing reads.
 *
 * Every read fails open to "no explicit choices", exactly as MembershipService
 * fails open to free: a missing table (the migration has not been run) or a
 * database hiccup should cost a player their preview switches for one request,
 * never break the page. What that degrades to is the registry defaults, which
 * is a working site.
 *
 * Nothing here decides entitlement. A stored row is a preference; whether it is
 * honoured is decided at read time by previews.js / cosmetics.js against live
 * capabilities, so a lapsed membership stops applying without this table being
 * touched.
 */
class MemberPreferencesService {
    constructor(db = require('../../db')) {
        this.db = db;
    }

    /**
     * The account's explicit preview answers.
     *
     * Explicit only - a preview with no row is absent rather than false, because
     * "never asked" and "turned off" are different states and only the registry
     * knows what the former means.
     *
     * @param {number} userId
     * @returns {Promise<Object<string, boolean>>}
     */
    async getPreviewChoices(userId) {
        if (!userId) {
            return {};
        }

        let rows;

        try {
            rows = await this.db.query(
                'SELECT "Preview", "Enabled" FROM "MembershipPreviews" WHERE "UserId" = $1',
                [userId]
            );
        } catch (err) {
            logger.error('Failed to read preview choices for user %s: %s', userId, err.message);

            return {};
        }

        const choices = {};

        for (const row of rows || []) {
            // A preview retired since the row was written is dropped here rather
            // than carried around as a key nothing recognises.
            if (previewById(row.Preview)) {
                choices[row.Preview] = !!row.Enabled;
            }
        }

        return choices;
    }

    /**
     * Record a switch.
     *
     * Stored even when it matches the current default: the point of an explicit
     * row is that it survives the default changing, which is the whole reason
     * somebody turns an experiment off.
     *
     * @param {number} userId
     * @param {string} previewId
     * @param {boolean} enabled
     */
    async setPreviewChoice(userId, previewId, enabled) {
        if (!userId || !previewById(previewId)) {
            return false;
        }

        try {
            await this.db.query(
                'INSERT INTO "MembershipPreviews" ("UserId", "Preview", "Enabled", "UpdatedAt") ' +
                    "VALUES ($1, $2, $3, now() AT TIME ZONE 'utc') " +
                    'ON CONFLICT ("UserId", "Preview") DO UPDATE SET ' +
                    '"Enabled" = EXCLUDED."Enabled", "UpdatedAt" = EXCLUDED."UpdatedAt"',
                [userId, previewId, !!enabled]
            );
        } catch (err) {
            logger.error('Failed to store preview choice for user %s: %s', userId, err.message);

            return false;
        }

        return true;
    }

    /**
     * The account's stored cosmetic choices, keyed by slot.
     *
     * Raw: whether the account may still USE them is decided by
     * cosmetics.publicCosmetics against live capabilities.
     *
     * @param {number} userId
     * @returns {Promise<Object<string, string>>}
     */
    async getCosmetics(userId) {
        if (!userId) {
            return {};
        }

        let rows;

        try {
            rows = await this.db.query(
                'SELECT "Slot", "Choice" FROM "MembershipCosmetics" WHERE "UserId" = $1',
                [userId]
            );
        } catch (err) {
            logger.error('Failed to read cosmetics for user %s: %s', userId, err.message);

            return {};
        }

        const chosen = {};

        for (const row of rows || []) {
            if (COSMETICS[row.Slot]) {
                chosen[row.Slot] = row.Choice;
            }
        }

        return chosen;
    }

    /**
     * Store a set of already-sanitised cosmetic choices.
     *
     * Takes the output of `cosmetics.sanitiseCosmetics` - this method does no
     * entitlement checking of its own, so there is exactly one place that
     * decides what may be stored rather than two that can disagree. A null
     * choice deletes the row, because the default is the absence of one.
     *
     * @param {number} userId
     * @param {Object<string, string|null>} choices slot -> option id, or null
     */
    async setCosmetics(userId, choices) {
        if (!userId || !choices || !Object.keys(choices).length) {
            return false;
        }

        for (const [slot, choice] of Object.entries(choices)) {
            if (!COSMETICS[slot]) {
                continue;
            }

            try {
                if (choice === null || choice === defaultChoice(slot)) {
                    await this.db.query(
                        'DELETE FROM "MembershipCosmetics" WHERE "UserId" = $1 AND "Slot" = $2',
                        [userId, slot]
                    );
                } else {
                    await this.db.query(
                        'INSERT INTO "MembershipCosmetics" ("UserId", "Slot", "Choice", "UpdatedAt") ' +
                            "VALUES ($1, $2, $3, now() AT TIME ZONE 'utc') " +
                            'ON CONFLICT ("UserId", "Slot") DO UPDATE SET ' +
                            '"Choice" = EXCLUDED."Choice", "UpdatedAt" = EXCLUDED."UpdatedAt"',
                        [userId, slot, choice]
                    );
                }
            } catch (err) {
                logger.error(
                    'Failed to store cosmetic %s for user %s: %s',
                    slot,
                    userId,
                    err.message
                );

                return false;
            }
        }

        return true;
    }
}

module.exports = MemberPreferencesService;
