const logger = require('../../log');
const { renderHtmlEmail, renderTextEmail } = require('../emailTemplate');
const {
    CATEGORY_KEYS,
    isKnownCategory,
    categoryDefaults,
    describeCategories
} = require('./taxonomy');

/**
 * ARCHON: notifications (N2).
 *
 * Tournaments and the asynchronous community features are only useful if
 * players are told things happened; round pairings in particular are unusable
 * without a ping. This is the single place that decides whether a given player
 * wants a given event, records it for the in-app centre, and hands the email
 * off to SES.
 *
 * Two constraints shape the whole design:
 *
 *  - **Nothing here may block or slow a gameplay or tournament operation.**
 *    `notify()` never throws and never rejects; every caller invokes it
 *    fire-and-forget, and a database or SES failure is logged and dropped. A
 *    missed notification is a small harm; a pairing that fails to commit
 *    because the mail server is down is a large one.
 *  - **Opt-out is honoured server-side.** The preference is checked here, at
 *    the point of delivery, not at each call site - so a new trigger cannot
 *    forget to respect it.
 *
 * `db`, `emailService` and `now` are injectable, matching the other services,
 * so the whole thing is unit-testable without a database or AWS.
 */
class NotificationService {
    constructor(db = require('../../db'), options = {}) {
        this.db = db;
        // Optional: without it, in-app notifications still work and email is
        // simply skipped. The lobby injects the shared instance.
        this.emailService = options.emailService || null;
        this.configService = options.configService || null;
        this.now = options.now || (() => new Date());
        // Where links in emails point. Falls back to a relative path, which is
        // still meaningful in the in-app centre.
        this.siteUrl = options.siteUrl || '';
        this.appName = options.appName || 'Archon Arena';
    }

    /**
     * The effective delivery preference for one user and category: the
     * category's defaults with any stored override applied.
     */
    async getPreference(userId, category) {
        const defaults = categoryDefaults(category);

        try {
            const rows = await this.db.query(
                'SELECT "InApp", "Email" FROM "NotificationPreferences" ' +
                    'WHERE "UserId" = $1 AND "Category" = $2',
                [userId, category]
            );

            if (rows && rows[0]) {
                return { inApp: !!rows[0].InApp, email: !!rows[0].Email };
            }
        } catch (err) {
            // Falling back to defaults is the safe failure: the player still
            // hears about the thing, and can still turn it off later.
            logger.warn(`Could not read notification preference: ${err.message}`);
        }

        return defaults;
    }

    /**
     * Every category with this user's effective settings, for the account page.
     */
    async getPreferences(userId) {
        let stored = {};

        try {
            const rows = await this.db.query(
                'SELECT "Category", "InApp", "Email" FROM "NotificationPreferences" ' +
                    'WHERE "UserId" = $1',
                [userId]
            );

            for (const row of rows || []) {
                stored[row.Category] = { inApp: !!row.InApp, email: !!row.Email };
            }
        } catch (err) {
            logger.warn(`Could not read notification preferences: ${err.message}`);
        }

        return describeCategories().map((entry) => ({
            ...entry,
            ...(stored[entry.category] || entry.defaults)
        }));
    }

    /**
     * Store an explicit preference. Writing a row even when it matches the
     * default is deliberate here: the player made a choice, and a later change
     * to the default should not quietly undo it.
     */
    async setPreference(userId, category, { inApp, email }) {
        if (!isKnownCategory(category)) {
            return { success: false, message: `Unknown notification category '${category}'` };
        }

        const defaults = categoryDefaults(category);

        await this.db.query(
            'INSERT INTO "NotificationPreferences" ("UserId", "Category", "InApp", "Email", "UpdatedAt") ' +
                "VALUES ($1, $2, $3, $4, now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("UserId", "Category") DO UPDATE SET ' +
                '"InApp" = $3, "Email" = $4, "UpdatedAt" = now() AT TIME ZONE \'utc\'',
            [
                userId,
                category,
                typeof inApp === 'boolean' ? inApp : defaults.inApp,
                typeof email === 'boolean' ? email : defaults.email
            ]
        );

        return { success: true };
    }

    /**
     * Raise one notification.
     *
     * Callers do not await this - see the class comment. It resolves to a small
     * result object purely so tests can assert what happened.
     *
     * @param {object} event
     * @param {number} event.userId      recipient
     * @param {string} event.category    taxonomy key (also the opt-out unit)
     * @param {string} event.title       one-line summary
     * @param {string} [event.body]      supporting detail
     * @param {string} [event.url]       in-site path this notification is about
     * @param {object} [event.data]      structured payload for the renderer
     * @param {string} [event.dedupeKey] idempotency handle; a repeat is a no-op
     */
    async notify(event) {
        try {
            return await this.deliver(event);
        } catch (err) {
            // Swallowed on purpose: a notification failure must never surface
            // in the operation that raised it.
            logger.error(`Failed to deliver ${event && event.category} notification`, err);

            return { delivered: false, error: true };
        }
    }

    /** Raise the same event for several recipients. Never throws. */
    async notifyMany(events) {
        const results = [];

        for (const event of events || []) {
            results.push(await this.notify(event));
        }

        return results;
    }

    async deliver(event) {
        const { userId, category, title, body, url, data, dedupeKey } = event || {};

        if (!userId || !category || !title) {
            return { delivered: false, reason: 'incomplete' };
        }

        const preference = await this.getPreference(userId, category);

        if (!preference.inApp && !preference.email) {
            return { delivered: false, reason: 'opted-out' };
        }

        let inserted = null;

        if (preference.inApp) {
            // ON CONFLICT on the partial unique index makes a repeated trigger
            // (the pairing hook can fire more than once for one round) a no-op
            // rather than a duplicate row.
            const rows = await this.db.query(
                'INSERT INTO "Notifications" ' +
                    '("UserId", "Category", "Title", "Body", "Url", "Data", "DedupeKey", "CreatedAt") ' +
                    "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now() AT TIME ZONE 'utc') " +
                    'ON CONFLICT ("UserId", "DedupeKey") WHERE "DedupeKey" IS NOT NULL ' +
                    'DO NOTHING RETURNING "Id"',
                [
                    userId,
                    category,
                    title,
                    body || null,
                    url || null,
                    data ? JSON.stringify(data) : null,
                    dedupeKey || null
                ]
            );

            inserted = rows && rows[0] ? rows[0].Id : null;

            // No row means this exact notification already exists, so the email
            // has already gone out too. Stopping here is what makes the whole
            // path idempotent.
            if (!inserted && dedupeKey) {
                return { delivered: false, reason: 'duplicate' };
            }
        }

        let emailed = false;

        if (preference.email) {
            emailed = await this.sendEmail({ userId, category, title, body, url });

            if (emailed && inserted) {
                await this.db.query(
                    'UPDATE "Notifications" SET "EmailedAt" = now() AT TIME ZONE \'utc\' ' +
                        'WHERE "Id" = $1',
                    [inserted]
                );
            }
        }

        return { delivered: true, notificationId: inserted, emailed };
    }

    /**
     * Email one notification. Returns whether it was actually sent; a site with
     * no configured sender (or a player with no verified address) simply gets
     * the in-app notification, which is a degradation rather than a failure.
     */
    async sendEmail({ userId, category, title, body, url }) {
        if (!this.emailService || !this.emailService.isConfigured()) {
            return false;
        }

        let recipient;

        try {
            const rows = await this.db.query(
                'SELECT "Email", "Username" FROM "Users" ' +
                    'WHERE "Id" = $1 AND "Disabled" IS NOT TRUE',
                [userId]
            );
            recipient = rows && rows[0];
        } catch (err) {
            logger.warn(`Could not load notification recipient ${userId}: ${err.message}`);

            return false;
        }

        if (!recipient || !recipient.Email) {
            return false;
        }

        const link = url ? `${this.siteUrl}${url}` : undefined;
        const content = {
            appName: this.appName,
            title,
            paragraphs: [body || title].filter(Boolean),
            action: link ? { label: 'Open Archon Arena', url: link } : undefined,
            footer: `You are receiving this because "${category}" notifications are on for your account. Turn them off in Profile > Notifications.`
        };

        return await this.emailService.sendEmail(
            recipient.Email,
            `${this.appName}: ${title}`,
            renderTextEmail(content),
            renderHtmlEmail(content)
        );
    }

    /** Newest-first page of a player's notifications. */
    async list(userId, { limit = 30, unreadOnly = false } = {}) {
        const capped = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
        const rows = await this.db.query(
            'SELECT "Id", "Category", "Title", "Body", "Url", "Data", "ReadAt", "CreatedAt" ' +
                'FROM "Notifications" WHERE "UserId" = $1 ' +
                (unreadOnly ? 'AND "ReadAt" IS NULL ' : '') +
                `ORDER BY "Id" DESC LIMIT ${capped}`,
            [userId]
        );

        return (rows || []).map((row) => ({
            id: row.Id,
            category: row.Category,
            title: row.Title,
            body: row.Body,
            url: row.Url,
            data: row.Data,
            read: !!row.ReadAt,
            createdAt: row.CreatedAt
        }));
    }

    async unreadCount(userId) {
        const rows = await this.db.query(
            'SELECT COUNT(*) AS "count" FROM "Notifications" ' +
                'WHERE "UserId" = $1 AND "ReadAt" IS NULL',
            [userId]
        );

        return rows && rows[0] ? Number(rows[0].count) || 0 : 0;
    }

    /**
     * Mark specific notifications read, or all of them when no ids are given.
     * Always scoped by UserId, so an id belonging to someone else is a no-op
     * rather than a cross-account read.
     */
    async markRead(userId, ids) {
        if (Array.isArray(ids) && ids.length > 0) {
            const numeric = ids.map((id) => parseInt(id, 10)).filter(Number.isFinite);

            if (numeric.length === 0) {
                return { success: true, updated: 0 };
            }

            const rows = await this.db.query(
                'UPDATE "Notifications" SET "ReadAt" = now() AT TIME ZONE \'utc\' ' +
                    'WHERE "UserId" = $1 AND "Id" = ANY($2) AND "ReadAt" IS NULL RETURNING "Id"',
                [userId, numeric]
            );

            return { success: true, updated: rows ? rows.length : 0 };
        }

        const rows = await this.db.query(
            'UPDATE "Notifications" SET "ReadAt" = now() AT TIME ZONE \'utc\' ' +
                'WHERE "UserId" = $1 AND "ReadAt" IS NULL RETURNING "Id"',
            [userId]
        );

        return { success: true, updated: rows ? rows.length : 0 };
    }
}

module.exports = NotificationService;
module.exports.CATEGORY_KEYS = CATEGORY_KEYS;
