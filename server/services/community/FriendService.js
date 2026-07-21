/**
 * Friends (Phase 9): requests, acceptance, and friend lists. A single
 * Friendships row represents a relationship; 'pending' means the
 * requester is waiting on the addressee, 'accepted' means friends.
 * Declining or removing deletes the row so it can be re-requested.
 */
class FriendService {
    constructor(db = require('../../db')) {
        this.db = db;
    }

    async findUserIdByUsername(username) {
        const rows = await this.db.query(
            'SELECT "Id" FROM "Users" WHERE lower("Username") = lower($1) AND "Disabled" IS NOT TRUE',
            [username]
        );

        return rows && rows[0] ? rows[0].Id : null;
    }

    async getRelationship(userIdA, userIdB) {
        const rows = await this.db.query(
            'SELECT * FROM "Friendships" WHERE ("RequesterId" = $1 AND "AddresseeId" = $2) ' +
                'OR ("RequesterId" = $2 AND "AddresseeId" = $1)',
            [userIdA, userIdB]
        );

        return rows && rows[0];
    }

    async sendRequest(actorId, targetUsername) {
        const targetId = await this.findUserIdByUsername(targetUsername);

        if (!targetId) {
            return { success: false, message: 'No such player' };
        }

        if (targetId === actorId) {
            return { success: false, message: 'You cannot friend yourself' };
        }

        const existing = await this.getRelationship(actorId, targetId);

        if (existing) {
            if (existing.Status === 'accepted') {
                return { success: false, message: 'You are already friends' };
            }

            if (existing.RequesterId === actorId) {
                return { success: false, message: 'Request already sent' };
            }

            // They already asked us - accept instead of duplicating
            return await this.respond(actorId, existing.RequesterId, true);
        }

        await this.db.query(
            'INSERT INTO "Friendships" ("RequesterId", "AddresseeId", "CreatedAt") ' +
                "VALUES ($1, $2, now() AT TIME ZONE 'utc')",
            [actorId, targetId]
        );

        return { success: true };
    }

    async respond(actorId, requesterId, accept) {
        const rows = await this.db.query(
            'SELECT * FROM "Friendships" WHERE "RequesterId" = $1 AND "AddresseeId" = $2 ' +
                'AND "Status" = \'pending\'',
            [requesterId, actorId]
        );

        if (!rows || rows.length === 0) {
            return { success: false, message: 'No such friend request' };
        }

        if (accept) {
            await this.db.query(
                'UPDATE "Friendships" SET "Status" = \'accepted\', ' +
                    '"RespondedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
                [rows[0].Id]
            );
        } else {
            await this.db.query('DELETE FROM "Friendships" WHERE "Id" = $1', [rows[0].Id]);
        }

        return { success: true };
    }

    async remove(actorId, otherUserId) {
        const relationship = await this.getRelationship(actorId, otherUserId);

        if (!relationship) {
            return { success: false, message: 'You are not friends' };
        }

        await this.db.query('DELETE FROM "Friendships" WHERE "Id" = $1', [relationship.Id]);

        return { success: true };
    }

    /**
     * Everything the friends page needs in one payload: accepted friends
     * and both directions of pending requests, each with usernames.
     */
    async overview(actorId) {
        const rows = await this.db.query(
            'SELECT f."Status", f."RequesterId", f."AddresseeId", ' +
                'ur."Username" AS "RequesterName", ua."Username" AS "AddresseeName" ' +
                'FROM "Friendships" f ' +
                'JOIN "Users" ur ON ur."Id" = f."RequesterId" ' +
                'JOIN "Users" ua ON ua."Id" = f."AddresseeId" ' +
                'WHERE f."RequesterId" = $1 OR f."AddresseeId" = $1 ' +
                'ORDER BY f."Id" DESC',
            [actorId]
        );

        const friends = [];
        const incoming = [];
        const outgoing = [];

        for (const row of rows || []) {
            const otherIsRequester = row.AddresseeId === actorId;
            const other = otherIsRequester
                ? { userId: row.RequesterId, username: row.RequesterName }
                : { userId: row.AddresseeId, username: row.AddresseeName };

            if (row.Status === 'accepted') {
                friends.push(other);
            } else if (otherIsRequester) {
                incoming.push(other);
            } else {
                outgoing.push(other);
            }
        }

        return { friends, incoming, outgoing };
    }
}

module.exports = FriendService;
