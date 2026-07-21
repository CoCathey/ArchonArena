const crypto = require('crypto');

const logger = require('../../log');

// Join codes skip easily-confused characters (0/O, 1/I/L).
const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const JOIN_CODE_LENGTH = 8;

/**
 * Clubs (Phase 9): open-membership groups for local scenes and stores.
 * The creator owns the club; owners cannot leave (disband or, later,
 * transfer instead), members join and leave freely. Site admins can
 * disband any club. Every club gets a shareable invite code so players
 * can join without searching (used by the onboarding wizard too).
 */
class ClubService {
    constructor(db = require('../../db')) {
        this.db = db;
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
            'INSERT INTO "Clubs" ("Name", "Description", "OwnerId", "JoinCode", "CreatedAt") ' +
                'VALUES ($1, $2, $3, $4, now() AT TIME ZONE \'utc\') RETURNING "Id"',
            [name, (options.description || '').slice(0, 2000) || null, actorId, joinCode]
        );
        const clubId = rows[0].Id;

        await this.db.query(
            'INSERT INTO "ClubMembers" ("ClubId", "UserId", "Role", "CreatedAt") ' +
                "VALUES ($1, $2, 'owner', now() AT TIME ZONE 'utc')",
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

        const isOwner = membership?.Role === 'owner';

        return {
            success: true,
            club: {
                id: club.Id,
                name: club.Name,
                description: club.Description,
                ownerId: club.OwnerId,
                isMember: !!membership,
                isOwner,
                // Only the owner sees the invite code - it is theirs to share
                joinCode: isOwner ? club.JoinCode : undefined
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

        return { success: true, id: rows[0].Id, name: rows[0].Name };
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
