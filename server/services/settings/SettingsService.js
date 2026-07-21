const logger = require('../../log');
const { REGISTRY, validateSection } = require('./registry');

/**
 * Runtime admin-editable settings, backed by the SiteSettings table.
 *
 * Reads are synchronous from an in-memory snapshot so hot paths (rating
 * a game, serving deck lists) never wait on the database; the snapshot
 * refreshes on an interval and immediately after every write. On a
 * multi-instance deployment each lobby converges within one refresh
 * interval (Redis pub/sub invalidation is a future upgrade, noted in
 * the design doc).
 */
class SettingsService {
    constructor(db = require('../../db')) {
        this.db = db;
        this.cache = {};
        this.loaded = false;
        this.timer = null;
    }

    /**
     * Load the snapshot and start periodic refreshes. Call once from the
     * lobby process at startup. Safe to call in environments without the
     * table yet (logs and retries on the next interval).
     */
    start(intervalMs = 30000) {
        this.refresh();
        this.timer = setInterval(() => this.refresh(), intervalMs);

        if (this.timer.unref) {
            this.timer.unref();
        }
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    async refresh() {
        try {
            const rows = await this.db.query('SELECT "Key", "Value" FROM "SiteSettings"', []);
            const next = {};

            for (const row of rows || []) {
                next[row.Key] =
                    typeof row.Value === 'string' ? JSON.parse(row.Value) : row.Value || {};
            }

            this.cache = next;
            this.loaded = true;
        } catch (err) {
            logger.warn(`Failed to refresh site settings: ${err.message}`);
        }
    }

    /**
     * Synchronous overrides for one section from the snapshot ({} when
     * none are stored or the snapshot has not loaded yet).
     */
    getSection(section) {
        return this.cache[section] || {};
    }

    /**
     * Validate and persist overrides for a section, then refresh the
     * snapshot so the change applies immediately in this process.
     */
    async setSection(section, value, userId) {
        const errors = validateSection(section, value);

        if (errors.length > 0) {
            return { success: false, message: errors.join('; ') };
        }

        await this.db.query(
            'INSERT INTO "SiteSettings" ("Key", "Value", "UpdatedBy", "UpdatedAt") ' +
                "VALUES ($1, $2, $3, now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("Key") DO UPDATE SET "Value" = $2, "UpdatedBy" = $3, ' +
                '"UpdatedAt" = now() AT TIME ZONE \'utc\'',
            [section, JSON.stringify(value), userId || null]
        );

        await this.refresh();
        logger.info(`Site settings '${section}' updated by user ${userId}`);

        return { success: true };
    }

    /**
     * Remove a section's overrides (revert to code/file defaults).
     */
    async resetSection(section, userId) {
        if (!REGISTRY[section]) {
            return { success: false, message: `Unknown settings section '${section}'` };
        }

        await this.db.query('DELETE FROM "SiteSettings" WHERE "Key" = $1', [section]);
        await this.refresh();
        logger.info(`Site settings '${section}' reset by user ${userId}`);

        return { success: true };
    }

    /**
     * Registry + current overrides + audit info for the admin UI.
     */
    async describe() {
        let audit = {};
        try {
            const rows = await this.db.query(
                'SELECT s."Key", s."UpdatedAt", u."Username" FROM "SiteSettings" s ' +
                    'LEFT JOIN "Users" u ON u."Id" = s."UpdatedBy"',
                []
            );
            for (const row of rows || []) {
                audit[row.Key] = { updatedAt: row.UpdatedAt, updatedBy: row.Username };
            }
        } catch (err) {
            logger.warn(`Failed to load settings audit info: ${err.message}`);
        }

        const sections = {};
        for (const [key, definition] of Object.entries(REGISTRY)) {
            sections[key] = {
                title: definition.title,
                description: definition.description,
                fields: definition.fields,
                overrides: this.getSection(key),
                audit: audit[key] || null
            };
        }

        return sections;
    }
}

module.exports = SettingsService;
