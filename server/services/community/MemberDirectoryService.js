/**
 * Public member directory (Phase 9): privacy-safe search over accounts.
 * Only exposes what is already public site behaviour: username, joined
 * date, self-declared location, and archon rating. Never emails or IPs.
 */
class MemberDirectoryService {
    constructor(db = require('../../db')) {
        this.db = db;
    }

    async stats() {
        // Count the SAME population that search() lists (non-disabled AND
        // verified) so the "Members" / "Joined 24h" tiles match the number of
        // members a user can actually page through. Counting unverified
        // accounts here made the tiles overstate the browsable directory.
        const rows = await this.db.query(
            'SELECT COUNT(*) AS "Total", ' +
                'COUNT(*) FILTER (WHERE "Registered" > now() AT TIME ZONE \'utc\' - interval \'24 hours\') AS "Joined24h" ' +
                'FROM "Users" WHERE "Disabled" IS NOT TRUE AND "Verified" IS TRUE',
            []
        );

        return {
            total: parseInt(rows[0].Total, 10),
            joined24h: parseInt(rows[0].Joined24h, 10)
        };
    }

    async search({ query, country, limit, offset }) {
        const cappedLimit = Math.min(Math.max(1, parseInt(limit, 10) || 25), 50);
        const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

        const params = [];
        const conditions = ['u."Disabled" IS NOT TRUE', 'u."Verified" IS TRUE'];

        if (query) {
            params.push(`%${query}%`);
            conditions.push(`u."Username" ILIKE $${params.length}`);
        }

        if (country) {
            params.push(String(country).toUpperCase());
            conditions.push(`u."Country" = $${params.length}`);
        }

        params.push(cappedLimit);
        const limitIndex = params.length;
        params.push(safeOffset);
        const offsetIndex = params.length;

        const rows = await this.db.query(
            'SELECT u."Username", u."Country", u."State", u."Registered", ' +
                'r."Rating", r."GamesPlayed" ' +
                'FROM "Users" u ' +
                'LEFT JOIN "Ratings" r ON r."UserId" = u."Id" AND r."Pool" = \'archon\' ' +
                `WHERE ${conditions.join(' AND ')} ` +
                'ORDER BY r."Rating" DESC NULLS LAST, u."Username" ' +
                `LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
            params
        );

        return (rows || []).map((row) => ({
            username: row.Username,
            country: row.Country,
            state: row.State,
            joined: row.Registered,
            rating: row.Rating,
            gamesPlayed: row.GamesPlayed
        }));
    }
}

module.exports = MemberDirectoryService;
