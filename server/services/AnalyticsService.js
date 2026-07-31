const logger = require('./../log');

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Admin analytics and operations (N8).
 *
 * Everything here is derived from tables the platform already writes - no
 * event pipeline, no counters to keep in step with reality. Derived numbers
 * can be recomputed and audited; counters silently drift and then quietly
 * lie, which is worse than having no dashboard at all.
 *
 * The one exception is the matchmaking queue, which lives in memory and
 * leaves no trace of itself, so MatchmakingMetrics records it as it happens
 * (see migration 45).
 *
 * Results are cached for five minutes. These queries scan the games table,
 * an admin refreshing the page should not be able to hammer it, and nobody
 * makes a different operational decision because a number is five minutes
 * stale.
 */
class AnalyticsService {
    constructor(db = require('../db'), options = {}) {
        this.db = db;
        this.cache = new Map();
        // ARCHON (N5): the moderation queue's health belongs on the
        // operations dashboard - an unread queue is an outage nobody gets
        // paged for. Injected, so a dashboard built without moderation simply
        // omits the section.
        this.moderationService = options.moderationService || null;
    }

    async cached(key, producer) {
        const hit = this.cache.get(key);

        if (hit && hit.expires > Date.now()) {
            return hit.value;
        }

        const value = await producer();

        this.cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });

        return value;
    }

    clearCache() {
        this.cache.clear();
    }

    /**
     * Active players. "Active" means played a game that finished in the
     * window - deliberately not "logged in", because a session that opens
     * the site and leaves is not activity anyone should plan around.
     */
    async getActivity() {
        const rows = await this.db.query(
            'SELECT ' +
                'COUNT(DISTINCT gp."PlayerId") FILTER (' +
                'WHERE g."FinishedAt" >= (now() AT TIME ZONE \'utc\') - interval \'1 day\') AS "Dau", ' +
                'COUNT(DISTINCT gp."PlayerId") FILTER (' +
                'WHERE g."FinishedAt" >= (now() AT TIME ZONE \'utc\') - interval \'30 days\') AS "Mau", ' +
                'COUNT(*) FILTER (' +
                'WHERE g."FinishedAt" >= (now() AT TIME ZONE \'utc\') - interval \'1 day\') AS "GamesToday" ' +
                'FROM "Games" g JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
                'WHERE g."FinishedAt" IS NOT NULL',
            []
        );

        const row = (rows && rows[0]) || {};
        const dau = parseInt(row.Dau, 10) || 0;
        const mau = parseInt(row.Mau, 10) || 0;

        return {
            dau,
            mau,
            // Each game contributes two GamePlayers rows.
            gamesToday: Math.round((parseInt(row.GamesToday, 10) || 0) / 2),
            // The standard stickiness ratio. Null rather than 0 when there is
            // no monthly activity at all - "0% sticky" would be a claim, and
            // an empty month supports no claim either way.
            stickiness: mau > 0 ? Math.round((dau / mau) * 100) : null
        };
    }

    /** Games per day for charting, oldest first. */
    async getGamesPerDay(days = 30) {
        const window = Math.min(Math.max(1, parseInt(days, 10) || 30), 365);

        const rows = await this.db.query(
            'SELECT date_trunc(\'day\', g."FinishedAt") AS "Day", COUNT(*) AS "Games", ' +
                'COUNT(*) FILTER (WHERE g."Source" = \'irl\') AS "InPerson" ' +
                'FROM "Games" g WHERE g."FinishedAt" IS NOT NULL ' +
                `AND g."FinishedAt" >= (now() AT TIME ZONE 'utc') - interval '${window} days' ` +
                'GROUP BY 1 ORDER BY 1 ASC',
            []
        );

        return (rows || []).map((row) => ({
            day: row.Day,
            games: parseInt(row.Games, 10) || 0,
            inPerson: parseInt(row.InPerson, 10) || 0
        }));
    }

    /**
     * The new-player funnel: register -> onboard -> first deck -> first game
     * -> second game. The second game is the step that matters - one game is
     * curiosity, two is a returning player.
     *
     * Scoped to accounts registered in the window so the funnel measures what
     * is happening now rather than being permanently flattered by history.
     */
    async getFunnel(days = 30) {
        const window = Math.min(Math.max(1, parseInt(days, 10) || 30), 365);

        const rows = await this.db.query(
            'WITH cohort AS (' +
                'SELECT u."Id", u."OnboardedAt" FROM "Users" u ' +
                `WHERE u."Registered" >= (now() AT TIME ZONE 'utc') - interval '${window} days' ` +
                'AND u."Disabled" IS NOT TRUE), ' +
                'games AS (' +
                'SELECT gp."PlayerId", COUNT(*) AS "Played" FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                'JOIN cohort c ON c."Id" = gp."PlayerId" ' +
                'WHERE g."FinishedAt" IS NOT NULL GROUP BY gp."PlayerId") ' +
                'SELECT COUNT(*) AS "Registered", ' +
                'COUNT(*) FILTER (WHERE c."OnboardedAt" IS NOT NULL) AS "Onboarded", ' +
                'COUNT(*) FILTER (WHERE EXISTS (' +
                'SELECT 1 FROM "Decks" d WHERE d."UserId" = c."Id")) AS "HasDeck", ' +
                'COUNT(*) FILTER (WHERE EXISTS (' +
                'SELECT 1 FROM games gm WHERE gm."PlayerId" = c."Id")) AS "PlayedOne", ' +
                'COUNT(*) FILTER (WHERE EXISTS (' +
                'SELECT 1 FROM games gm WHERE gm."PlayerId" = c."Id" AND gm."Played" >= 2' +
                ')) AS "PlayedTwo" ' +
                'FROM cohort c',
            []
        );

        const row = (rows && rows[0]) || {};
        const registered = parseInt(row.Registered, 10) || 0;
        const step = (count) => ({
            count,
            percent: registered > 0 ? Math.round((count / registered) * 100) : null
        });

        return {
            windowDays: window,
            registered: step(registered),
            onboarded: step(parseInt(row.Onboarded, 10) || 0),
            firstDeck: step(parseInt(row.HasDeck, 10) || 0),
            firstGame: step(parseInt(row.PlayedOne, 10) || 0),
            secondGame: step(parseInt(row.PlayedTwo, 10) || 0)
        };
    }

    /**
     * Tournament health. The completion rate is the number that matters:
     * events that start and never finish are the failure mode organizers
     * actually hit, and it is invisible from the event list.
     */
    async getTournamentHealth(days = 90) {
        const window = Math.min(Math.max(1, parseInt(days, 10) || 90), 365);

        const rows = await this.db.query(
            'SELECT COUNT(*) AS "Total", ' +
                'COUNT(*) FILTER (WHERE "Status" = \'complete\') AS "Complete", ' +
                'COUNT(*) FILTER (WHERE "Status" = \'active\') AS "Active", ' +
                'COUNT(*) FILTER (WHERE "Status" = \'cancelled\') AS "Cancelled", ' +
                'COUNT(*) FILTER (WHERE "Status" = \'registration\') AS "Registration", ' +
                'AVG(EXTRACT(EPOCH FROM ("FinishedAt" - "StartedAt")) / 60) ' +
                'FILTER (WHERE "Status" = \'complete\' AND "StartedAt" IS NOT NULL) AS "AvgMinutes" ' +
                'FROM "Tournaments" ' +
                `WHERE "CreatedAt" >= (now() AT TIME ZONE 'utc') - interval '${window} days'`,
            []
        );

        const row = (rows && rows[0]) || {};
        const total = parseInt(row.Total, 10) || 0;
        const complete = parseInt(row.Complete, 10) || 0;
        // Events still in registration or mid-flight have not had the chance
        // to fail yet, so counting them would understate the rate.
        const settled = complete + (parseInt(row.Cancelled, 10) || 0);

        return {
            windowDays: window,
            total,
            complete,
            active: parseInt(row.Active, 10) || 0,
            cancelled: parseInt(row.Cancelled, 10) || 0,
            registration: parseInt(row.Registration, 10) || 0,
            completionRate: settled > 0 ? Math.round((complete / settled) * 100) : null,
            averageMinutes: row.AvgMinutes === null ? null : Math.round(row.AvgMinutes)
        };
    }

    /** Queue depth and how long players actually waited. */
    async getMatchmakingHealth(days = 7) {
        const window = Math.min(Math.max(1, parseInt(days, 10) || 7), 90);

        const rows = await this.db.query(
            'SELECT AVG("QueueDepth") AS "AvgDepth", MAX("QueueDepth") AS "PeakDepth", ' +
                'AVG("WaitSeconds") AS "AvgWait", ' +
                'percentile_cont(0.9) WITHIN GROUP (ORDER BY "WaitSeconds") AS "P90Wait", ' +
                'COUNT(*) FILTER (WHERE "WaitSeconds" IS NOT NULL) AS "Matches" ' +
                'FROM "MatchmakingMetrics" ' +
                `WHERE "RecordedAt" >= (now() AT TIME ZONE 'utc') - interval '${window} days'`,
            []
        );

        const row = (rows && rows[0]) || {};
        const round = (value) =>
            value === null || value === undefined ? null : Math.round(Number(value));

        return {
            windowDays: window,
            averageDepth: round(row.AvgDepth),
            peakDepth: round(row.PeakDepth),
            averageWaitSeconds: round(row.AvgWait),
            // The average hides the people who gave up waiting; the 90th
            // percentile is the experience worth acting on.
            p90WaitSeconds: round(row.P90Wait),
            matches: parseInt(row.Matches, 10) || 0
        };
    }

    /** Registrations per day, for spotting a spike (or a bot run). */
    async getRegistrations(days = 30) {
        const window = Math.min(Math.max(1, parseInt(days, 10) || 30), 365);

        const rows = await this.db.query(
            'SELECT date_trunc(\'day\', "Registered") AS "Day", COUNT(*) AS "Count" ' +
                'FROM "Users" ' +
                `WHERE "Registered" >= (now() AT TIME ZONE 'utc') - interval '${window} days' ` +
                'GROUP BY 1 ORDER BY 1 ASC',
            []
        );

        return (rows || []).map((row) => ({
            day: row.Day,
            count: parseInt(row.Count, 10) || 0
        }));
    }

    /** Everything the dashboard shows, in one round trip. */
    async getDashboard(options = {}) {
        return this.cached(`dashboard:${options.days || 30}`, async () => {
            const days = options.days || 30;

            try {
                const [
                    activity,
                    gamesPerDay,
                    funnel,
                    tournaments,
                    matchmaking,
                    registrations,
                    moderation
                ] = await Promise.all([
                    this.getActivity(),
                    this.getGamesPerDay(days),
                    this.getFunnel(days),
                    this.getTournamentHealth(),
                    this.getMatchmakingHealth(),
                    this.getRegistrations(days),
                    // ARCHON (N5): null when moderation is not wired in, so
                    // the dashboard omits the section rather than showing
                    // zeroes that would read as "queue is empty".
                    this.moderationService ? this.moderationService.getStats(days) : null
                ]);

                return {
                    success: true,
                    activity,
                    gamesPerDay,
                    funnel,
                    tournaments,
                    matchmaking,
                    registrations,
                    moderation
                };
            } catch (err) {
                logger.error('Failed to build the analytics dashboard', err);

                return { success: false, message: 'Could not load analytics' };
            }
        });
    }

    /**
     * Record a queue-depth sample or a completed match wait. Fire-and-forget
     * from the matchmaking hot path: a metrics write must never be able to
     * delay or fail a player getting a game.
     */
    async record({ format = null, queueDepth = 0, waitSeconds = null }) {
        try {
            await this.db.query(
                'INSERT INTO "MatchmakingMetrics" ("RecordedAt", "Format", "QueueDepth", "WaitSeconds") ' +
                    "VALUES (now() AT TIME ZONE 'utc', $1, $2, $3)",
                [format, queueDepth, waitSeconds]
            );
        } catch (err) {
            logger.warn(`Failed to record matchmaking metrics: ${err.message}`);
        }
    }
}

module.exports = AnalyticsService;
