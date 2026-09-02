const logger = require('../log');

const STATUSES = ['pending', 'cleared'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * ARCHON (N14): self-serve TestFlight requests. `/mobile/ios` lets a
 * signed-in player ask for an invite; `/admin/ios-beta-requests` is the
 * queue an admin works through in order, since Apple caps external
 * testers. Deliberately minimal, matching BugReportService: an inbox, not
 * a ticketing system.
 */
class IosBetaRequestService {
    constructor(db = require('../db')) {
        this.db = db;
    }

    async create(userId, { appleId }) {
        const email = (appleId || '').trim();

        if (!EMAIL_PATTERN.test(email)) {
            return { success: false, message: 'Enter the email address your Apple ID uses' };
        }

        const existing = await this.db.query(
            'SELECT "Id" FROM "IosBetaRequests" WHERE "UserId" = $1 AND "Status" = \'pending\'',
            [userId]
        );

        if (existing && existing.length > 0) {
            return { success: false, message: 'You already have a pending TestFlight request' };
        }

        await this.db.query(
            'INSERT INTO "IosBetaRequests" ("UserId", "AppleId", "CreatedAt") ' +
                "VALUES ($1, $2, now() AT TIME ZONE 'utc')",
            [userId, email.slice(0, 320)]
        );

        logger.info(`iOS TestFlight request filed by user ${userId}`);

        return { success: true };
    }

    async myRequest(userId) {
        const rows = await this.db.query(
            'SELECT "Id", "AppleId", "Status", "CreatedAt" FROM "IosBetaRequests" ' +
                'WHERE "UserId" = $1 ORDER BY "Id" DESC LIMIT 1',
            [userId]
        );

        const row = rows && rows[0];

        return row
            ? { id: row.Id, appleId: row.AppleId, status: row.Status, createdAt: row.CreatedAt }
            : null;
    }

    async list(status) {
        const params = [];
        let where = '';

        if (status && STATUSES.includes(status)) {
            params.push(status);
            where = 'WHERE r."Status" = $1';
        }

        const rows = await this.db.query(
            'SELECT r."Id", r."AppleId", r."Status", r."CreatedAt", r."ClearedAt", ' +
                'u."Username", cu."Username" AS "ClearedByUsername" ' +
                'FROM "IosBetaRequests" r ' +
                'LEFT JOIN "Users" u ON u."Id" = r."UserId" ' +
                'LEFT JOIN "Users" cu ON cu."Id" = r."ClearedBy" ' +
                `${where} ORDER BY r."Id" ASC LIMIT 500`,
            params
        );

        return (rows || []).map((row) => ({
            id: row.Id,
            appleId: row.AppleId,
            status: row.Status,
            createdAt: row.CreatedAt,
            clearedAt: row.ClearedAt,
            username: row.Username,
            clearedBy: row.ClearedByUsername
        }));
    }

    async setStatus(id, status, actorId) {
        if (!STATUSES.includes(status)) {
            return { success: false, message: 'Unknown status' };
        }

        if (status === 'cleared') {
            await this.db.query(
                'UPDATE "IosBetaRequests" SET "Status" = $2, "ClearedBy" = $3, ' +
                    '"ClearedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
                [id, status, actorId]
            );
        } else {
            await this.db.query(
                'UPDATE "IosBetaRequests" SET "Status" = $2, "ClearedBy" = NULL, ' +
                    '"ClearedAt" = NULL WHERE "Id" = $1',
                [id, status]
            );
        }

        return { success: true };
    }
}

module.exports = IosBetaRequestService;
