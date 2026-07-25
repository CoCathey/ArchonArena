const db = require('../db');

// SAS rating bands (ascending, contiguous, open-ended at the top) used to
// bucket deck power for the meta win-rate-by-SAS chart. Single-sourced here so
// the generated SQL CASE and the pure JS labeller can never drift apart.
const SAS_BANDS = [
    { label: '<50', max: 50 },
    { label: '50-59', max: 60 },
    { label: '60-69', max: 70 },
    { label: '70-79', max: 80 },
    { label: '80-89', max: 90 },
    { label: '90+', max: Infinity }
];

const BAND_ORDER = SAS_BANDS.map((band) => band.label);

/**
 * Win rate as a one-decimal percentage (0-100), or null when there are no
 * games to divide by. Pure so it is trivially unit-testable and shared by
 * every aggregation below.
 */
function winRate(wins, games) {
    const w = Number(wins) || 0;
    const g = Number(games) || 0;

    if (g <= 0) {
        return null;
    }

    return Math.round((w / g) * 1000) / 10;
}

/**
 * The SAS band label a rating falls into, or null when unrated/non-numeric.
 * Mirrors sasBandCaseSql exactly (both walk SAS_BANDS in order).
 */
function sasBandLabel(sas) {
    if (sas === null || sas === undefined || sas === '' || Number.isNaN(Number(sas))) {
        return null;
    }

    const value = Number(sas);

    for (const band of SAS_BANDS) {
        if (value < band.max) {
            return band.label;
        }
    }

    return SAS_BANDS[SAS_BANDS.length - 1].label;
}

/**
 * Build the SQL CASE expression that buckets `column` into SAS_BANDS labels.
 * The labels are hard-coded constants (digits, '<', '-', '+') so there is no
 * injection surface; `column` is always a caller-supplied identifier literal.
 */
function sasBandCaseSql(column) {
    const whens = SAS_BANDS.filter((band) => Number.isFinite(band.max)).map(
        (band) => `WHEN ${column} < ${band.max} THEN '${band.label}'`
    );

    return `CASE ${whens.join(' ')} ELSE '${SAS_BANDS[SAS_BANDS.length - 1].label}' END`;
}

const round2 = (value) => (value == null ? null : Math.round(Number(value) * 100) / 100);
const roundInt = (value) => (value == null ? null : Math.round(Number(value)));

/**
 * ARCHON: platform statistics & analytics.
 *
 * Aggregates finished, decided games (Games / GamePlayers / Decks / DeckHouses
 * / DeckSas) into a meta dashboard (house win rates, format share, deck-power
 * win rates, totals) and per-player breakdowns. Results are read-only and
 * expensive to compute over a growing game log, so each answer is memoised in
 * a small in-memory TTL cache; freshness within a minute or so is plenty for a
 * stats page.
 *
 * `db` is injectable (defaults to the shared PG pool) so the service is
 * unit-testable, matching RatingService / GameService.
 */
class StatisticsService {
    constructor(database = db, options = {}) {
        this.db = database;
        this.ttlMs = options.ttlMs ?? 60000;
        // Injectable clock so cache-expiry is deterministic under test.
        this.now = options.now || (() => Date.now());
        this.cache = new Map();
    }

    /** Memoise `producer` under `key` for ttlMs; recompute once it expires. */
    async cached(key, producer) {
        const now = this.now();
        const hit = this.cache.get(key);

        if (hit && hit.expires > now) {
            return hit.value;
        }

        const value = await producer();
        this.cache.set(key, { value, expires: now + this.ttlMs });

        return value;
    }

    clearCache() {
        this.cache.clear();
    }

    /** Meta dashboard across every finished, decided game. Cached. */
    async getMetaStats() {
        return this.cached('meta', () => this.computeMetaStats());
    }

    async computeMetaStats() {
        const [totalsRows, houseRows, formatRows, sasRows] = await Promise.all([
            // Game-level totals in one round-trip (subqueries keep the
            // players-level avg keys from double-counting the game rows).
            this.db.query(
                'SELECT ' +
                    '(SELECT COUNT(*) FROM "Games" WHERE "FinishedAt" IS NOT NULL) AS "finishedGames", ' +
                    '(SELECT COUNT(*) FROM "Games" WHERE "FinishedAt" IS NOT NULL ' +
                    'AND "WinnerId" IS NOT NULL) AS "decidedGames", ' +
                    '(SELECT AVG(EXTRACT(EPOCH FROM ("FinishedAt" - "StartedAt"))) FROM "Games" ' +
                    'WHERE "FinishedAt" IS NOT NULL AND "StartedAt" IS NOT NULL ' +
                    'AND "FinishedAt" > "StartedAt") AS "avgDurationSec", ' +
                    '(SELECT AVG(gp."Keys") FROM "GamePlayers" gp ' +
                    'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                    'WHERE g."FinishedAt" IS NOT NULL AND g."WinnerId" IS NOT NULL) AS "avgKeys"'
            ),
            // Win rate per house: every deck contributes its three houses to
            // the games it played, won or lost.
            this.db.query(
                'SELECT h."Name" AS "house", COUNT(*) AS "games", ' +
                    'COUNT(*) FILTER (WHERE gp."PlayerId" = g."WinnerId") AS "wins" ' +
                    'FROM "Games" g ' +
                    'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
                    'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                    'JOIN "DeckHouses" dh ON dh."DeckId" = d."Id" ' +
                    'JOIN "Houses" h ON h."Id" = dh."HouseId" ' +
                    'WHERE g."FinishedAt" IS NOT NULL AND g."WinnerId" IS NOT NULL ' +
                    'GROUP BY h."Name"'
            ),
            // Format distribution (one row per game, so count Games directly).
            this.db.query(
                'SELECT "GameFormat" AS "format", COUNT(*) AS "games" ' +
                    'FROM "Games" WHERE "FinishedAt" IS NOT NULL ' +
                    'GROUP BY "GameFormat" ORDER BY COUNT(*) DESC'
            ),
            // Win rate by deck-power band (joined to DeckSas via deck Uuid).
            this.db.query(
                'SELECT ' +
                    sasBandCaseSql('ds."SasRating"') +
                    ' AS "band", COUNT(*) AS "games", ' +
                    'COUNT(*) FILTER (WHERE gp."PlayerId" = g."WinnerId") AS "wins" ' +
                    'FROM "Games" g ' +
                    'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
                    'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                    'JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                    'WHERE g."FinishedAt" IS NOT NULL AND g."WinnerId" IS NOT NULL ' +
                    'AND ds."SasRating" IS NOT NULL ' +
                    'GROUP BY "band"'
            )
        ]);

        const totals = (totalsRows && totalsRows[0]) || {};
        const formatTotal = (formatRows || []).reduce(
            (sum, row) => sum + (Number(row.games) || 0),
            0
        );

        return {
            generatedAt: new Date(this.now()).toISOString(),
            totals: {
                finishedGames: Number(totals.finishedGames) || 0,
                decidedGames: Number(totals.decidedGames) || 0,
                avgDurationSec: roundInt(totals.avgDurationSec),
                avgKeys: round2(totals.avgKeys)
            },
            // Sorted strongest-first for the horizontal bar chart.
            houses: (houseRows || [])
                .map((row) => ({
                    house: row.house,
                    games: Number(row.games) || 0,
                    wins: Number(row.wins) || 0,
                    winRate: winRate(row.wins, row.games)
                }))
                .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1)),
            formats: (formatRows || []).map((row) => {
                const games = Number(row.games) || 0;

                return {
                    format: row.format || 'unknown',
                    games,
                    share: formatTotal ? Math.round((games / formatTotal) * 1000) / 10 : null
                };
            }),
            // Kept in ascending band order for a readable left-to-right ramp.
            sasBands: (sasRows || [])
                .map((row) => ({
                    band: row.band,
                    games: Number(row.games) || 0,
                    wins: Number(row.wins) || 0,
                    winRate: winRate(row.wins, row.games)
                }))
                .sort((a, b) => BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band))
        };
    }

    /**
     * Per-player breakdown by username (case-insensitive). Cached per player.
     * Returns null when the username does not exist.
     */
    async getPlayerStats(username) {
        if (!username) {
            return null;
        }

        return this.cached(`player:${String(username).toLowerCase()}`, () =>
            this.computePlayerStats(username)
        );
    }

    async computePlayerStats(username) {
        const userRows = await this.db.query(
            'SELECT "Id", "Username" FROM "Users" WHERE lower("Username") = lower($1)',
            [username]
        );

        const user = userRows && userRows[0];

        if (!user) {
            return null;
        }

        const userId = user.Id;

        const [overallRows, formatRows, houseRows] = await Promise.all([
            this.db.query(
                'SELECT COUNT(*) AS "games", ' +
                    'COUNT(*) FILTER (WHERE g."WinnerId" = $1) AS "wins", ' +
                    'AVG(gp."Keys") AS "avgKeys", ' +
                    'AVG(EXTRACT(EPOCH FROM (g."FinishedAt" - g."StartedAt"))) ' +
                    'FILTER (WHERE g."StartedAt" IS NOT NULL AND g."FinishedAt" > g."StartedAt") ' +
                    'AS "avgDurationSec" ' +
                    'FROM "Games" g ' +
                    'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" AND gp."PlayerId" = $1 ' +
                    'WHERE g."FinishedAt" IS NOT NULL AND g."WinnerId" IS NOT NULL',
                [userId]
            ),
            this.db.query(
                'SELECT g."GameFormat" AS "format", COUNT(*) AS "games", ' +
                    'COUNT(*) FILTER (WHERE g."WinnerId" = $1) AS "wins" ' +
                    'FROM "Games" g ' +
                    'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" AND gp."PlayerId" = $1 ' +
                    'WHERE g."FinishedAt" IS NOT NULL AND g."WinnerId" IS NOT NULL ' +
                    'GROUP BY g."GameFormat"',
                [userId]
            ),
            this.db.query(
                'SELECT h."Name" AS "house", COUNT(*) AS "games", ' +
                    'COUNT(*) FILTER (WHERE g."WinnerId" = $1) AS "wins" ' +
                    'FROM "Games" g ' +
                    'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" AND gp."PlayerId" = $1 ' +
                    'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                    'JOIN "DeckHouses" dh ON dh."DeckId" = d."Id" ' +
                    'JOIN "Houses" h ON h."Id" = dh."HouseId" ' +
                    'WHERE g."FinishedAt" IS NOT NULL AND g."WinnerId" IS NOT NULL ' +
                    'GROUP BY h."Name"',
                [userId]
            )
        ]);

        const overall = (overallRows && overallRows[0]) || {};
        const games = Number(overall.games) || 0;
        const wins = Number(overall.wins) || 0;

        return {
            username: user.Username,
            overall: {
                games,
                wins,
                losses: Math.max(0, games - wins),
                winRate: winRate(wins, games),
                avgKeys: round2(overall.avgKeys),
                avgDurationSec: roundInt(overall.avgDurationSec)
            },
            formats: (formatRows || [])
                .map((row) => {
                    const g = Number(row.games) || 0;
                    const w = Number(row.wins) || 0;

                    return {
                        format: row.format || 'unknown',
                        games: g,
                        wins: w,
                        losses: Math.max(0, g - w),
                        winRate: winRate(w, g)
                    };
                })
                .sort((a, b) => b.games - a.games),
            houses: (houseRows || [])
                .map((row) => {
                    const g = Number(row.games) || 0;
                    const w = Number(row.wins) || 0;

                    return { house: row.house, games: g, wins: w, winRate: winRate(w, g) };
                })
                .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1))
        };
    }
}

module.exports = StatisticsService;
module.exports.winRate = winRate;
module.exports.sasBandLabel = sasBandLabel;
module.exports.sasBandCaseSql = sasBandCaseSql;
module.exports.SAS_BANDS = SAS_BANDS;
