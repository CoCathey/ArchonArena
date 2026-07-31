const logger = require('../../log');

// Mirrors RatingService's mapping so the two ladders agree on what a pool is.
const POOL_BY_FORMAT = {
    normal: 'archon',
    reversal: 'archon',
    'adaptive-bo1': 'archon',
    unchained: 'archon',
    archon: 'archon',
    sealed: 'sealed',
    alliance: 'alliance'
};

const DEFAULT_TEAM_RATING_CONFIG = {
    enabled: true,
    defaultRating: 1200,
    kFactor: 32,
    ratingFloor: 100
};

/**
 * Team ratings (N7).
 *
 * A team rating is NOT derived from its members' Amber. Averaging would let
 * a roster inherit a rating it never earned as a unit - three strong solo
 * players who lose every team event would still show a high team number,
 * which is the opposite of what the ladder is for. So teams have their own
 * ladder, seeded flat, moved only by team events.
 *
 * An event rates as a round robin on final standings: each team is treated
 * as having beaten every team that finished below it and lost to every team
 * above it, and the per-opponent Elo deltas are averaged. Averaging (rather
 * than summing) is the important part - summing would make a 32-team event
 * move ratings roughly ten times as far as a 4-team event for the same
 * quality of performance, so the ladder would be dominated by whoever
 * happened to enter the biggest field rather than by who plays best.
 */
class TeamRatingService {
    constructor(db = require('../../db'), settingsService = null) {
        this.db = db;
        this.settingsService = settingsService;
    }

    getConfig() {
        const overrides = this.settingsService
            ? this.settingsService.getSection('teamRating')
            : null;

        return { ...DEFAULT_TEAM_RATING_CONFIG, ...(overrides || {}) };
    }

    expected(ratingA, ratingB) {
        return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
    }

    /**
     * Event game format -> team rating pool. Deliberately the same three
     * pools as the individual ladder (RatingService.POOL_BY_FORMAT): a team
     * that plays Sealed events is not the same competitive entity as one
     * that plays Archon, exactly as for a single player.
     */
    normalizePool(gameFormat) {
        const pool = POOL_BY_FORMAT[String(gameFormat || '').toLowerCase()];

        return pool || 'archon';
    }

    /**
     * Final team standings for an event: each team's match record, summed
     * over the matches its registered members played.
     */
    async getEventStandings(tournamentId) {
        const rows = await this.db.query(
            'SELECT tp."TeamId", t."Name", ' +
                'COUNT(*) FILTER (WHERE m."WinnerId" = tp."UserId") AS "Wins", ' +
                'COUNT(*) FILTER (WHERE m."WinnerId" IS NOT NULL ' +
                'AND m."WinnerId" <> tp."UserId") AS "Losses" ' +
                'FROM "TournamentPlayers" tp ' +
                'JOIN "Teams" t ON t."Id" = tp."TeamId" ' +
                'LEFT JOIN "TournamentMatches" m ON m."TournamentId" = tp."TournamentId" ' +
                'AND (m."Player1Id" = tp."UserId" OR m."Player2Id" = tp."UserId") ' +
                'WHERE tp."TournamentId" = $1 AND tp."TeamId" IS NOT NULL ' +
                'GROUP BY tp."TeamId", t."Name" ' +
                'ORDER BY "Wins" DESC, "Losses" ASC, t."Name" ASC',
            [tournamentId]
        );

        return (rows || []).map((row) => ({
            teamId: row.TeamId,
            name: row.Name,
            wins: parseInt(row.Wins, 10) || 0,
            losses: parseInt(row.Losses, 10) || 0
        }));
    }

    async getOrDefaultRating(teamId, pool, config) {
        const rows = await this.db.query(
            'SELECT "Rating", "EventsPlayed" FROM "TeamRatings" WHERE "TeamId" = $1 AND "Pool" = $2',
            [teamId, pool]
        );

        if (rows && rows[0]) {
            return { rating: rows[0].Rating, eventsPlayed: rows[0].EventsPlayed };
        }

        return { rating: config.defaultRating, eventsPlayed: 0 };
    }

    /**
     * Rate a finished team event. Idempotent: TeamEventResults has a unique
     * (TournamentId, TeamId), so a second call inserts nothing and leaves
     * every rating alone. Finishing an event twice must not rate it twice.
     */
    async rateEvent(tournamentId, gameFormat = 'archon') {
        const config = this.getConfig();
        const pool = this.normalizePool(gameFormat);

        if (!config.enabled) {
            return { success: false, message: 'Team rating is disabled' };
        }

        const standings = await this.getEventStandings(tournamentId);

        if (standings.length < 2) {
            // One team is not a competition.
            return { success: true, rated: 0 };
        }

        const already = await this.db.query(
            'SELECT 1 FROM "TeamEventResults" WHERE "TournamentId" = $1 LIMIT 1',
            [tournamentId]
        );

        if (already && already.length > 0) {
            return { success: true, rated: 0, alreadyRated: true };
        }

        const before = new Map();

        for (const team of standings) {
            before.set(team.teamId, await this.getOrDefaultRating(team.teamId, pool, config));
        }

        // Rank on wins, with ties sharing a rank so two teams on the same
        // record neither gain nor lose against each other.
        const rankOf = new Map();
        let rank = 0;
        let lastWins = null;

        standings.forEach((team, index) => {
            if (team.wins !== lastWins) {
                rank = index + 1;
                lastWins = team.wins;
            }

            rankOf.set(team.teamId, rank);
        });

        const updates = standings.map((team) => {
            const own = before.get(team.teamId);
            const opponents = standings.filter((other) => other.teamId !== team.teamId);

            const delta =
                opponents.reduce((sum, other) => {
                    const otherRating = before.get(other.teamId).rating;
                    const ownRank = rankOf.get(team.teamId);
                    const otherRank = rankOf.get(other.teamId);
                    const actual = ownRank === otherRank ? 0.5 : ownRank < otherRank ? 1 : 0;

                    return sum + (actual - this.expected(own.rating, otherRating));
                }, 0) / opponents.length;

            const after = Math.max(
                config.ratingFloor,
                Math.round(own.rating + config.kFactor * delta)
            );

            return { team, before: own, after, rank: rankOf.get(team.teamId) };
        });

        const client = await this.db.startTransaction();

        try {
            for (const update of updates) {
                await this.db.queryTran(
                    client,
                    'INSERT INTO "TeamRatings" ("TeamId", "Pool", "Rating", "EventsPlayed", "UpdatedAt") ' +
                        "VALUES ($1, $2, $3, $4, now() AT TIME ZONE 'utc') " +
                        'ON CONFLICT ("TeamId", "Pool") DO UPDATE SET ' +
                        '"Rating" = EXCLUDED."Rating", "EventsPlayed" = EXCLUDED."EventsPlayed", ' +
                        '"UpdatedAt" = EXCLUDED."UpdatedAt"',
                    [update.team.teamId, pool, update.after, update.before.eventsPlayed + 1]
                );

                await this.db.queryTran(
                    client,
                    'INSERT INTO "TeamEventResults" ("TournamentId", "TeamId", "Pool", "Rank", ' +
                        '"MatchWins", "MatchLosses", "RatingBefore", "RatingAfter", "CreatedAt") ' +
                        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() AT TIME ZONE 'utc') " +
                        'ON CONFLICT ("TournamentId", "TeamId") DO NOTHING',
                    [
                        tournamentId,
                        update.team.teamId,
                        pool,
                        update.rank,
                        update.team.wins,
                        update.team.losses,
                        update.before.rating,
                        update.after
                    ]
                );
            }

            await this.db.queryTran(client, 'COMMIT');
        } catch (err) {
            await this.db.queryTran(client, 'ROLLBACK');
            logger.error(`Failed to rate team event ${tournamentId}`, err);

            return { success: false, message: 'Could not rate the event' };
        } finally {
            if (client.release) {
                client.release();
            }
        }

        logger.info(`Rated team event ${tournamentId}: ${updates.length} team(s)`);

        return {
            success: true,
            rated: updates.length,
            standings: updates.map((update) => ({
                teamId: update.team.teamId,
                name: update.team.name,
                rank: update.rank,
                wins: update.team.wins,
                losses: update.team.losses,
                ratingBefore: update.before.rating,
                ratingAfter: update.after
            }))
        };
    }
}

module.exports = TeamRatingService;
module.exports.DEFAULT_TEAM_RATING_CONFIG = DEFAULT_TEAM_RATING_CONFIG;
