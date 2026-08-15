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
const { publicBadge, permissionsFromRoleNames } = require('../membership/publicBadge');
const { membershipFromDbRow } = require('../membership/mapRow');

const BIO_MAX_LENGTH = 280;

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

        const [clubs, recentGames, badge] = await Promise.all([
            this.getClubs(user.Id),
            this.getRecentGames(user.Id),
            this.getBadge(user.Id)
        ]);

        return {
            username: user.Username,
            avatar: user.Settings_Avatar,
            country: user.Country,
            state: user.State,
            bio: user.Bio || null,
            joined: user.Registered,
            role: badge.role,
            tier: badge.tier,
            tierName: badge.tierName,
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
     * @returns {Promise<{role: string, tier: string, tierName: string|null}>}
     */
    async getBadge(userId) {
        let roleNames = [];
        let membership;

        try {
            const rows = await this.db.query(
                'SELECT r."Name" FROM "UserRoles" ur JOIN "Roles" r ON r."Id" = ur."RoleId" ' +
                    'WHERE ur."UserId" = $1',
                [userId]
            );

            roleNames = (rows || []).map((row) => row.Name);
        } catch (err) {
            // A profile that renders without a badge is fine; one that 500s is
            // not. Same reasoning as the membership lookup below.
            logger.warn('Failed to look up roles for player profile', err);
        }

        try {
            const rows = await this.db.query('SELECT * FROM "Memberships" WHERE "UserId" = $1', [
                userId
            ]);

            membership = membershipFromDbRow(rows && rows[0]);
        } catch (err) {
            // The Memberships migration may not have run yet.
            logger.warn('Failed to look up membership for player profile', err);
        }

        return publicBadge({
            permissions: permissionsFromRoleNames(roleNames),
            membership: membership || null
        });
    }

    /** @deprecated use getBadge - kept so the role alone is still one call. */
    async getRole(userId) {
        return (await this.getBadge(userId)).role;
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
