const logger = require('../../log');
const {
    SLOT_IDS,
    defaultCosmetics,
    sanitizeCosmetics,
    resolveCosmetics
} = require('../membership/cosmetics');

/**
 * ARCHON (N12): storage for a member's profile cosmetics.
 *
 * Thin on purpose. Which cosmetics exist and who may use them is
 * `server/services/membership/cosmetics.js`; this only reads and writes the
 * row, and every read tolerates the table not being there - a deployment that
 * has not run the migration shows default profiles rather than 500s, the same
 * bargain the membership lookups make.
 */

/** DB column per slot id. */
const COLUMNS = Object.freeze({
    accent: 'Accent',
    banner: 'Banner',
    frame: 'Frame',
    title: 'Title',
    nameEffect: 'NameEffect'
});

/** @param {object|null|undefined} row @returns {object} a full selection */
function cosmeticsFromDbRow(row) {
    const cosmetics = defaultCosmetics();

    if (!row) {
        return cosmetics;
    }

    for (const slot of SLOT_IDS) {
        const value = row[COLUMNS[slot]];

        if (value) {
            cosmetics[slot] = value;
        }
    }

    return cosmetics;
}

class ProfileCosmeticsService {
    constructor(db = require('../../db')) {
        this.db = db;
    }

    /**
     * The stored selection, defaults where nothing is set.
     *
     * Unfiltered - this is what the owner chose, not what may currently be
     * displayed. Callers that render pass it through `resolveCosmetics`.
     *
     * @param {number} userId
     * @returns {Promise<object>}
     */
    async get(userId) {
        try {
            const rows = await this.db.query(
                'SELECT * FROM "ProfileCosmetics" WHERE "UserId" = $1',
                [userId]
            );

            return cosmeticsFromDbRow(rows && rows[0]);
        } catch (err) {
            logger.warn('Failed to look up profile cosmetics', err);

            return defaultCosmetics();
        }
    }

    /**
     * Save a partial selection.
     *
     * Partial by design: the editor saves the slot that changed, and a slot
     * that is not mentioned keeps whatever it had. A slot set to null or ''
     * resets to its default, which is how "None" is stored.
     *
     * @param {number} userId
     * @param {object} input the raw selection from the client
     * @param {string[]} capabilities the caller's entitlements
     * @returns {Promise<{success: boolean, message?: string, cosmetics?: object}>}
     */
    async save(userId, input, capabilities) {
        const { cosmetics, rejected } = sanitizeCosmetics(input, capabilities);

        if (rejected.length) {
            // Named, so the client can highlight the picker rather than
            // showing a generic failure over a page of valid choices.
            return {
                success: false,
                message: 'Some of those options are not part of your membership.',
                rejected,
                upgradeRequired: true
            };
        }

        const slots = Object.keys(cosmetics);

        if (!slots.length) {
            return { success: true, cosmetics: await this.get(userId) };
        }

        const columns = slots.map((slot) => COLUMNS[slot]);
        // $1 is the user id; the values follow in the same order as `slots`.
        const placeholders = slots.map((slot, index) => `$${index + 2}`);
        const values = slots.map((slot) => cosmetics[slot]);
        const updates = columns
            .map((column, index) => `"${column}" = ${placeholders[index]}`)
            .concat('"UpdatedAt" = (now() AT TIME ZONE \'utc\')')
            .join(', ');

        try {
            await this.db.query(
                `INSERT INTO "ProfileCosmetics" ("UserId", ${columns
                    .map((column) => `"${column}"`)
                    .join(', ')}) VALUES ($1, ${placeholders.join(', ')}) ` +
                    `ON CONFLICT ("UserId") DO UPDATE SET ${updates}`,
                [userId, ...values]
            );
        } catch (err) {
            logger.error('Failed to save profile cosmetics', err);

            return { success: false, message: 'Could not save your profile customisation.' };
        }

        return { success: true, cosmetics: await this.get(userId) };
    }

    /**
     * What to display for a user, already filtered against their entitlements.
     *
     * @param {number} userId
     * @param {string[]} capabilities the OWNER's capabilities
     */
    async resolvedFor(userId, capabilities) {
        return resolveCosmetics(await this.get(userId), capabilities);
    }
}

module.exports = ProfileCosmeticsService;
module.exports.COLUMNS = COLUMNS;
module.exports.cosmeticsFromDbRow = cosmeticsFromDbRow;
