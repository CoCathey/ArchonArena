/**
 * ARCHON: public player profile (`/players/:username`).
 *
 * A competitive platform is built on players looking each other up, and until
 * now no username anywhere on the site was clickable - there was no player page
 * to click through to.
 *
 * This service deliberately covers only the parts of a profile that nothing
 * else already serves: the header (avatar, location, joined date) and the
 * player's recent games. Amber, statistics and tournament trophies already have
 * their own public endpoints (/api/ratings/:username, /api/stats/player/:username,
 * /api/tournaments/history/:username) and the profile page composes those rather
 * than this service reaching across into four other domains.
 *
 * Privacy: only fields that are already public site behaviour - never email,
 * IP, password state or linked-identity data. Disabled accounts do not resolve,
 * matching the member directory and the leaderboards.
 */
const logger = require('../../log');
const { resolveEntitlements, can } = require('../membership/entitlements');
const { CAPABILITIES } = require('../membership/capabilities');
const { membershipFromDbRow } = require('../membership/mapRow');

const BIO_MAX_LENGTH = 280;

/**
 * ARCHON (N12): the badge, in the same order User.role uses.
 *
 * Deliberately not routed through UserService.mapPermissions: this is a display
 * concern on an unauthenticated endpoint, not authorization, and importing the
 * user service here would drag the whole account stack into a public profile
 * read. Nothing is granted from this - it decides a text colour.
 */
const ROLE_BY_PRIORITY = [
    ['Admin', 'admin'],
    ['TournamentWinner', 'winner'],
    ['PreviousTournamentWinner', 'previouswinner'],
    ['Contributor', 'contributor'],
    ['Supporter', 'supporter']
];

class PlayerProfileService {
    constructor(db = require('../../db')) {
        this.db = db;
    }

    /**
     * Profile header + clubs + recent games, or null when the account does not
     * exist, is disabled, or is unverified (the same population the member
     * directory lists).
     */
    async getProfile(username) {
        if (!username) {
            return null;
        }

        const rows = await this.db.query(
            'SELECT "Id", "Username", "Settings_Avatar", "Country", "State", "Bio", "Registered" ' +
                'FROM "Users" WHERE lower("Username") = lower($1) ' +
                'AND "Disabled" IS NOT TRUE AND "Verified" IS TRUE',
            [username]
        );

        const user = rows && rows[0];

        if (!user) {
            return null;
        }

        const [clubs, recentGames, role] = await Promise.all([
            this.getClubs(user.Id),
            this.getRecentGames(user.Id),
            this.getRole(user.Id)
        ]);

        return {
            username: user.Username,
            avatar: user.Settings_Avatar,
            country: user.Country,
            state: user.State,
            bio: user.Bio || null,
            joined: user.Registered,
            role,
            clubs,
            recentGames
        };
    }

    /**
     * ARCHON (N12): the badge shown next to this player's name.
     *
     * The Supporter tier sells "show your support next to your name in the
     * lobby and on your profile". The lobby half worked through User.role; the
     * profile half did not exist, because this payload carried no role at all -
     * so half of a live paid promise was unkept.
     *
     * Two sources, because there are two ways to be a supporter: the granted
     * Roles-table row, and a Patreon membership that carries the badge
     * capability. Both land on the same string, and the same colours the lobby
     * uses.
     *
     * @returns {Promise<string>} one of admin/winner/previouswinner/contributor/supporter/user
     */
    async getRole(userId) {
        let roleNames = new Set();

        try {
            const rows = await this.db.query(
                'SELECT r."Name" FROM "UserRoles" ur JOIN "Roles" r ON r."Id" = ur."RoleId" ' +
                    'WHERE ur."UserId" = $1',
                [userId]
            );

            roleNames = new Set((rows || []).map((row) => row.Name));
        } catch (err) {
            // A profile that renders without a badge is fine; one that 500s is
            // not. Same reasoning as the membership lookup below.
            logger.warn('Failed to look up roles for player profile', err);
        }

        for (const [roleName, role] of ROLE_BY_PRIORITY) {
            if (roleNames.has(roleName)) {
                return role;
            }
        }

        try {
            const rows = await this.db.query('SELECT * FROM "Memberships" WHERE "UserId" = $1', [
                userId
            ]);
            const entitlements = resolveEntitlements({
                user: { permissions: {} },
                membership: membershipFromDbRow(rows && rows[0])
            });

            if (can(entitlements, CAPABILITIES.SUPPORTER_BADGE)) {
                return 'supporter';
            }
        } catch (err) {
            // The Memberships migration may not have run yet.
            logger.warn('Failed to look up membership for player profile', err);
        }

        return 'user';
    }

    /** The bio as the account owner would edit it (no public/disabled gating). */
    async getBio(userId) {
        const rows = await this.db.query('SELECT "Bio" FROM "Users" WHERE "Id" = $1', [userId]);

        return (rows && rows[0] && rows[0].Bio) || null;
    }

    async setBio(userId, bio) {
        const normalizedBio = bio ? String(bio).trim().slice(0, BIO_MAX_LENGTH) || null : null;

        await this.db.query('UPDATE "Users" SET "Bio" = $1 WHERE "Id" = $2', [
            normalizedBio,
            userId
        ]);

        return { success: true, bio: normalizedBio };
    }

    async getClubs(userId) {
        const rows = await this.db.query(
            'SELECT c."Id", c."Name", m."Role" FROM "ClubMembers" m ' +
                'JOIN "Clubs" c ON c."Id" = m."ClubId" WHERE m."UserId" = $1 ORDER BY c."Name"',
            [userId]
        );

        return (rows || []).map((row) => ({
            id: row.Id,
            name: row.Name,
            role: row.Role
        }));
    }

    /**
     * The player's last finished games, from their side: who they played, what
     * they played, whether they won, and the game id so the row can link
     * through to the replay.
     */
    async getRecentGames(userId, limit = 10) {
        const rows = await this.db.query(
            'SELECT g."GameId", g."GameFormat", g."FinishedAt", g."WinReason", ' +
                '(g."WinnerId" = $1) AS "Won", ' +
                'me."Keys" AS "OwnKeys", opp."Keys" AS "OpponentKeys", ' +
                'ou."Username" AS "Opponent", d."Name" AS "DeckName" ' +
                'FROM "Games" g ' +
                'JOIN "GamePlayers" me ON me."GameId" = g."Id" AND me."PlayerId" = $1 ' +
                'LEFT JOIN "GamePlayers" opp ON opp."GameId" = g."Id" AND opp."PlayerId" <> $1 ' +
                'LEFT JOIN "Users" ou ON ou."Id" = opp."PlayerId" ' +
                'LEFT JOIN "Decks" d ON d."Id" = me."DeckId" ' +
                'WHERE g."FinishedAt" IS NOT NULL AND g."WinnerId" IS NOT NULL ' +
                'ORDER BY g."FinishedAt" DESC LIMIT $2',
            [userId, limit]
        );

        return (rows || []).map((row) => ({
            gameId: row.GameId,
            format: row.GameFormat,
            finishedAt: row.FinishedAt,
            winReason: row.WinReason,
            won: row.Won,
            keys: row.OwnKeys,
            opponentKeys: row.OpponentKeys,
            opponent: row.Opponent,
            deckName: row.DeckName
        }));
    }
}

module.exports = PlayerProfileService;
