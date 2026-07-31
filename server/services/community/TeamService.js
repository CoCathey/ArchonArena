const crypto = require('crypto');

const logger = require('../../log');

// Same alphabet as club join codes: no 0/O, no 1/I/L, because these get
// read aloud across a table.
const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const JOIN_CODE_LENGTH = 8;

const MAX_ROSTER = 12;

/**
 * Teams (N7): rosters that enter events as a unit.
 *
 * A team is not a club. A club is a place - a store, a city, a Discord -
 * and people belong to one for years. A team is a roster assembled to
 * play a season together, and the same person is often in a club and on
 * a team drawn from a different club entirely. Modelling them as one
 * thing would force every club to be a competitive entity and every team
 * to be a social one.
 *
 * A team may optionally belong to a club, which is how a store fields
 * several teams from its own membership.
 */
class TeamService {
    constructor(db = require('../../db'), notificationService = null) {
        this.db = db;
        this.notificationService = notificationService;
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

    async getTeamRow(teamId) {
        const rows = await this.db.query('SELECT * FROM "Teams" WHERE "Id" = $1', [teamId]);

        return rows && rows[0];
    }

    async create(actorId, options = {}) {
        const name = (options.name || '').trim();

        if (name.length < 3 || name.length > 40) {
            return { success: false, message: 'Team name must be 3-40 characters' };
        }

        const existing = await this.db.query(
            'SELECT 1 FROM "Teams" WHERE lower("Name") = lower($1)',
            [name]
        );

        if (existing && existing.length > 0) {
            return { success: false, message: 'A team with that name already exists' };
        }

        // A team can only be fielded by a club its captain actually belongs
        // to - otherwise anyone could hang their roster off someone else's
        // store.
        let clubId = null;

        if (options.clubId) {
            const membership = await this.db.query(
                'SELECT 1 FROM "ClubMembers" WHERE "ClubId" = $1 AND "UserId" = $2 ' +
                    'AND "Status" = \'active\'',
                [parseInt(options.clubId, 10), actorId]
            );

            if (!membership || membership.length === 0) {
                return { success: false, message: 'You are not a member of that club' };
            }

            clubId = parseInt(options.clubId, 10);
        }

        let joinCode = this.generateJoinCode();

        for (let attempt = 0; attempt < 5; attempt++) {
            const clash = await this.db.query('SELECT 1 FROM "Teams" WHERE "JoinCode" = $1', [
                joinCode
            ]);

            if (!clash || clash.length === 0) {
                break;
            }

            joinCode = this.generateJoinCode();
        }

        const rows = await this.db.query(
            'INSERT INTO "Teams" ("Name", "Description", "CaptainId", "ClubId", "JoinCode", "CreatedAt") ' +
                'VALUES ($1, $2, $3, $4, $5, now() AT TIME ZONE \'utc\') RETURNING "Id"',
            [name, (options.description || '').slice(0, 2000) || null, actorId, clubId, joinCode]
        );
        const teamId = rows[0].Id;

        await this.db.query(
            'INSERT INTO "TeamMembers" ("TeamId", "UserId", "Role", "CreatedAt") ' +
                "VALUES ($1, $2, 'captain', now() AT TIME ZONE 'utc')",
            [teamId, actorId]
        );

        logger.info(`Team ${teamId} '${name}' created by user ${actorId}`);

        return { success: true, id: teamId, joinCode };
    }

    async list(query) {
        const params = [];
        let where = '';

        if (query) {
            params.push(`%${query}%`);
            where = 'WHERE t."Name" ILIKE $1';
        }

        const rows = await this.db.query(
            'SELECT t."Id", t."Name", t."Description", u."Username" AS "Captain", ' +
                'c."Name" AS "ClubName", ' +
                '(SELECT COUNT(*) FROM "TeamMembers" tm WHERE tm."TeamId" = t."Id") AS "MemberCount", ' +
                // The archon pool is the default ladder a team page leads with.
                '(SELECT tr."Rating" FROM "TeamRatings" tr WHERE tr."TeamId" = t."Id" ' +
                'AND tr."Pool" = \'archon\') AS "Rating" ' +
                'FROM "Teams" t JOIN "Users" u ON u."Id" = t."CaptainId" ' +
                'LEFT JOIN "Clubs" c ON c."Id" = t."ClubId" ' +
                `${where} ORDER BY "Rating" DESC NULLS LAST, "MemberCount" DESC, t."Id" LIMIT 100`,
            params
        );

        return (rows || []).map((row) => ({
            id: row.Id,
            name: row.Name,
            description: row.Description,
            captain: row.Captain,
            clubName: row.ClubName,
            memberCount: parseInt(row.MemberCount, 10),
            rating: row.Rating === null || row.Rating === undefined ? null : row.Rating
        }));
    }

    async getDetail(teamId, actorId) {
        const team = await this.getTeamRow(teamId);

        if (!team) {
            return { success: false, message: 'No such team' };
        }

        const members = await this.db.query(
            'SELECT tm."UserId", tm."Role", tm."CreatedAt", u."Username", u."Country" ' +
                'FROM "TeamMembers" tm JOIN "Users" u ON u."Id" = tm."UserId" ' +
                'WHERE tm."TeamId" = $1 ORDER BY tm."Role" = \'captain\' DESC, tm."Id"',
            [teamId]
        );

        const ratings = await this.db.query(
            'SELECT "Pool", "Rating", "EventsPlayed" FROM "TeamRatings" WHERE "TeamId" = $1 ' +
                'ORDER BY "Pool"',
            [teamId]
        );

        const results = await this.db.query(
            'SELECT r."TournamentId", r."Pool", r."Rank", r."MatchWins", r."MatchLosses", ' +
                'r."RatingBefore", r."RatingAfter", t."Name" AS "TournamentName", r."CreatedAt" ' +
                'FROM "TeamEventResults" r JOIN "Tournaments" t ON t."Id" = r."TournamentId" ' +
                'WHERE r."TeamId" = $1 ORDER BY r."Id" DESC LIMIT 25',
            [teamId]
        );

        const membership = actorId
            ? (members || []).find((member) => member.UserId === actorId)
            : null;
        const isCaptain = membership?.Role === 'captain';

        return {
            success: true,
            team: {
                id: team.Id,
                name: team.Name,
                description: team.Description,
                captainId: team.CaptainId,
                clubId: team.ClubId,
                isMember: !!membership,
                isCaptain,
                // As with clubs, the code is the captain's to hand out.
                joinCode: isCaptain ? team.JoinCode : undefined
            },
            members: (members || []).map((member) => ({
                userId: member.UserId,
                username: member.Username,
                role: member.Role,
                country: member.Country
            })),
            ratings: (ratings || []).map((row) => ({
                pool: row.Pool,
                rating: row.Rating,
                eventsPlayed: row.EventsPlayed
            })),
            results: (results || []).map((row) => ({
                tournamentId: row.TournamentId,
                tournamentName: row.TournamentName,
                pool: row.Pool,
                rank: row.Rank,
                matchWins: row.MatchWins,
                matchLosses: row.MatchLosses,
                ratingBefore: row.RatingBefore,
                ratingAfter: row.RatingAfter,
                ratingDelta: row.RatingAfter - row.RatingBefore,
                createdAt: row.CreatedAt
            }))
        };
    }

    async joinByCode(actorId, code) {
        const normalized = this.normalizeJoinCode(code);

        if (normalized.length < 4) {
            return { success: false, message: 'Invalid join code' };
        }

        const rows = await this.db.query('SELECT * FROM "Teams" WHERE "JoinCode" = $1', [
            normalized
        ]);

        if (!rows || rows.length === 0) {
            return { success: false, message: 'No team matches that join code' };
        }

        const team = rows[0];

        const roster = await this.db.query(
            'SELECT COUNT(*) AS "Count" FROM "TeamMembers" WHERE "TeamId" = $1',
            [team.Id]
        );

        if (parseInt(roster[0].Count, 10) >= MAX_ROSTER) {
            return { success: false, message: 'That team roster is full' };
        }

        const inserted = await this.db.query(
            'INSERT INTO "TeamMembers" ("TeamId", "UserId", "CreatedAt") ' +
                'VALUES ($1, $2, now() AT TIME ZONE \'utc\') ON CONFLICT DO NOTHING RETURNING "Id"',
            [team.Id, actorId]
        );

        if (
            this.notificationService &&
            inserted &&
            inserted.length > 0 &&
            team.CaptainId !== actorId
        ) {
            const userRows = await this.db.query('SELECT "Username" FROM "Users" WHERE "Id" = $1', [
                actorId
            ]);
            const username = userRows && userRows[0] ? userRows[0].Username : 'A player';

            this.notificationService.notify({
                userId: team.CaptainId,
                category: 'club.join',
                title: `${username} joined ${team.Name}`,
                url: `/community/teams/${team.Id}`,
                data: { teamId: team.Id, teamName: team.Name, username }
            });
        }

        return { success: true, id: team.Id, name: team.Name };
    }

    async leave(teamId, actorId) {
        const team = await this.getTeamRow(teamId);

        if (!team) {
            return { success: false, message: 'No such team' };
        }

        if (team.CaptainId === actorId) {
            return {
                success: false,
                message: 'Captains cannot leave - hand the team on or disband it'
            };
        }

        await this.db.query('DELETE FROM "TeamMembers" WHERE "TeamId" = $1 AND "UserId" = $2', [
            teamId,
            actorId
        ]);

        return { success: true };
    }

    async removeMember(teamId, targetUserId, actor) {
        const team = await this.getTeamRow(teamId);

        if (!team) {
            return { success: false, message: 'No such team' };
        }

        if (team.CaptainId !== actor.id && !actor.permissions?.isAdmin) {
            return { success: false, message: 'Only the captain can remove members' };
        }

        if (targetUserId === team.CaptainId) {
            return { success: false, message: 'The captain cannot be removed' };
        }

        await this.db.query('DELETE FROM "TeamMembers" WHERE "TeamId" = $1 AND "UserId" = $2', [
            teamId,
            targetUserId
        ]);

        return { success: true };
    }

    async transferCaptaincy(teamId, targetUserId, actor) {
        const team = await this.getTeamRow(teamId);

        if (!team) {
            return { success: false, message: 'No such team' };
        }

        if (team.CaptainId !== actor.id && !actor.permissions?.isAdmin) {
            return { success: false, message: 'Only the captain can hand the team on' };
        }

        if (targetUserId === team.CaptainId) {
            return { success: false, message: 'That player already captains the team' };
        }

        const target = await this.db.query(
            'SELECT 1 FROM "TeamMembers" WHERE "TeamId" = $1 AND "UserId" = $2',
            [teamId, targetUserId]
        );

        if (!target || target.length === 0) {
            return { success: false, message: 'That player is not on this team' };
        }

        const client = await this.db.startTransaction();

        try {
            await this.db.queryTran(client, 'UPDATE "Teams" SET "CaptainId" = $1 WHERE "Id" = $2', [
                targetUserId,
                teamId
            ]);
            await this.db.queryTran(
                client,
                'UPDATE "TeamMembers" SET "Role" = \'member\' WHERE "TeamId" = $1 AND "UserId" = $2',
                [teamId, team.CaptainId]
            );
            await this.db.queryTran(
                client,
                'UPDATE "TeamMembers" SET "Role" = \'captain\' WHERE "TeamId" = $1 AND "UserId" = $2',
                [teamId, targetUserId]
            );
            await this.db.queryTran(client, 'COMMIT');
        } catch (err) {
            await this.db.queryTran(client, 'ROLLBACK');
            logger.error(`Failed to transfer team ${teamId}`, err);

            return { success: false, message: 'Could not hand the team on' };
        } finally {
            if (client.release) {
                client.release();
            }
        }

        return { success: true };
    }

    async disband(teamId, actor) {
        const team = await this.getTeamRow(teamId);

        if (!team) {
            return { success: false, message: 'No such team' };
        }

        if (team.CaptainId !== actor.id && !actor.permissions?.isAdmin) {
            return { success: false, message: 'Only the captain can disband the team' };
        }

        await this.db.query('DELETE FROM "Teams" WHERE "Id" = $1', [teamId]);
        logger.info(`Team ${teamId} disbanded by user ${actor.id}`);

        return { success: true };
    }

    /** Teams the player is on - used to pick one when registering for an event. */
    async getTeamsForUser(userId) {
        const rows = await this.db.query(
            'SELECT t."Id", t."Name", tm."Role" FROM "TeamMembers" tm ' +
                'JOIN "Teams" t ON t."Id" = tm."TeamId" WHERE tm."UserId" = $1 ORDER BY t."Name"',
            [userId]
        );

        return (rows || []).map((row) => ({
            id: row.Id,
            name: row.Name,
            role: row.Role
        }));
    }

    /** The team ladder. */
    async getLeaderboard(options = {}) {
        const pool = options.pool || 'archon';
        const limit = Math.min(Math.max(1, parseInt(options.limit, 10) || 50), 200);

        const rows = await this.db.query(
            'SELECT t."Id", t."Name", tr."Rating", tr."EventsPlayed", u."Username" AS "Captain", ' +
                'c."Name" AS "ClubName" ' +
                'FROM "TeamRatings" tr JOIN "Teams" t ON t."Id" = tr."TeamId" ' +
                'JOIN "Users" u ON u."Id" = t."CaptainId" ' +
                'LEFT JOIN "Clubs" c ON c."Id" = t."ClubId" ' +
                'WHERE tr."Pool" = $1 ' +
                'ORDER BY tr."Rating" DESC, tr."EventsPlayed" DESC, t."Name" ASC LIMIT $2',
            [pool, limit]
        );

        return (rows || []).map((row, index) => ({
            rank: index + 1,
            teamId: row.Id,
            name: row.Name,
            captain: row.Captain,
            clubName: row.ClubName,
            rating: row.Rating,
            eventsPlayed: row.EventsPlayed
        }));
    }
}

module.exports = TeamService;
module.exports.MAX_ROSTER = MAX_ROSTER;
