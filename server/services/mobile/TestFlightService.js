const logger = require('../../log');

const STATUSES = ['pending', 'resolved'];

// Same shape as the registration email check (server/api/account.js) - good
// enough to catch a typo, not trying to be RFC 5322.
const EMAIL_PATTERN =
    /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;

/**
 * ARCHON (N14): iOS TestFlight invite requests.
 *
 * Apple caps how many external testers a TestFlight can hold and enrollment
 * stays entirely manual in App Store Connect - nothing here talks to Apple.
 * This is only the queue: a signed-in player asks once, an admin works
 * through the list in order and marks each request resolved once they have
 * actually sent (or declined) the invite outside this system. Deliberately
 * minimal, like BugReportService - an inbox, not a ticketing system.
 */
class TestFlightService {
    constructor(db = require('../../db')) {
        this.db = db;
    }

    async request(userId, appleIdEmail) {
        const email = (appleIdEmail || '').trim();

        if (!email) {
            return { success: false, message: 'Please enter the Apple ID email for TestFlight' };
        }

        if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
            return { success: false, message: 'Please enter a valid email address' };
        }

        const inserted = await this.db.query(
            'INSERT INTO "TestFlightRequests" ("UserId", "AppleIdEmail", "CreatedAt") ' +
                'VALUES ($1, $2, now() AT TIME ZONE \'utc\') ' +
                'ON CONFLICT ("UserId") WHERE "Status" = \'pending\' DO NOTHING ' +
                'RETURNING "Id"',
            [userId, email]
        );

        if (!inserted || inserted.length === 0) {
            // Already have an open request for this account - report success
            // rather than a second row an admin would have to notice is a
            // duplicate. The email on the existing request is not updated: a
            // second call with a different address more likely means "which
            // one did I use" than "please redirect the invite".
            return { success: true, alreadyPending: true };
        }

        logger.info(`TestFlight invite requested by user ${userId}`);

        return { success: true, alreadyPending: false };
    }

    /** The caller's own most recent request, or null if they have never asked. */
    async getForUser(userId) {
        const rows = await this.db.query(
            'SELECT "Id", "AppleIdEmail", "Status", "CreatedAt", "ResolvedAt" ' +
                'FROM "TestFlightRequests" WHERE "UserId" = $1 ' +
                'ORDER BY "Id" DESC LIMIT 1',
            [userId]
        );

        if (!rows || rows.length === 0) {
            return null;
        }

        const row = rows[0];

        return {
            id: row.Id,
            appleIdEmail: row.AppleIdEmail,
            status: row.Status,
            createdAt: row.CreatedAt,
            resolvedAt: row.ResolvedAt
        };
    }

    async list(status) {
        const params = [];
        let where = '';

        if (status && STATUSES.includes(status)) {
            params.push(status);
            where = 'WHERE r."Status" = $1';
        }

        const rows = await this.db.query(
            'SELECT r."Id", r."AppleIdEmail", r."Status", r."CreatedAt", r."ResolvedAt", ' +
                'u."Username", ru."Username" AS "ResolvedByUsername" ' +
                'FROM "TestFlightRequests" r ' +
                'LEFT JOIN "Users" u ON u."Id" = r."UserId" ' +
                'LEFT JOIN "Users" ru ON ru."Id" = r."ResolvedBy" ' +
                // Oldest pending first: Apple's cap makes this a queue an
                // admin works through in order, not a feed read newest-first.
                `${where} ORDER BY r."Id" ASC LIMIT 500`,
            params
        );

        return (rows || []).map((row) => ({
            id: row.Id,
            appleIdEmail: row.AppleIdEmail,
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
                'UPDATE "TestFlightRequests" SET "Status" = $2, "ResolvedBy" = $3, ' +
                    '"ResolvedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
                [id, status, actorId]
            );
        } else {
            await this.db.query(
                'UPDATE "TestFlightRequests" SET "Status" = $2, "ResolvedBy" = NULL, ' +
                    '"ResolvedAt" = NULL WHERE "Id" = $1',
                [id, status]
            );
        }

        return { success: true };
    }
}

module.exports = TestFlightService;
