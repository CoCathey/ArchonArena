const logger = require('../../log');
const { filterText } = require('../moderation/contentFilter');
const directMessageEvents = require('./directMessageEvents');

/** Longer than a scheduling exchange needs; short enough to stay a message. */
const MAX_LENGTH = 2000;

/** A page of a thread. The client asks for more with `before`. */
const PAGE_SIZE = 50;

/**
 * ARCHON: direct messages between two players.
 *
 * A tournament pairs two people who have to agree on when to play, and the
 * platform gave them a scheduler and no way to talk - "can we do 8 instead of
 * 7?" went to Discord, or to nowhere. This is the conversation around the
 * scheduler: one thread per pair of players, addressed by username, with the
 * block list honoured in both directions and the same content filter and mute
 * enforcement as lobby chat.
 *
 * Delivery is not decided here. The service writes the row and emits 'sent' on
 * directMessageEvents; the lobby pushes it live to whoever is connected and
 * raises a notification for whoever is not. That keeps this testable without a
 * socket in sight.
 *
 * `db` and `moderationService` are injectable, matching the other services.
 */
class DirectMessageService {
    constructor(db = require('../../db'), options = {}) {
        this.db = db;
        // Optional, like the lobby's: without it nothing is enforced rather
        // than nothing working.
        this.moderationService = options.moderationService || null;
    }

    async findUser(username) {
        if (!username) {
            return null;
        }

        const rows = await this.db.query(
            'SELECT "Id", "Username", "Settings_Avatar", "Disabled" FROM "Users" ' +
                'WHERE lower("Username") = lower($1)',
            [String(username)]
        );

        return rows && rows[0] ? rows[0] : null;
    }

    /**
     * Whether either player has the other on their block list.
     *
     * Both directions, and one answer for both: telling a blocked player they
     * are blocked is information the blocker did not choose to share.
     */
    async isBlockedEitherWay(userA, userB) {
        const rows = await this.db.query(
            'SELECT 1 FROM "BlockList" WHERE ' +
                '("UserId" = $1 AND lower("Entry") = lower($2)) OR ' +
                '("UserId" = $3 AND lower("Entry") = lower($4)) LIMIT 1',
            [userA.Id, userB.Username, userB.Id, userA.Username]
        );

        return !!(rows && rows.length > 0);
    }

    /**
     * Send one message.
     *
     * @param {{id: number, username: string}} actor
     * @param {string} targetUsername
     * @param {string} text
     * @param {{matchId?: number}} [context] the tournament match this is about
     */
    async send(actor, targetUsername, text, context = {}) {
        const body = String(text || '').trim();

        if (!body) {
            return { success: false, message: 'Write something first' };
        }

        if (body.length > MAX_LENGTH) {
            return {
                success: false,
                message: `Messages can be at most ${MAX_LENGTH} characters`
            };
        }

        const target = await this.findUser(targetUsername);

        if (!target || target.Disabled) {
            return { success: false, message: 'No such player' };
        }

        if (target.Id === actor.id) {
            return { success: false, message: 'You cannot message yourself' };
        }

        const sender = { Id: actor.id, Username: actor.username };

        if (await this.isBlockedEitherWay(sender, target)) {
            return { success: false, message: 'You cannot message this player' };
        }

        // ARCHON (N5): a mute is a mute here too. A sanction that stopped lobby
        // chat and left private messages open would be a sanction with a hole
        // in it, and the player is told why exactly as they are in the lobby.
        if (this.moderationService) {
            const check = await this.moderationService.checkRestriction(actor.id, 'chat');

            if (!check.allowed) {
                return { success: false, message: check.message, reason: check.reason };
            }
        }

        const matchId =
            Number.isInteger(Number(context.matchId)) && Number(context.matchId) > 0
                ? Number(context.matchId)
                : null;

        let rows;

        try {
            rows = await this.db.query(
                'INSERT INTO "DirectMessages" ("SenderId", "RecipientId", "Text", "MatchId", "SentAt") ' +
                    'VALUES ($1, $2, $3, $4, now() AT TIME ZONE \'utc\') RETURNING "Id", "SentAt"',
                // Filtered at the point of sending, like every other surface.
                [actor.id, target.Id, filterText(body), matchId]
            );
        } catch (err) {
            logger.error(`Failed to send a direct message from ${actor.id} to ${target.Id}`, err);

            return { success: false, message: 'Could not send your message' };
        }

        const message = {
            id: rows[0].Id,
            senderId: actor.id,
            senderUsername: actor.username,
            recipientId: target.Id,
            recipientUsername: target.Username,
            text: filterText(body),
            matchId,
            sentAt: rows[0].SentAt,
            readAt: null
        };

        try {
            directMessageEvents.emit('sent', { message });
        } catch (err) {
            // A listener that throws must not undo a message that is written.
            logger.error(`Failed to announce direct message ${message.id}`, err);
        }

        return { success: true, message };
    }

    /**
     * Every conversation this player is part of, most recent first, with the
     * last message of each and how many of the other player's messages are
     * still unread.
     */
    async conversations(userId) {
        const latest = await this.db.query(
            'SELECT m."Id", m."SenderId", m."RecipientId", m."Text", m."SentAt", m."ReadAt", ' +
                'CASE WHEN m."SenderId" = $1 THEN m."RecipientId" ELSE m."SenderId" END AS "OtherId" ' +
                'FROM "DirectMessages" m WHERE m."Id" IN (' +
                'SELECT MAX("Id") FROM "DirectMessages" ' +
                'WHERE "SenderId" = $1 OR "RecipientId" = $1 ' +
                'GROUP BY LEAST("SenderId", "RecipientId"), GREATEST("SenderId", "RecipientId")) ' +
                'ORDER BY m."Id" DESC',
            [userId]
        );

        if (!latest || latest.length === 0) {
            return [];
        }

        const otherIds = latest.map((row) => row.OtherId);

        const [unreadRows, userRows] = await Promise.all([
            this.db.query(
                'SELECT "SenderId", COUNT(*) AS "Unread" FROM "DirectMessages" ' +
                    'WHERE "RecipientId" = $1 AND "ReadAt" IS NULL GROUP BY "SenderId"',
                [userId]
            ),
            this.db.query(
                'SELECT "Id", "Username", "Settings_Avatar", "Disabled" FROM "Users" ' +
                    'WHERE "Id" = ANY($1)',
                [otherIds]
            )
        ]);

        const unreadBySender = {};
        for (const row of unreadRows || []) {
            unreadBySender[row.SenderId] = Number(row.Unread) || 0;
        }

        const userById = {};
        for (const row of userRows || []) {
            userById[row.Id] = row;
        }

        return latest.map((row) => {
            const other = userById[row.OtherId];

            return {
                userId: row.OtherId,
                username: other && !other.Disabled ? other.Username : 'Deleted user',
                avatar: other && !other.Disabled ? other.Settings_Avatar : null,
                lastMessage: {
                    id: row.Id,
                    text: row.Text,
                    sentAt: row.SentAt,
                    fromMe: row.SenderId === userId
                },
                unread: unreadBySender[row.OtherId] || 0
            };
        });
    }

    /**
     * The thread between this player and another, oldest first.
     *
     * @param {number} userId
     * @param {string} otherUsername
     * @param {{before?: number, limit?: number}} [page] messages with an id
     *        below `before`, for scrolling back
     */
    async thread(userId, otherUsername, page = {}) {
        const other = await this.findUser(otherUsername);

        if (!other) {
            return { success: false, message: 'No such player' };
        }

        const limit = Math.min(Math.max(parseInt(page.limit, 10) || PAGE_SIZE, 1), 200);
        const before = parseInt(page.before, 10);
        const params = [userId, other.Id];
        // ARCHON: cast explicitly - LEAST/GREATEST are polymorphic, so with no
        // column on the same side to infer a type from, Postgres defaults an
        // untyped parameter to text and then "integer = text" has no operator.
        let where =
            'WHERE LEAST("SenderId", "RecipientId") = LEAST($1::integer, $2::integer) ' +
            'AND GREATEST("SenderId", "RecipientId") = GREATEST($1::integer, $2::integer)';

        if (Number.isFinite(before) && before > 0) {
            params.push(before);
            where += ` AND "Id" < $${params.length}`;
        }

        // One more than a page, so the client knows whether to offer "earlier".
        const rows = await this.db.query(
            'SELECT "Id", "SenderId", "RecipientId", "Text", "MatchId", "SentAt", "ReadAt" ' +
                `FROM "DirectMessages" ${where} ORDER BY "Id" DESC LIMIT ${limit + 1}`,
            params
        );

        const page1 = (rows || []).slice(0, limit).reverse();
        const me = { Id: userId };
        const blocked = other.Disabled
            ? true
            : await this.isBlockedEitherWay(
                  { Id: userId, Username: await this.usernameOf(userId) },
                  other
              );

        return {
            success: true,
            other: {
                userId: other.Id,
                username: other.Disabled ? 'Deleted user' : other.Username,
                avatar: other.Disabled ? null : other.Settings_Avatar
            },
            // Whether a reply can be sent at all - so the composer can say so
            // instead of failing on send.
            canMessage: !blocked && other.Id !== me.Id,
            hasMore: (rows || []).length > limit,
            messages: page1.map((row) => ({
                id: row.Id,
                senderId: row.SenderId,
                senderUsername: row.SenderId === userId ? undefined : other.Username,
                recipientId: row.RecipientId,
                text: row.Text,
                matchId: row.MatchId,
                sentAt: row.SentAt,
                readAt: row.ReadAt,
                fromMe: row.SenderId === userId
            }))
        };
    }

    async usernameOf(userId) {
        const rows = await this.db.query('SELECT "Username" FROM "Users" WHERE "Id" = $1', [
            userId
        ]);

        return rows && rows[0] ? rows[0].Username : '';
    }

    /**
     * Opening a thread reads it: every unread message from that sender to this
     * player is stamped. Scoped by recipient, so a stray id cannot mark
     * somebody else's mail.
     */
    async markRead(userId, otherUsername) {
        const other = await this.findUser(otherUsername);

        if (!other) {
            return { success: false, message: 'No such player' };
        }

        const rows = await this.db.query(
            'UPDATE "DirectMessages" SET "ReadAt" = now() AT TIME ZONE \'utc\' ' +
                'WHERE "RecipientId" = $1 AND "SenderId" = $2 AND "ReadAt" IS NULL RETURNING "Id"',
            [userId, other.Id]
        );

        return { success: true, updated: rows ? rows.length : 0 };
    }

    /** The badge: messages waiting for this player, and from how many people. */
    async unreadCount(userId) {
        const rows = await this.db.query(
            'SELECT COUNT(*) AS "Unread", COUNT(DISTINCT "SenderId") AS "Senders" ' +
                'FROM "DirectMessages" WHERE "RecipientId" = $1 AND "ReadAt" IS NULL',
            [userId]
        );

        const row = rows && rows[0];

        return {
            unread: row ? Number(row.Unread) || 0 : 0,
            senders: row ? Number(row.Senders) || 0 : 0
        };
    }
}

module.exports = DirectMessageService;
module.exports.MAX_LENGTH = MAX_LENGTH;
module.exports.PAGE_SIZE = PAGE_SIZE;
