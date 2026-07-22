const logger = require('../log');

const STATUSES = ['open', 'resolved'];

/**
 * ARCHON: beta bug reports. Players file them from the sidebar
 * ("This is a beta - report a bug"); admins read and resolve them at
 * /admin/bug-reports. Deliberately minimal - it is an inbox, not a
 * ticketing system.
 */
class BugReportService {
    constructor(db = require('../db')) {
        this.db = db;
    }

    async create(userId, { page, body, userAgent }) {
        const text = (body || '').trim();

        if (text.length < 10) {
            return {
                success: false,
                message: 'Please describe the bug in at least a sentence (10+ characters)'
            };
        }

        if (text.length > 5000) {
            return { success: false, message: 'Reports are limited to 5000 characters' };
        }

        await this.db.query(
            'INSERT INTO "BugReports" ("UserId", "Page", "Body", "UserAgent", "CreatedAt") ' +
                "VALUES ($1, $2, $3, $4, now() AT TIME ZONE 'utc')",
            [
                userId,
                (page || '').slice(0, 300) || null,
                text,
                (userAgent || '').slice(0, 400) || null
            ]
        );

        logger.info(`Bug report filed by user ${userId}`);

        return { success: true };
    }

    async list(status) {
        const params = [];
        let where = '';

        if (status && STATUSES.includes(status)) {
            params.push(status);
            where = 'WHERE r."Status" = $1';
        }

        const rows = await this.db.query(
            'SELECT r."Id", r."Page", r."Body", r."UserAgent", r."Status", r."CreatedAt", ' +
                'r."ResolvedAt", u."Username", ru."Username" AS "ResolvedByUsername" ' +
                'FROM "BugReports" r ' +
                'LEFT JOIN "Users" u ON u."Id" = r."UserId" ' +
                'LEFT JOIN "Users" ru ON ru."Id" = r."ResolvedBy" ' +
                `${where} ORDER BY r."Id" DESC LIMIT 500`,
            params
        );

        return (rows || []).map((row) => ({
            id: row.Id,
            page: row.Page,
            body: row.Body,
            userAgent: row.UserAgent,
            status: row.Status,
            createdAt: row.CreatedAt,
            resolvedAt: row.ResolvedAt,
            username: row.Username,
            resolvedBy: row.ResolvedByUsername
        }));
    }

    async setStatus(id, status, actorId) {
        if (!STATUSES.includes(status)) {
            return { success: false, message: 'Unknown status' };
        }

        if (status === 'resolved') {
            await this.db.query(
                'UPDATE "BugReports" SET "Status" = $2, "ResolvedBy" = $3, ' +
                    '"ResolvedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
                [id, status, actorId]
            );
        } else {
            await this.db.query(
                'UPDATE "BugReports" SET "Status" = $2, "ResolvedBy" = NULL, ' +
                    '"ResolvedAt" = NULL WHERE "Id" = $1',
                [id, status]
            );
        }

        return { success: true };
    }
}

module.exports = BugReportService;
