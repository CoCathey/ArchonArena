const logger = require('../../log');

/**
 * Clubs (Phase 9): open-membership groups for local scenes and stores.
 * The creator owns the club; owners cannot leave (disband or, later,
 * transfer instead), members join and leave freely. Site admins can
 * disband any club.
 */
class ClubService {
    constructor(db = require('../../db')) {
        this.db = db;
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

        const rows = await this.db.query(
            'INSERT INTO "Clubs" ("Name", "Description", "OwnerId", "CreatedAt") ' +
                'VALUES ($1, $2, $3, now() AT TIME ZONE \'utc\') RETURNING "Id"',
            [name, (options.description || '').slice(0, 2000) || null, actorId]
        );
        const clubId = rows[0].Id;

        await this.db.query(
            'INSERT INTO "ClubMembers" ("ClubId", "UserId", "Role", "CreatedAt") ' +
                "VALUES ($1, $2, 'owner', now() AT TIME ZONE 'utc')",
            [clubId, actorId]
        );

        logger.info(`Club ${clubId} '${name}' created by user ${actorId}`);

        return { success: true, id: clubId };
    }

    async list(query) {
        const params = [];
        let where = '';

        if (query) {
            params.push(`%${query}%`);
            where = 'WHERE c."Name" ILIKE $1';
        }

        const rows = await this.db.query(
            'SELECT c."Id", c."Name", c."Description", u."Username" AS "Owner", ' +
                '(SELECT COUNT(*) FROM "ClubMembers" cm WHERE cm."ClubId" = c."Id") AS "MemberCount" ' +
                'FROM "Clubs" c JOIN "Users" u ON u."Id" = c."OwnerId" ' +
                `${where} ORDER BY "MemberCount" DESC, c."Id" LIMIT 100`,
            params
        );

        return (rows || []).map((row) => ({
            id: row.Id,
            name: row.Name,
            description: row.Description,
            owner: row.Owner,
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

        const members = await this.db.query(
            'SELECT cm."UserId", cm."Role", cm."CreatedAt", u."Username", u."Country" ' +
                'FROM "ClubMembers" cm JOIN "Users" u ON u."Id" = cm."UserId" ' +
                'WHERE cm."ClubId" = $1 ORDER BY cm."Role" = \'owner\' DESC, cm."Id"',
            [clubId]
        );

        const membership = actorId
            ? (members || []).find((member) => member.UserId === actorId)
            : null;

        return {
            success: true,
            club: {
                id: club.Id,
                name: club.Name,
                description: club.Description,
                ownerId: club.OwnerId,
                isMember: !!membership,
                isOwner: membership?.Role === 'owner'
            },
            members: (members || []).map((member) => ({
                userId: member.UserId,
                username: member.Username,
                role: member.Role,
                country: member.Country
            }))
        };
    }

    async join(clubId, actorId) {
        const club = await this.getClubRow(clubId);

        if (!club) {
            return { success: false, message: 'No such club' };
        }

        await this.db.query(
            'INSERT INTO "ClubMembers" ("ClubId", "UserId", "CreatedAt") ' +
                "VALUES ($1, $2, now() AT TIME ZONE 'utc') ON CONFLICT DO NOTHING",
            [clubId, actorId]
        );

        return { success: true };
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
