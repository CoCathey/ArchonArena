const logger = require('./../log');

const DEFAULT_MODERATION_CONFIG = {
    // A player who has to write something is a player who has thought about
    // it; empty reports are the bulk of a queue's noise.
    minDetailLength: 10,
    defaultMuteHours: 24,
    defaultTimeoutHours: 72,
    // Repeat reports about the same account inside this window raise its
    // priority in the queue.
    repeatWindowDays: 30,
    repeatThreshold: 3
};

/** What a player can report, and what a report about it is really about. */
const TARGET_TYPES = ['player', 'message', 'deck', 'club', 'store', 'inPersonGame'];

const REASONS = [
    'harassment',
    'hate-speech',
    'cheating',
    'collusion',
    'inappropriate-name',
    'spam',
    'other'
];

/** Ordered least to most severe - the "graduated" in graduated actions. */
const ACTIONS = ['note', 'warn', 'mute', 'timeout', 'ban'];

/** Restrictions that actually stop a player doing something. */
const RESTRICTIONS = ['mute', 'timeout', 'ban'];

const SURFACE_BY_RESTRICTION = {
    mute: 'chat',
    timeout: 'play',
    ban: 'site'
};

/**
 * Moderation (N5).
 *
 * The platform inherited an IP ban list and a Disabled flag on the account,
 * and a canModerateChat role with nothing to do: no way to report anything,
 * and nothing between "ignore it" and "delete the account". Community size
 * makes both urgent rather than optional.
 *
 * Three ideas hold this together:
 *
 *   * A report captures its own evidence. Deleting the message is the first
 *     thing a bad actor does, and a report that points at something gone is
 *     not a report.
 *   * A sanction is a row with a reason and an expiry, never a flag. That is
 *     what lets a muted player be told why and until when, and what makes an
 *     action reversible without erasing that it happened.
 *   * Every moderator action is written to an audit log that outlives the
 *     moderator's account.
 */
class ModerationService {
    constructor(db = require('../db'), options = {}) {
        this.db = db;
        this.settingsService = options.settingsService || require('./settings');
        this.notificationService = options.notificationService || null;
    }

    getConfig() {
        const overrides = this.settingsService?.getSection?.('moderation') || {};

        return { ...DEFAULT_MODERATION_CONFIG, ...overrides };
    }

    /** Moderators and admins. */
    canModerate(actor) {
        return !!(actor?.permissions?.canModerateChat || actor?.permissions?.isAdmin);
    }

    // ----- Reporting

    /**
     * Capture what is being reported, so the report survives the evidence
     * being deleted. Returns the snapshot plus the account the report is
     * really about - reporting a deck is a report about its owner, and a
     * moderator should not have to work that out.
     */
    async captureContext(targetType, targetId, targetUsername) {
        // Players are addressed by name, not id: the public profile
        // deliberately does not publish numeric user ids (they are sequential,
        // so they leak registration order and account count), and the report
        // button should not be the one thing that does.
        if (targetType === 'player') {
            const rows = await this.db.query(
                'SELECT "Id", "Username" FROM "Users" WHERE lower("Username") = lower($1)',
                [String(targetUsername || '')]
            );

            return rows && rows[0]
                ? { context: { username: rows[0].Username }, targetUserId: rows[0].Id }
                : { context: null, targetUserId: null };
        }

        const id = parseInt(targetId, 10);

        if (!Number.isInteger(id)) {
            return { context: null, targetUserId: null };
        }

        try {
            if (targetType === 'message') {
                const rows = await this.db.query(
                    'SELECT m."Id", m."Text", m."PostedTime", m."PosterId", u."Username" ' +
                        'FROM "Messages" m LEFT JOIN "Users" u ON u."Id" = m."PosterId" ' +
                        'WHERE m."Id" = $1',
                    [id]
                );

                return rows && rows[0]
                    ? {
                          context: {
                              text: rows[0].Text,
                              postedAt: rows[0].PostedTime,
                              username: rows[0].Username
                          },
                          targetUserId: rows[0].PosterId
                      }
                    : { context: null, targetUserId: null };
            }

            if (targetType === 'deck') {
                const rows = await this.db.query(
                    'SELECT d."Id", d."Name", d."UserId", u."Username" FROM "Decks" d ' +
                        'LEFT JOIN "Users" u ON u."Id" = d."UserId" WHERE d."Id" = $1',
                    [id]
                );

                return rows && rows[0]
                    ? {
                          context: { name: rows[0].Name, username: rows[0].Username },
                          targetUserId: rows[0].UserId
                      }
                    : { context: null, targetUserId: null };
            }

            if (targetType === 'club') {
                const rows = await this.db.query(
                    'SELECT "Id", "Name", "Description", "OwnerId" FROM "Clubs" WHERE "Id" = $1',
                    [id]
                );

                return rows && rows[0]
                    ? {
                          context: { name: rows[0].Name, description: rows[0].Description },
                          targetUserId: rows[0].OwnerId
                      }
                    : { context: null, targetUserId: null };
            }

            if (targetType === 'store') {
                const rows = await this.db.query(
                    'SELECT "Id", "Name", "Description" FROM "Stores" WHERE "Id" = $1',
                    [id]
                );

                return rows && rows[0]
                    ? {
                          context: { name: rows[0].Name, description: rows[0].Description },
                          targetUserId: null
                      }
                    : { context: null, targetUserId: null };
            }

            if (targetType === 'inPersonGame') {
                const rows = await this.db.query(
                    'SELECT g."Id", g."Status", g."Player1Id", g."Player2Id", ' +
                        'u1."Username" AS "Player1Name", u2."Username" AS "Player2Name" ' +
                        'FROM "InPersonGames" g ' +
                        'JOIN "Users" u1 ON u1."Id" = g."Player1Id" ' +
                        'JOIN "Users" u2 ON u2."Id" = g."Player2Id" WHERE g."Id" = $1',
                    [id]
                );

                if (!rows || !rows[0]) {
                    return { context: null, targetUserId: null };
                }

                const reports = await this.db.query(
                    'SELECT "ReporterId", "WinnerId", "Player1Keys", "Player2Keys" ' +
                        'FROM "InPersonGameReports" WHERE "InPersonGameId" = $1 ORDER BY "Id"',
                    [id]
                );

                return {
                    context: {
                        status: rows[0].Status,
                        player1: rows[0].Player1Name,
                        player2: rows[0].Player2Name,
                        // Both accounts of the game, so a moderator can see
                        // exactly where the two players disagree.
                        reports: (reports || []).map((report) => ({
                            reporterId: report.ReporterId,
                            winnerId: report.WinnerId,
                            player1Keys: report.Player1Keys,
                            player2Keys: report.Player2Keys
                        }))
                    },
                    // A disagreement is not an accusation against either
                    // player, so nobody is named as the subject.
                    targetUserId: null
                };
            }
        } catch (err) {
            logger.warn(`Failed to capture report context: ${err.message}`);
        }

        return { context: null, targetUserId: null };
    }

    async report(reporterId, options = {}) {
        const config = this.getConfig();
        const targetType = String(options.targetType || '');

        if (!TARGET_TYPES.includes(targetType)) {
            return { success: false, message: 'That is not something you can report' };
        }

        const reason = String(options.reason || '');

        if (!REASONS.includes(reason)) {
            return { success: false, message: 'Choose a reason for the report' };
        }

        const details = String(options.details || '')
            .trim()
            .slice(0, 4000);

        if (details.length < config.minDetailLength) {
            return {
                success: false,
                message: `Please describe what happened (at least ${config.minDetailLength} characters)`
            };
        }

        const { context, targetUserId } = await this.captureContext(
            targetType,
            options.targetId,
            options.targetUsername
        );

        if (!context) {
            return { success: false, message: 'That no longer exists' };
        }

        if (targetUserId && targetUserId === reporterId) {
            return { success: false, message: 'You cannot report yourself' };
        }

        // One open report per person per thing. A second one adds nothing a
        // moderator can act on and just doubles the queue.
        //
        // Both keys are compared, because a player report carries no TargetId
        // (players are addressed by name) - matching on TargetId alone would
        // make every player report look like a duplicate of the first one,
        // and a player who reported one person could never report another.
        const existing = await this.db.query(
            'SELECT "Id" FROM "Reports" WHERE "ReporterId" = $1 AND "TargetType" = $2 ' +
                'AND "TargetId" IS NOT DISTINCT FROM $3 ' +
                'AND "TargetUserId" IS NOT DISTINCT FROM $4 ' +
                "AND \"Status\" IN ('open', 'claimed')",
            [
                reporterId,
                targetType,
                options.targetId ? parseInt(options.targetId, 10) : null,
                targetUserId
            ]
        );

        if (existing && existing.length > 0) {
            return { success: false, message: 'You have already reported this' };
        }

        const rows = await this.db.query(
            'INSERT INTO "Reports" ("ReporterId", "TargetType", "TargetId", "TargetUserId", ' +
                '"Reason", "Details", "Context", "Status", "CreatedAt") ' +
                "VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', now() AT TIME ZONE 'utc') " +
                'RETURNING "Id"',
            [
                reporterId,
                targetType,
                options.targetId ? parseInt(options.targetId, 10) : null,
                targetUserId,
                reason,
                details,
                context ? JSON.stringify(context) : null
            ]
        );

        logger.info(`Report ${rows[0].Id} filed by user ${reporterId} (${targetType}/${reason})`);

        return { success: true, id: rows[0].Id };
    }

    // ----- The queue

    /**
     * How many other reports have been filed about this account recently.
     * Surfaced on the queue because one complaint is a disagreement and five
     * from different people in a week is a pattern - and a moderator seeing
     * the report alone cannot tell which they are looking at.
     */
    async repeatCountFor(targetUserId, windowDays) {
        if (!targetUserId) {
            return 0;
        }

        const rows = await this.db.query(
            'SELECT COUNT(DISTINCT "ReporterId") AS "Count" FROM "Reports" ' +
                'WHERE "TargetUserId" = $1 ' +
                `AND "CreatedAt" >= (now() AT TIME ZONE 'utc') - interval '${windowDays} days'`,
            [targetUserId]
        );

        return parseInt(rows[0].Count, 10) || 0;
    }

    async getQueue(actor, options = {}) {
        if (!this.canModerate(actor)) {
            return { success: false, message: 'Forbidden' };
        }

        const config = this.getConfig();
        const status = ['open', 'claimed', 'resolved', 'dismissed'].includes(options.status)
            ? options.status
            : 'open';
        const limit = Math.min(Math.max(1, parseInt(options.limit, 10) || 50), 200);

        const rows = await this.db.query(
            'SELECT r.*, reporter."Username" AS "ReporterName", ' +
                'target."Username" AS "TargetName", claimer."Username" AS "ClaimedByName" ' +
                'FROM "Reports" r ' +
                'LEFT JOIN "Users" reporter ON reporter."Id" = r."ReporterId" ' +
                'LEFT JOIN "Users" target ON target."Id" = r."TargetUserId" ' +
                'LEFT JOIN "Users" claimer ON claimer."Id" = r."ClaimedById" ' +
                'WHERE r."Status" = $1 ORDER BY r."Id" ASC LIMIT $2',
            [status, limit]
        );

        const reports = [];

        for (const row of rows || []) {
            reports.push({
                id: row.Id,
                targetType: row.TargetType,
                targetId: row.TargetId,
                targetUserId: row.TargetUserId,
                targetName: row.TargetName,
                reporter: row.ReporterName,
                reason: row.Reason,
                details: row.Details,
                context: typeof row.Context === 'string' ? JSON.parse(row.Context) : row.Context,
                status: row.Status,
                claimedBy: row.ClaimedByName,
                claimedAt: row.ClaimedAt,
                resolution: row.Resolution,
                resolvedAt: row.ResolvedAt,
                createdAt: row.CreatedAt,
                repeatReports: await this.repeatCountFor(row.TargetUserId, config.repeatWindowDays),
                repeatThreshold: config.repeatThreshold
            });
        }

        return { success: true, reports };
    }

    /**
     * Claim a report so two moderators do not act on the same thing twice.
     * The update is conditional on it still being open, so a race resolves to
     * one winner rather than both believing they have it.
     */
    async claim(reportId, actor) {
        if (!this.canModerate(actor)) {
            return { success: false, message: 'Forbidden' };
        }

        const rows = await this.db.query(
            'UPDATE "Reports" SET "Status" = \'claimed\', "ClaimedById" = $2, ' +
                '"ClaimedAt" = now() AT TIME ZONE \'utc\' ' +
                'WHERE "Id" = $1 AND "Status" = \'open\' RETURNING "Id"',
            [reportId, actor.id]
        );

        if (!rows || rows.length === 0) {
            return { success: false, message: 'That report has already been claimed' };
        }

        await this.audit(actor, 'report.claim', { targetType: 'report', targetId: reportId });

        return { success: true };
    }

    /** Hand a claimed report back to the queue. */
    async release(reportId, actor) {
        if (!this.canModerate(actor)) {
            return { success: false, message: 'Forbidden' };
        }

        const rows = await this.db.query(
            'UPDATE "Reports" SET "Status" = \'open\', "ClaimedById" = NULL, "ClaimedAt" = NULL ' +
                'WHERE "Id" = $1 AND "Status" = \'claimed\' RETURNING "Id"',
            [reportId]
        );

        if (!rows || rows.length === 0) {
            return { success: false, message: 'That report is not claimed' };
        }

        await this.audit(actor, 'report.release', { targetType: 'report', targetId: reportId });

        return { success: true };
    }

    async resolve(reportId, actor, options = {}) {
        if (!this.canModerate(actor)) {
            return { success: false, message: 'Forbidden' };
        }

        const dismissed = options.dismiss === true;
        const resolution = String(options.resolution || '')
            .trim()
            .slice(0, 2000);

        if (!resolution) {
            // A resolution with no reasoning is indistinguishable from the
            // report having been ignored, both to the next moderator reading
            // the log and to anyone auditing it later.
            return { success: false, message: 'Say how the report was resolved' };
        }

        const rows = await this.db.query(
            'UPDATE "Reports" SET "Status" = $3, "ResolvedById" = $2, ' +
                '"ResolvedAt" = now() AT TIME ZONE \'utc\', "Resolution" = $4 ' +
                'WHERE "Id" = $1 AND "Status" IN (\'open\', \'claimed\') RETURNING "TargetUserId", "ReporterId"',
            [reportId, actor.id, dismissed ? 'dismissed' : 'resolved', resolution]
        );

        if (!rows || rows.length === 0) {
            return { success: false, message: 'That report is already closed' };
        }

        await this.audit(actor, dismissed ? 'report.dismiss' : 'report.resolve', {
            targetType: 'report',
            targetId: reportId,
            detail: { resolution }
        });

        // The reporter hears that something happened, but never what was done
        // to the other account - that is between the platform and that player.
        if (this.notificationService && rows[0].ReporterId) {
            this.notificationService.notify({
                userId: rows[0].ReporterId,
                category: 'moderation.update',
                title: 'Your report has been reviewed',
                url: '/',
                data: { reportId }
            });
        }

        return { success: true };
    }

    // ----- Graduated actions

    /**
     * Apply a sanction. Every one carries a reason, and every restriction
     * carries an expiry unless a moderator deliberately makes it indefinite.
     */
    async act(actor, options = {}) {
        if (!this.canModerate(actor)) {
            return { success: false, message: 'Forbidden' };
        }

        const config = this.getConfig();
        const action = String(options.action || '');

        if (!ACTIONS.includes(action)) {
            return { success: false, message: 'Unknown moderation action' };
        }

        const targetUserId = parseInt(options.targetUserId, 10);

        if (!Number.isInteger(targetUserId)) {
            return { success: false, message: 'No such player' };
        }

        const targetRows = await this.db.query(
            'SELECT "Id", "Username", "Disabled" FROM "Users" WHERE "Id" = $1',
            [targetUserId]
        );

        if (!targetRows || targetRows.length === 0) {
            return { success: false, message: 'No such player' };
        }

        const target = targetRows[0];

        if (targetUserId === actor.id) {
            return { success: false, message: 'You cannot moderate yourself' };
        }

        // A moderator who can be sanctioned by a peer is a moderation war
        // waiting to happen; only an admin can act on one.
        const targetIsModerator = await this.isModerator(targetUserId);

        if (targetIsModerator && !actor.permissions?.isAdmin) {
            return { success: false, message: 'Only an admin can moderate a moderator' };
        }

        const reason = String(options.reason || '')
            .trim()
            .slice(0, 2000);

        if (!reason) {
            return { success: false, message: 'Every moderation action needs a reason' };
        }

        let expiresAt = null;

        if (RESTRICTIONS.includes(action) && options.indefinite !== true) {
            const fallback =
                action === 'mute' ? config.defaultMuteHours : config.defaultTimeoutHours;
            const hours = options.hours === undefined ? fallback : parseFloat(options.hours);

            if (Number.isNaN(hours) || hours <= 0 || hours > 24 * 365 * 5) {
                return { success: false, message: 'Duration must be between 0 and five years' };
            }

            // A ban with no explicit duration is indefinite by nature; mutes
            // and timeouts default to the configured window.
            if (action !== 'ban' || options.hours !== undefined) {
                expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
            }
        }

        const rows = await this.db.query(
            'INSERT INTO "ModerationActions" ("TargetUserId", "ActorId", "Action", "Reason", ' +
                '"ExpiresAt", "ReportId", "CreatedAt") ' +
                'VALUES ($1, $2, $3, $4, $5, $6, now() AT TIME ZONE \'utc\') RETURNING "Id"',
            [
                targetUserId,
                actor.id,
                action,
                reason,
                expiresAt,
                options.reportId ? parseInt(options.reportId, 10) : null
            ]
        );

        // A ban is the one action that also changes account state, because
        // the login path checks Disabled and knows nothing about this table.
        if (action === 'ban') {
            await this.db.query('UPDATE "Users" SET "Disabled" = true WHERE "Id" = $1', [
                targetUserId
            ]);
        }

        await this.audit(actor, `moderation.${action}`, {
            targetType: 'user',
            targetId: targetUserId,
            targetName: target.Username,
            detail: { reason, expiresAt, reportId: options.reportId || null }
        });

        // Told what happened, why, and for how long. A restriction a player
        // cannot see the shape of is a worse punishment than the one chosen.
        if (this.notificationService && action !== 'note') {
            this.notificationService.notify({
                userId: targetUserId,
                category: 'moderation.action',
                title: this.describeAction(action, expiresAt),
                url: '/',
                data: { action, reason, expiresAt }
            });
        }

        logger.info(
            `Moderation: ${action} on user ${targetUserId} by ${actor.id}` +
                `${expiresAt ? ` until ${expiresAt.toISOString()}` : ''}`
        );

        return { success: true, id: rows[0].Id, expiresAt };
    }

    describeAction(action, expiresAt) {
        const until = expiresAt
            ? ` until ${new Date(expiresAt).toISOString().replace('T', ' ').slice(0, 16)} UTC`
            : '';

        switch (action) {
            case 'warn':
                return 'You have received a warning from the moderators';
            case 'mute':
                return `You have been muted${until}`;
            case 'timeout':
                return `You have been timed out from play${until}`;
            case 'ban':
                return `Your account has been suspended${until}`;
            default:
                return 'A moderator has updated your account';
        }
    }

    async isModerator(userId) {
        const rows = await this.db.query(
            'SELECT 1 FROM "UserRoles" ur JOIN "Roles" r ON r."Id" = ur."RoleId" ' +
                'WHERE ur."UserId" = $1 AND r."Name" IN (\'ChatManager\', \'Admin\') LIMIT 1',
            [userId]
        );

        return !!(rows && rows.length > 0);
    }

    /**
     * Undo a sanction without erasing that it was applied. Revoking is a
     * timestamp, not a delete: a player's history should show that a mute
     * happened and was lifted, not that it never existed.
     */
    async revoke(actionId, actor, reason) {
        if (!this.canModerate(actor)) {
            return { success: false, message: 'Forbidden' };
        }

        const rows = await this.db.query(
            'UPDATE "ModerationActions" SET "RevokedById" = $2, ' +
                '"RevokedAt" = now() AT TIME ZONE \'utc\', "RevokeReason" = $3 ' +
                'WHERE "Id" = $1 AND "RevokedAt" IS NULL RETURNING "TargetUserId", "Action"',
            [actionId, actor.id, String(reason || '').slice(0, 2000) || null]
        );

        if (!rows || rows.length === 0) {
            return { success: false, message: 'That action is already revoked' };
        }

        // Lifting a ban has to put the account back, or the row says "revoked"
        // while the player still cannot log in.
        //
        // ARCHON: except where the account has since been DELETED by its owner.
        // "Disabled" carries both meanings, so without the DeletedAt guard
        // revoking a stale ban would un-disable a wiped, password-less row and
        // return it to the member directory - resurrecting an account whose
        // owner asked for it to be gone.
        if (rows[0].Action === 'ban') {
            await this.db.query(
                'UPDATE "Users" SET "Disabled" = false WHERE "Id" = $1 AND "DeletedAt" IS NULL',
                [rows[0].TargetUserId]
            );
        }

        await this.audit(actor, 'moderation.revoke', {
            targetType: 'user',
            targetId: rows[0].TargetUserId,
            detail: { actionId, reason }
        });

        if (this.notificationService) {
            this.notificationService.notify({
                userId: rows[0].TargetUserId,
                category: 'moderation.action',
                title: 'A moderation action on your account has been lifted',
                url: '/',
                data: { actionId }
            });
        }

        return { success: true };
    }

    // ----- Enforcement

    /**
     * The live restrictions on an account. Called on the chat path, so it is
     * one indexed query and nothing more.
     */
    async getActiveRestrictions(userId) {
        if (!userId) {
            return [];
        }

        const rows = await this.db.query(
            'SELECT "Id", "Action", "Reason", "ExpiresAt" FROM "ModerationActions" ' +
                'WHERE "TargetUserId" = $1 AND "RevokedAt" IS NULL ' +
                'AND "Action" = ANY($2) ' +
                'AND ("ExpiresAt" IS NULL OR "ExpiresAt" > (now() AT TIME ZONE \'utc\')) ' +
                'ORDER BY "Id" DESC',
            [userId, RESTRICTIONS]
        );

        return (rows || []).map((row) => ({
            id: row.Id,
            action: row.Action,
            surface: SURFACE_BY_RESTRICTION[row.Action],
            reason: row.Reason,
            expiresAt: row.ExpiresAt
        }));
    }

    /**
     * Whether a player may act on a surface, and if not, why and until when.
     * A ban blocks everything; a timeout blocks play; a mute blocks chat.
     */
    async checkRestriction(userId, surface) {
        const active = await this.getActiveRestrictions(userId);

        const blocking = active.find(
            (restriction) =>
                restriction.action === 'ban' ||
                restriction.surface === surface ||
                // A timeout from play implies no lobby chat either; being
                // unable to play while still able to talk is not the sanction
                // a moderator picked.
                (restriction.action === 'timeout' && surface === 'chat')
        );

        if (!blocking) {
            return { allowed: true };
        }

        return {
            allowed: false,
            action: blocking.action,
            reason: blocking.reason,
            expiresAt: blocking.expiresAt,
            message: this.describeAction(blocking.action, blocking.expiresAt)
        };
    }

    // ----- Audit

    /**
     * Append to the audit log. Never throws: an action that succeeded must
     * not be reported as failed because the logging of it did, and a
     * moderator who saw an error would very reasonably do it again.
     */
    async audit(actor, action, options = {}) {
        try {
            await this.db.query(
                'INSERT INTO "ModerationAuditLog" ("ActorId", "ActorName", "Action", ' +
                    '"TargetType", "TargetId", "TargetName", "Detail", "CreatedAt") ' +
                    "VALUES ($1, $2, $3, $4, $5, $6, $7, now() AT TIME ZONE 'utc')",
                [
                    actor?.id || null,
                    actor?.username || null,
                    action,
                    options.targetType || null,
                    options.targetId || null,
                    options.targetName || null,
                    options.detail ? JSON.stringify(options.detail) : null
                ]
            );
        } catch (err) {
            logger.error(`Failed to write moderation audit entry '${action}'`, err);
        }
    }

    async getAuditLog(actor, options = {}) {
        if (!this.canModerate(actor)) {
            return { success: false, message: 'Forbidden' };
        }

        const limit = Math.min(Math.max(1, parseInt(options.limit, 10) || 100), 500);
        const params = [limit];
        let where = '';

        if (options.targetUserId) {
            params.unshift(parseInt(options.targetUserId, 10));
            where = 'WHERE "TargetType" = \'user\' AND "TargetId" = $1';
        }

        const rows = await this.db.query(
            'SELECT * FROM "ModerationAuditLog" ' +
                `${where} ORDER BY "Id" DESC LIMIT $${params.length}`,
            params
        );

        return {
            success: true,
            entries: (rows || []).map((row) => ({
                id: row.Id,
                actor: row.ActorName,
                actorId: row.ActorId,
                action: row.Action,
                targetType: row.TargetType,
                targetId: row.TargetId,
                targetName: row.TargetName,
                detail: typeof row.Detail === 'string' ? JSON.parse(row.Detail) : row.Detail,
                createdAt: row.CreatedAt
            }))
        };
    }

    /** Everything known about one account, for the moderator deciding. */
    async getPlayerHistory(username, actor) {
        if (!this.canModerate(actor)) {
            return { success: false, message: 'Forbidden' };
        }

        const userRows = await this.db.query(
            'SELECT "Id", "Username", "Disabled", "Registered" FROM "Users" ' +
                'WHERE lower("Username") = lower($1)',
            [username]
        );

        if (!userRows || userRows.length === 0) {
            return { success: false, message: 'No such player' };
        }

        const user = userRows[0];

        const actions = await this.db.query(
            'SELECT a.*, actor."Username" AS "ActorName", revoker."Username" AS "RevokedByName" ' +
                'FROM "ModerationActions" a ' +
                'LEFT JOIN "Users" actor ON actor."Id" = a."ActorId" ' +
                'LEFT JOIN "Users" revoker ON revoker."Id" = a."RevokedById" ' +
                'WHERE a."TargetUserId" = $1 ORDER BY a."Id" DESC LIMIT 100',
            [user.Id]
        );

        const reports = await this.db.query(
            'SELECT "Id", "TargetType", "Reason", "Status", "CreatedAt" FROM "Reports" ' +
                'WHERE "TargetUserId" = $1 ORDER BY "Id" DESC LIMIT 50',
            [user.Id]
        );

        return {
            success: true,
            player: {
                id: user.Id,
                username: user.Username,
                disabled: user.Disabled,
                registered: user.Registered
            },
            restrictions: await this.getActiveRestrictions(user.Id),
            actions: (actions || []).map((row) => ({
                id: row.Id,
                action: row.Action,
                reason: row.Reason,
                actor: row.ActorName,
                expiresAt: row.ExpiresAt,
                revokedAt: row.RevokedAt,
                revokedBy: row.RevokedByName,
                revokeReason: row.RevokeReason,
                createdAt: row.CreatedAt
            })),
            reports: (reports || []).map((row) => ({
                id: row.Id,
                targetType: row.TargetType,
                reason: row.Reason,
                status: row.Status,
                createdAt: row.CreatedAt
            }))
        };
    }

    /** Queue health for the operations dashboard (N8). */
    async getStats(days = 30) {
        const window = Math.min(Math.max(1, parseInt(days, 10) || 30), 365);

        const rows = await this.db.query(
            'SELECT COUNT(*) FILTER (WHERE "Status" = \'open\') AS "Open", ' +
                'COUNT(*) FILTER (WHERE "Status" = \'claimed\') AS "Claimed", ' +
                "COUNT(*) FILTER (WHERE \"Status\" IN ('resolved', 'dismissed') " +
                `AND "ResolvedAt" >= (now() AT TIME ZONE 'utc') - interval '${window} days') AS "Closed", ` +
                'AVG(EXTRACT(EPOCH FROM ("ResolvedAt" - "CreatedAt")) / 3600) ' +
                'FILTER (WHERE "ResolvedAt" IS NOT NULL ' +
                `AND "ResolvedAt" >= (now() AT TIME ZONE 'utc') - interval '${window} days') AS "AvgHours", ` +
                'MIN("CreatedAt") FILTER (WHERE "Status" = \'open\') AS "OldestOpen" ' +
                'FROM "Reports"',
            []
        );

        const actionRows = await this.db.query(
            'SELECT "Action", COUNT(*) AS "Count" FROM "ModerationActions" ' +
                `WHERE "CreatedAt" >= (now() AT TIME ZONE 'utc') - interval '${window} days' ` +
                'GROUP BY "Action"',
            []
        );

        const row = (rows && rows[0]) || {};
        const actions = {};

        for (const entry of actionRows || []) {
            actions[entry.Action] = parseInt(entry.Count, 10) || 0;
        }

        return {
            windowDays: window,
            open: parseInt(row.Open, 10) || 0,
            claimed: parseInt(row.Claimed, 10) || 0,
            closed: parseInt(row.Closed, 10) || 0,
            // Null rather than 0 when nothing has been resolved: "0 hours to
            // resolve" would read as excellent when it means "never".
            averageResolutionHours:
                row.AvgHours === null || row.AvgHours === undefined
                    ? null
                    : Math.round(Number(row.AvgHours)),
            oldestOpenAt: row.OldestOpen || null,
            actions
        };
    }
}

module.exports = ModerationService;
module.exports.DEFAULT_MODERATION_CONFIG = DEFAULT_MODERATION_CONFIG;
module.exports.TARGET_TYPES = TARGET_TYPES;
module.exports.REASONS = REASONS;
module.exports.ACTIONS = ACTIONS;
module.exports.RESTRICTIONS = RESTRICTIONS;
