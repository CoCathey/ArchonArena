const crypto = require('crypto');

const logger = require('../../log');

// Join codes skip easily-confused characters (0/O, 1/I/L).
const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const JOIN_CODE_LENGTH = 8;

/** Clubs may take anyone, or hold joins for the owner to approve. */
const JOIN_POLICIES = ['open', 'approval'];

/**
 * Clubs (Phase 9): groups for local scenes and stores.
 * The creator owns the club; owners cannot leave (disband or transfer
 * instead), members join and leave freely. Site admins can disband any
 * club. Every club gets a shareable invite code so players can join
 * without searching (used by the onboarding wizard too).
 *
 * ARCHON (N7): clubs can now rank their own members, hold joins for
 * approval, and hand ownership on. The first two are what makes a club a
 * scene rather than a list; the third is what stops an owner who has
 * moved away from being a dead hand on it forever.
 */
class ClubService {
    // ARCHON: notifications (N2) are injected and optional - a ClubService
    // built without one behaves exactly as it always did.
    // ARCHON (N7): so is the rating service, used only for club leaderboards.
    constructor(db = require('../../db'), notificationService = null, ratingService = null) {
        this.db = db;
        this.notificationService = notificationService;
        this.ratingService = ratingService;
    }

    normalizeJoinPolicy(policy) {
        return JOIN_POLICIES.includes(policy) ? policy : 'open';
    }

    generateJoinCode() {
        const bytes = crypto.randomBytes(JOIN_CODE_LENGTH);

        return Array.from(bytes)
            .map((byte) => JOIN_CODE_ALPHABET[byte % JOIN_CODE_ALPHABET.length])
            .join('');
    }

    normalizeJoinCode(code) {
        return String(code || '')
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '');
    }

    async create(actorId, options) {
        const name = (options.name || '').trim();

        if (name.length < 3 || name.length > 40) {
            return { success: false, message: 'Club name must be 3-40 characters' };
        }

        const existing = await this.db.query(
            'SELECT 1 FROM "Clubs" WHERE lower("Name") = lower($1)',
            [name]
        );
        if (existing && existing.length > 0) {
            return { success: false, message: 'A club with that name already exists' };
        }

        // Collisions are ~impossible in a 31^8 space, but re-roll a few
        // times anyway rather than surface a unique-index error.
        let joinCode = this.generateJoinCode();
        for (let attempt = 0; attempt < 5; attempt++) {
            const clash = await this.db.query('SELECT 1 FROM "Clubs" WHERE "JoinCode" = $1', [
                joinCode
            ]);
            if (!clash || clash.length === 0) {
                break;
            }
            joinCode = this.generateJoinCode();
        }

        const rows = await this.db.query(
            'INSERT INTO "Clubs" ("Name", "Description", "OwnerId", "JoinCode", "JoinPolicy", "CreatedAt") ' +
                'VALUES ($1, $2, $3, $4, $5, now() AT TIME ZONE \'utc\') RETURNING "Id"',
            [
                name,
                (options.description || '').slice(0, 2000) || null,
                actorId,
                joinCode,
                this.normalizeJoinPolicy(options.joinPolicy)
            ]
        );
        const clubId = rows[0].Id;

        await this.db.query(
            'INSERT INTO "ClubMembers" ("ClubId", "UserId", "Role", "Status", "CreatedAt") ' +
                "VALUES ($1, $2, 'owner', 'active', now() AT TIME ZONE 'utc')",
            [clubId, actorId]
        );

        logger.info(`Club ${clubId} '${name}' created by user ${actorId}`);

        return { success: true, id: clubId, joinCode };
    }

    async list(query) {
        const params = [];
        let where = '';

        if (query) {
            params.push(`%${query}%`);
            where = 'WHERE c."Name" ILIKE $1';
        }

        const rows = await this.db.query(
            'SELECT c."Id", c."Name", c."Description", c."JoinPolicy", u."Username" AS "Owner", ' +
                // Pending applicants are not members yet, so they do not
                // count toward a club's advertised size.
                '(SELECT COUNT(*) FROM "ClubMembers" cm WHERE cm."ClubId" = c."Id" ' +
                'AND cm."Status" = \'active\') AS "MemberCount" ' +
                'FROM "Clubs" c JOIN "Users" u ON u."Id" = c."OwnerId" ' +
                `${where} ORDER BY "MemberCount" DESC, c."Id" LIMIT 100`,
            params
        );

        return (rows || []).map((row) => ({
            id: row.Id,
            name: row.Name,
            description: row.Description,
            owner: row.Owner,
            joinPolicy: row.JoinPolicy || 'open',
            memberCount: parseInt(row.MemberCount, 10)
        }));
    }

    async getClubRow(clubId) {
        const rows = await this.db.query('SELECT * FROM "Clubs" WHERE "Id" = $1', [clubId]);

        return rows && rows[0];
    }

    async getDetail(clubId, actorId) {
        const club = await this.getClubRow(clubId);

        if (!club) {
            return { success: false, message: 'No such club' };
        }

        const rows = await this.db.query(
            'SELECT cm."UserId", cm."Role", cm."Status", cm."CreatedAt", u."Username", u."Country" ' +
                'FROM "ClubMembers" cm JOIN "Users" u ON u."Id" = cm."UserId" ' +
                'WHERE cm."ClubId" = $1 ORDER BY cm."Role" = \'owner\' DESC, cm."Id"',
            [clubId]
        );

        const all = rows || [];
        const membership = actorId ? all.find((member) => member.UserId === actorId) : null;
        const isOwner = membership?.Role === 'owner';
        const toMember = (member) => ({
            userId: member.UserId,
            username: member.Username,
            role: member.Role,
            country: member.Country,
            requestedAt: member.CreatedAt
        });

        // ARCHON (N7): a pending applicant is not a member. They are only
        // listed to the owner, who is the one who can act on them - showing
        // the queue to everyone would publish who was turned down.
        const pending = all.filter((member) => member.Status === 'pending');

        return {
            success: true,
            club: {
                id: club.Id,
                name: club.Name,
                description: club.Description,
                ownerId: club.OwnerId,
                joinPolicy: club.JoinPolicy || 'open',
                // Anything that is not explicitly pending counts as a member.
                // Stated this way round on purpose: 'active' is the column
                // default, so a row written before this column existed - or
                // read by a query that did not select it - must not be able to
                // tell a real member they are not one.
                isMember: !!membership && membership.Status !== 'pending',
                isPending: membership?.Status === 'pending',
                isOwner,
                // Only the owner sees the invite code - it is theirs to share
                joinCode: isOwner ? club.JoinCode : undefined,
                pendingCount: isOwner ? pending.length : undefined
            },
            members: all.filter((member) => member.Status !== 'pending').map(toMember),
            pendingMembers: isOwner ? pending.map(toMember) : []
        };
    }

    async join(clubId, actorId) {
        const club = await this.getClubRow(clubId);

        if (!club) {
            return { success: false, message: 'No such club' };
        }

        // ARCHON (N7): an approval club holds the join as a request. Note this
        // applies to code joins too - a join code can be forwarded by anyone,
        // so treating it as pre-approval would let a leaked code walk straight
        // past the vetting the owner asked for.
        const status =
            this.normalizeJoinPolicy(club.JoinPolicy) === 'approval' ? 'pending' : 'active';

        const inserted = await this.db.query(
            'INSERT INTO "ClubMembers" ("ClubId", "UserId", "Status", "CreatedAt") ' +
                "VALUES ($1, $2, $3, now() AT TIME ZONE 'utc') ON CONFLICT DO NOTHING " +
                'RETURNING "Id"',
            [clubId, actorId, status]
        );

        // ARCHON (N2): the club owner is the only person who can act on a new
        // member, and with invite codes they otherwise have no idea anyone
        // used theirs. Only on an actual insert - re-joining a club you are
        // already in is not news - and never to yourself, since the owner's own
        // membership row is created by create().
        if (
            this.notificationService &&
            inserted &&
            inserted.length > 0 &&
            club.OwnerId !== actorId
        ) {
            const rows = await this.db.query('SELECT "Username" FROM "Users" WHERE "Id" = $1', [
                actorId
            ]);
            const username = rows && rows[0] ? rows[0].Username : 'A player';

            // Not awaited: joining a club must not sit behind an email send.
            this.notificationService.notify({
                userId: club.OwnerId,
                category: 'club.join',
                title:
                    status === 'pending'
                        ? `${username} asked to join ${club.Name}`
                        : `${username} joined ${club.Name}`,
                url: `/community/clubs/${clubId}`,
                data: { clubId, clubName: club.Name, username, pending: status === 'pending' }
            });
        }

        return { success: true, pending: status === 'pending' };
    }

    /**
     * Approve or deny a pending applicant. Owner-only (or a site admin).
     * Denying deletes the row rather than marking it rejected: a club is not
     * a permanent record of who was turned away, and keeping the row would
     * silently block the person from ever asking again.
     */
    async decideJoinRequest(clubId, targetUserId, actor, approve) {
        const club = await this.getClubRow(clubId);

        if (!club) {
            return { success: false, message: 'No such club' };
        }

        if (club.OwnerId !== actor.id && !actor.permissions?.isAdmin) {
            return { success: false, message: 'Only the owner can decide join requests' };
        }

        const updated = approve
            ? await this.db.query(
                  'UPDATE "ClubMembers" SET "Status" = \'active\' ' +
                      'WHERE "ClubId" = $1 AND "UserId" = $2 AND "Status" = \'pending\' ' +
                      'RETURNING "Id"',
                  [clubId, targetUserId]
              )
            : await this.db.query(
                  'DELETE FROM "ClubMembers" WHERE "ClubId" = $1 AND "UserId" = $2 ' +
                      'AND "Status" = \'pending\' RETURNING "Id"',
                  [clubId, targetUserId]
              );

        if (!updated || updated.length === 0) {
            return { success: false, message: 'No pending request from that player' };
        }

        // Only on approval: telling someone they were rejected by a local
        // club is a worse outcome than them quietly noticing.
        if (approve && this.notificationService) {
            this.notificationService.notify({
                userId: targetUserId,
                category: 'club.join',
                title: `You were accepted into ${club.Name}`,
                url: `/community/clubs/${clubId}`,
                data: { clubId, clubName: club.Name }
            });
        }

        return { success: true };
    }

    /**
     * Hand the club to another member. The old owner stays on as an ordinary
     * member rather than being removed - they are usually still a regular, and
     * dropping them would be a surprising side effect of stepping down.
     *
     * Both rows move together: a club with two owners, or none, is worse than
     * a failed transfer.
     */
    async transferOwnership(clubId, targetUserId, actor) {
        const club = await this.getClubRow(clubId);

        if (!club) {
            return { success: false, message: 'No such club' };
        }

        if (club.OwnerId !== actor.id && !actor.permissions?.isAdmin) {
            return { success: false, message: 'Only the owner can transfer the club' };
        }

        if (targetUserId === club.OwnerId) {
            return { success: false, message: 'That player already owns the club' };
        }

        const target = await this.db.query(
            'SELECT 1 FROM "ClubMembers" WHERE "ClubId" = $1 AND "UserId" = $2 ' +
                'AND "Status" = \'active\'',
            [clubId, targetUserId]
        );

        if (!target || target.length === 0) {
            return { success: false, message: 'That player is not a member of this club' };
        }

        const client = await this.db.startTransaction();

        try {
            await this.db.queryTran(client, 'UPDATE "Clubs" SET "OwnerId" = $1 WHERE "Id" = $2', [
                targetUserId,
                clubId
            ]);
            await this.db.queryTran(
                client,
                'UPDATE "ClubMembers" SET "Role" = \'member\' WHERE "ClubId" = $1 AND "UserId" = $2',
                [clubId, club.OwnerId]
            );
            await this.db.queryTran(
                client,
                'UPDATE "ClubMembers" SET "Role" = \'owner\', "Status" = \'active\' ' +
                    'WHERE "ClubId" = $1 AND "UserId" = $2',
                [clubId, targetUserId]
            );
            await this.db.queryTran(client, 'COMMIT');
        } catch (err) {
            await this.db.queryTran(client, 'ROLLBACK');
            logger.error(`Failed to transfer club ${clubId}`, err);

            return { success: false, message: 'Could not transfer the club' };
        } finally {
            if (client.release) {
                client.release();
            }
        }

        logger.info(`Club ${clubId} transferred from ${club.OwnerId} to ${targetUserId}`);

        if (this.notificationService) {
            this.notificationService.notify({
                userId: targetUserId,
                category: 'club.join',
                title: `You now own ${club.Name}`,
                url: `/community/clubs/${clubId}`,
                data: { clubId, clubName: club.Name }
            });
        }

        return { success: true };
    }

    /**
     * Rank a club's members by Amber. The Amber itself comes from
     * RatingService so a club board can never disagree with the site board
     * about what a player's rating is - see getClubLeaderboard for why the
     * two nevertheless list different people.
     */
    async getLeaderboard(clubId, options = {}) {
        const club = await this.getClubRow(clubId);

        if (!club) {
            return { success: false, message: 'No such club' };
        }

        if (!this.ratingService) {
            return { success: false, message: 'Ratings are not available' };
        }

        const entries = await this.ratingService.getClubLeaderboard(clubId, options);

        return { success: true, club: { id: club.Id, name: club.Name }, entries };
    }

    /** Change the club's settings. Owner-only. */
    async updateSettings(clubId, actor, options = {}) {
        const club = await this.getClubRow(clubId);

        if (!club) {
            return { success: false, message: 'No such club' };
        }

        if (club.OwnerId !== actor.id && !actor.permissions?.isAdmin) {
            return { success: false, message: 'Only the owner can change club settings' };
        }

        const description =
            options.description === undefined
                ? club.Description
                : (options.description || '').slice(0, 2000) || null;

        await this.db.query(
            'UPDATE "Clubs" SET "Description" = $1, "JoinPolicy" = $2 WHERE "Id" = $3',
            [
                description,
                options.joinPolicy === undefined
                    ? this.normalizeJoinPolicy(club.JoinPolicy)
                    : this.normalizeJoinPolicy(options.joinPolicy),
                clubId
            ]
        );

        return { success: true };
    }

    async joinByCode(actorId, code) {
        const normalized = this.normalizeJoinCode(code);

        if (normalized.length < 4) {
            return { success: false, message: 'Invalid join code' };
        }

        const rows = await this.db.query('SELECT * FROM "Clubs" WHERE "JoinCode" = $1', [
            normalized
        ]);

        if (!rows || rows.length === 0) {
            return { success: false, message: 'No club matches that join code' };
        }

        const result = await this.join(rows[0].Id, actorId);

        if (!result.success) {
            return result;
        }

        // `pending` has to survive this hop. Everywhere else the client already
        // knows the club and can read its join policy; someone arriving with
        // nothing but a code cannot, so if this drops the flag the only thing
        // left to say is "joined" - to a player who is actually sitting in the
        // owner's approval queue.
        return { success: true, id: rows[0].Id, name: rows[0].Name, pending: !!result.pending };
    }

    async leave(clubId, actorId) {
        const club = await this.getClubRow(clubId);

        if (!club) {
            return { success: false, message: 'No such club' };
        }

        if (club.OwnerId === actorId) {
            return {
                success: false,
                message: 'Owners cannot leave their club - disband it instead'
            };
        }

        await this.db.query('DELETE FROM "ClubMembers" WHERE "ClubId" = $1 AND "UserId" = $2', [
            clubId,
            actorId
        ]);

        return { success: true };
    }

    async removeMember(clubId, targetUserId, actor) {
        const club = await this.getClubRow(clubId);

        if (!club) {
            return { success: false, message: 'No such club' };
        }

        if (club.OwnerId !== actor.id && !actor.permissions?.isAdmin) {
            return { success: false, message: 'Only the owner can remove members' };
        }

        if (targetUserId === club.OwnerId) {
            return { success: false, message: 'The owner cannot be removed' };
        }

        await this.db.query('DELETE FROM "ClubMembers" WHERE "ClubId" = $1 AND "UserId" = $2', [
            clubId,
            targetUserId
        ]);

        return { success: true };
    }

    async disband(clubId, actor) {
        const club = await this.getClubRow(clubId);

        if (!club) {
            return { success: false, message: 'No such club' };
        }

        if (club.OwnerId !== actor.id && !actor.permissions?.isAdmin) {
            return { success: false, message: 'Only the owner can disband the club' };
        }

        await this.db.query('DELETE FROM "Clubs" WHERE "Id" = $1', [clubId]);
        logger.info(`Club ${clubId} disbanded by user ${actor.id}`);

        return { success: true };
    }
}

module.exports = ClubService;
