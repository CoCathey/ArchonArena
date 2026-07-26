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
            'SELECT "Id", "Username", "Settings_Avatar", "Country", "State", "Registered" ' +
                'FROM "Users" WHERE lower("Username") = lower($1) ' +
                'AND "Disabled" IS NOT TRUE AND "Verified" IS TRUE',
            [username]
        );

        const user = rows && rows[0];

        if (!user) {
            return null;
        }

        const [clubs, recentGames] = await Promise.all([
            this.getClubs(user.Id),
            this.getRecentGames(user.Id)
        ]);

        return {
            username: user.Username,
            avatar: user.Settings_Avatar,
            country: user.Country,
            state: user.State,
            joined: user.Registered,
            clubs,
            recentGames
        };
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
