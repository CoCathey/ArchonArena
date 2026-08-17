const logger = require('../../log');
const { REGISTRY, validateSection, sectionDefaults } = require('./registry');

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
        // ARCHON (N8): set by connectSettingsInvalidation() when Redis is
        // reachable. Null means "interval refresh only", which is exactly
        // what shipped before.
        this.publisher = null;
        this.channel = null;
        // ARCHON (N5): the audit trail. SiteSettings records only the LAST
        // editor, so "who turned rated play off in March" was unanswerable -
        // the next edit overwrote the answer. Settings changes now append to
        // the same moderation audit log every other privileged action does.
        // Injected rather than required so this module keeps no dependency on
        // moderation, and an audit failure can never block a settings write.
        this.auditService = null;
    }

    setAuditService(auditService) {
        this.auditService = auditService;
    }

    /**
     * ARCHON (N8): make a settings change take effect on every lobby at once.
     *
     * The interval refresh already converges - eventually. That is fine for a
     * rating tweak and wrong for a feature flag: the point of a flag is to
     * turn something off NOW, and a thirty-second window in which half the
     * lobbies still serve the broken feature is the window that matters.
     *
     * Pub/sub is an accelerator, never a dependency. The interval keeps
     * running underneath, so a Redis outage degrades the propagation delay
     * back to what it always was rather than freezing settings site-wide.
     */
    connectInvalidation(subscriber, publisher, prefix = '') {
        this.publisher = publisher;
        this.channel = `${prefix}settings:invalidate`;

        return subscriber.subscribe(this.channel, () => {
            // The message carries no payload on purpose - a snapshot pushed
            // over the wire could arrive out of order and overwrite newer
            // state with older. "Something changed, go and look" cannot.
            this.refresh();
        });
    }

    publishInvalidation() {
        if (!this.publisher || !this.channel) {
            return;
        }

        try {
            const result = this.publisher.publish(this.channel, '1');

            // node-redis returns a promise; a publish failure must not fail
            // the write that already committed.
            if (result && typeof result.catch === 'function') {
                result.catch((err) =>
                    logger.warn(`Failed to publish settings invalidation: ${err.message}`)
                );
            }
        } catch (err) {
            logger.warn(`Failed to publish settings invalidation: ${err.message}`);
        }
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
     * A section's registry defaults with any stored overrides merged over
     * them. Sections that also have file config (rating, dok) layer that in
     * themselves; this is for registry-only sections, so a caller never has to
     * restate a default the admin UI already publishes.
     */
    getSectionWithDefaults(section) {
        return { ...sectionDefaults(section), ...this.getSection(section) };
    }

    /**
     * Validate and persist overrides for a section, then refresh the
     * snapshot so the change applies immediately in this process.
     */
    async setSection(section, value, userId, username = null) {
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
        this.publishInvalidation();
        // The value itself goes into the entry: knowing that 'rating' changed
        // without knowing what it changed to is not an audit trail.
        this.auditService?.audit({ id: userId, username }, 'settings.update', {
            targetType: 'settings',
            targetName: section,
            detail: { section, value }
        });
        logger.info(`Site settings '${section}' updated by user ${userId}`);

        return { success: true };
    }

    /**
     * Remove a section's overrides (revert to code/file defaults).
     */
    async resetSection(section, userId, username = null) {
        if (!REGISTRY[section]) {
            return { success: false, message: `Unknown settings section '${section}'` };
        }

        await this.db.query('DELETE FROM "SiteSettings" WHERE "Key" = $1', [section]);
        await this.refresh();
        this.publishInvalidation();
        this.auditService?.audit({ id: userId, username }, 'settings.reset', {
            targetType: 'settings',
            targetName: section,
            detail: { section }
        });
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
                // ARCHON (F9): which admin screen edits this section. Absent
                // for all but a few: the general Site Settings screen shows
                // every section that does not name a screen of its own, and
                // that screen shows its own. Storage, validation and the
                // audit trail are identical either way.
                page: definition.page,
                fields: definition.fields,
                overrides: this.getSection(key),
                audit: audit[key] || null
            };
        }

        return sections;
    }
}

module.exports = SettingsService;
