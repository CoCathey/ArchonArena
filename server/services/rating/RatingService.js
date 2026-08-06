const logger = require('../../log');
const { calculateGameResult, normalizeConfig } = require('./EloCalculator');
const { isValidCountry, regionForCountry, countriesInRegion } = require('./regions');

const DEFAULT_RATING_CONFIG = {
    enabled: true,
    // Win reasons that never rate (a rematch overwrites the winner record).
    excludedWinReasons: ['rematch'],
    // Rated games required to appear on leaderboards.
    leaderboardMinGames: 5,
    // ARCHON (N4): only show players active within this many days (0 = show
    // everyone, which is the default - a young ladder that hid its inactive
    // players would look emptier than it is).
    leaderboardActivityDays: 0,
    // Maximum rows a single leaderboard request may return.
    leaderboardMaxLimit: 100,
    // Overrides for the Elo calculator (see eloDefaults.js).
    elo: {},
    // Inactive-player rating decay (off by default). autoApplyHours drives the
    // lobby's automatic decay sweep (0 = manual only).
    decay: { enabled: false, graceDays: 30, pointsPerWeek: 20, floor: 1200, autoApplyHours: 24 },
    // Season soft-reset policy, applied when an admin starts a new season.
    season: { carryFactor: 0.5, baseline: 1200 }
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Pure rating-decay calculation for one rating row. Returns the new rating and
 * the instant decay has now been applied through (so it is idempotent and
 * never re-decays the same span), or null when nothing decays.
 *
 * Decay only bites after `graceDays` of inactivity (since UpdatedAt), then
 * removes `pointsPerWeek` for each further whole week, never below `floor`.
 */
function computeDecay(ratingBefore, updatedAtMs, lastDecayAtMs, nowMs, decayConfig) {
    if (!decayConfig || !decayConfig.enabled) {
        return null;
    }

    const graceMs = Math.max(0, decayConfig.graceDays ?? 30) * DAY_MS;

    if (nowMs - updatedAtMs <= graceMs) {
        return null; // still within the activity grace window
    }

    // Resume from the later of "grace expired" and "already decayed through",
    // so a game played since the last decay correctly restarts the clock.
    const from = Math.max(lastDecayAtMs || 0, updatedAtMs + graceMs);
    const periods = Math.floor((nowMs - from) / WEEK_MS);

    if (periods < 1) {
        return null;
    }

    const floor = decayConfig.floor ?? 1200;
    const pointsPerWeek = Math.max(0, decayConfig.pointsPerWeek ?? 20);
    const newRating = Math.max(floor, ratingBefore - periods * pointsPerWeek);

    return { newRating, decayThroughMs: from + periods * WEEK_MS };
}

/**
 * Pure season soft-reset: regress a rating toward the baseline, keeping
 * `carryFactor` of the distance from it (0 = full reset to baseline, 1 = no
 * change), never below `floor`.
 */
function computeSeasonReset(ratingBefore, baseline, carryFactor, floor) {
    const carry = Math.min(1, Math.max(0, carryFactor));
    const reset = Math.round(baseline + (ratingBefore - baseline) * carry);

    return Math.max(floor, reset);
}

// Map a game format (Games.GameFormat) onto a rating pool. The client only
// surfaces three pools on the leaderboards/ratings pages - 'archon', 'sealed'
// and 'alliance' - so every constructed variant folds into the main 'archon'
// ladder. Without this, standard games (format 'normal') would rate into a
// 'normal' pool that no UI reads, leaving the leaderboards permanently empty.
const POOL_BY_FORMAT = {
    normal: 'archon',
    reversal: 'archon',
    'adaptive-bo1': 'archon',
    unchained: 'archon',
    archon: 'archon',
    sealed: 'sealed',
    alliance: 'alliance'
};

/**
 * ARCHON: the only pools that exist, derived from the mapping above rather than
 * written out again, so adding a format cannot silently invent a pool.
 *
 * Enforced on the admin write paths, which previously stored whatever string
 * the caller sent. A "normal" pool already exists in older databases because
 * the rating code used to store the raw game format (migration 50 folds those
 * back in); an unvalidated admin endpoint would let one straight back, giving a
 * player a second Amber rating that no game can ever add to.
 */
const RATING_POOLS = [...new Set(Object.values(POOL_BY_FORMAT))];

/**
 * Orchestrates rating updates from finished games.
 *
 * Triggered from the lobby layer after GameService.update() persists a
 * GAMEWIN — never from inside the gameplay engine. Everything is
 * best-effort and idempotent: a duplicate GAMEWIN, a rematch overwrite,
 * or a crash mid-way can never double-rate a game (unique (GameId,
 * UserId) constraint + pre-check), and a failure here never affects the
 * game flow itself.
 */
class RatingService {
    constructor(configService, db = require('../../db'), settingsService = require('../settings')) {
        this.configService = configService;
        this.db = db;
        this.settingsService = settingsService;
    }

    /**
     * Normalize a game format into the rating pool the UI reads. Unknown or
     * missing formats fall back to the main 'archon' pool.
     */
    normalizePool(gameFormat) {
        if (!gameFormat) {
            return 'archon';
        }

        return POOL_BY_FORMAT[gameFormat] || 'archon';
    }

    getConfig() {
        const fileConfig = this.configService.getValue('rating') || {};
        // Runtime admin overrides (SiteSettings) win over file config,
        // which wins over code defaults.
        const adminConfig = this.settingsService.getSection('rating');

        return {
            ...DEFAULT_RATING_CONFIG,
            ...fileConfig,
            ...adminConfig,
            elo: {
                ...DEFAULT_RATING_CONFIG.elo,
                ...(fileConfig.elo || {}),
                ...(adminConfig.elo || {})
            },
            decay: {
                ...DEFAULT_RATING_CONFIG.decay,
                ...(fileConfig.decay || {}),
                ...(adminConfig.decay || {})
            },
            season: {
                ...DEFAULT_RATING_CONFIG.season,
                ...(fileConfig.season || {}),
                ...(adminConfig.season || {})
            }
        };
    }

    /**
     * Map an engine win reason onto a calculator result type.
     * 'keys' forged normally; 'concede'; everything time-related
     * ('clock', '... after time') counts as timeout.
     */
    resultTypeFromWinReason(winReason) {
        if (!winReason || winReason === 'keys') {
            return 'keys';
        }

        if (winReason === 'concede') {
            return 'concede';
        }

        if (winReason === 'clock' || winReason.includes('after time')) {
            return 'timeout';
        }

        return 'keys';
    }

    /**
     * Rate a finished game by its external game id (Games.GameId).
     * Safe to call for any game — quietly skips everything unratable.
     */
    async processGame(gameUuid) {
        try {
            await this.processGameInner(gameUuid);
        } catch (err) {
            logger.error(`Failed to process ratings for game ${gameUuid}`, err);
        }
    }

    async processGameInner(gameUuid) {
        const config = this.getConfig();

        if (!config.enabled) {
            return;
        }

        const rows = await this.db.query(
            'SELECT g."Id" AS "GameDbId", g."GameFormat", g."WinnerId", g."WinReason", ' +
                'gp."PlayerId", gp."Keys", d."Uuid" AS "DeckUuid", ds."SasRating" ' +
                'FROM "Games" g ' +
                'JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
                'LEFT JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                'WHERE g."GameId" = $1',
            [gameUuid]
        );

        if (!rows || rows.length !== 2) {
            return; // solo games, aborted setups, >2p variants: never rated
        }

        const game = rows[0];

        if (!game.WinnerId) {
            return;
        }

        if (config.excludedWinReasons.includes(game.WinReason)) {
            return;
        }

        const winnerRow = rows.find((row) => row.PlayerId === game.WinnerId);
        const loserRow = rows.find((row) => row.PlayerId !== game.WinnerId);

        if (!winnerRow || !loserRow || winnerRow.PlayerId === loserRow.PlayerId) {
            return;
        }

        const alreadyRated = await this.db.query(
            'SELECT 1 FROM "RatingHistory" WHERE "GameId" = $1 LIMIT 1',
            [game.GameDbId]
        );
        if (alreadyRated && alreadyRated.length > 0) {
            return;
        }

        // ARCHON: tournament games only move Amber when their event is
        // marked rated - and then with the tournament K multiplier.
        const tournamentRows = await this.db.query(
            'SELECT t."RatedGames" FROM "TournamentMatchGames" tmg ' +
                'JOIN "Tournaments" t ON t."Id" = tmg."TournamentId" ' +
                'WHERE tmg."GameUuid" = $1 LIMIT 1',
            [gameUuid]
        );
        const tournamentRow = tournamentRows && tournamentRows[0];

        if (tournamentRow && !tournamentRow.RatedGames) {
            return; // unrated event: games never touch the ladder
        }

        const isTournament = !!tournamentRow;

        const pool = this.normalizePool(game.GameFormat);
        const eloConfig = normalizeConfig(config.elo);

        const [winnerRating, loserRating] = await Promise.all([
            this.getOrDefaultRating(winnerRow.PlayerId, pool, eloConfig),
            this.getOrDefaultRating(loserRow.PlayerId, pool, eloConfig)
        ]);

        const resultType = this.resultTypeFromWinReason(game.WinReason);
        const result = calculateGameResult(
            {
                winner: {
                    rating: winnerRating.rating,
                    gamesPlayed: winnerRating.gamesPlayed,
                    deckSas: winnerRow.SasRating
                },
                loser: {
                    rating: loserRating.rating,
                    gamesPlayed: loserRating.gamesPlayed,
                    deckSas: loserRow.SasRating
                },
                winnerKeys: winnerRow.Keys || 0,
                loserKeys: loserRow.Keys || 0,
                resultType: resultType,
                // Tournament games get a K bonus (tournamentKMultiplier)
                isTournament: isTournament
            },
            config.elo
        );

        const keyDiff = (winnerRow.Keys || 0) - (loserRow.Keys || 0);
        const configSnapshot = JSON.stringify(eloConfig);

        const client = await this.db.startTransaction();
        try {
            // Insert the winner's history row FIRST and use it as the gate. The
            // unique (GameId, UserId) constraint means a duplicate/concurrent
            // processing of the same game inserts nothing here (empty result),
            // so we roll back before touching Ratings. This is what actually
            // makes rating idempotent under concurrent GAMEWIN delivery (Redis
            // pub/sub fans a GAMEWIN out to every lobby instance); the earlier
            // pre-check alone was check-then-act and could double-apply.
            const gate = await this.insertHistory(client, {
                gameDbId: game.GameDbId,
                userId: winnerRow.PlayerId,
                opponentId: loserRow.PlayerId,
                pool: pool,
                won: true,
                before: winnerRating.rating,
                after: result.winner.newRating,
                expected: result.winner.expected,
                ownSas: winnerRow.SasRating,
                opponentSas: loserRow.SasRating,
                keyDiff: keyDiff,
                resultType: resultType,
                configSnapshot: configSnapshot
            });

            if (!gate || gate.length === 0) {
                // Already rated by another run - do not touch Ratings.
                await this.db.queryTran(client, 'ROLLBACK');
                return;
            }

            await this.insertHistory(client, {
                gameDbId: game.GameDbId,
                userId: loserRow.PlayerId,
                opponentId: winnerRow.PlayerId,
                pool: pool,
                won: false,
                before: loserRating.rating,
                after: result.loser.newRating,
                expected: result.loser.expected,
                ownSas: loserRow.SasRating,
                opponentSas: winnerRow.SasRating,
                keyDiff: keyDiff,
                resultType: resultType,
                configSnapshot: configSnapshot
            });

            await this.upsertRating(
                client,
                winnerRow.PlayerId,
                pool,
                result.winner.newRating,
                winnerRating.gamesPlayed + 1
            );
            await this.upsertRating(
                client,
                loserRow.PlayerId,
                pool,
                result.loser.newRating,
                loserRating.gamesPlayed + 1
            );

            await this.db.queryTran(client, 'COMMIT');
            logger.info(
                `Rated game ${gameUuid} (${pool}): winner ${winnerRow.PlayerId} ` +
                    `${winnerRating.rating}->${result.winner.newRating}, ` +
                    `loser ${loserRow.PlayerId} ${loserRating.rating}->${result.loser.newRating}`
            );
        } catch (err) {
            await this.db.queryTran(client, 'ROLLBACK');
            throw err;
        } finally {
            if (client.release) {
                client.release();
            }
        }
    }

    async getOrDefaultRating(userId, pool, eloConfig) {
        const rows = await this.db.query(
            'SELECT "Rating", "GamesPlayed" FROM "Ratings" WHERE "UserId" = $1 AND "Pool" = $2',
            [userId, pool]
        );

        if (rows && rows.length > 0) {
            return { rating: rows[0].Rating, gamesPlayed: rows[0].GamesPlayed };
        }

        return { rating: eloConfig.defaultRating, gamesPlayed: 0 };
    }

    async upsertRating(client, userId, pool, rating, gamesPlayed) {
        await this.db.queryTran(
            client,
            'INSERT INTO "Ratings" ("UserId", "Pool", "Rating", "GamesPlayed", "UpdatedAt") ' +
                "VALUES ($1, $2, $3, $4, now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("UserId", "Pool") DO UPDATE SET "Rating" = $3, "GamesPlayed" = $4, ' +
                '"UpdatedAt" = now() AT TIME ZONE \'utc\'',
            [userId, pool, rating, gamesPlayed]
        );
    }

    /**
     * Insert one RatingHistory row. Returns the inserted rows (RETURNING) so
     * the caller can use the unique (GameId, UserId) constraint as an
     * idempotency gate: an empty result means this game/user was already
     * rated and nothing was written.
     */
    async insertHistory(client, entry) {
        return await this.db.queryTran(
            client,
            'INSERT INTO "RatingHistory" ("GameId", "UserId", "OpponentId", "Pool", "Won", ' +
                '"RatingBefore", "RatingAfter", "Expected", "OwnSas", "OpponentSas", "KeyDiff", ' +
                '"ResultType", "ConfigSnapshot", "CreatedAt") ' +
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("GameId", "UserId") DO NOTHING RETURNING "Id"',
            [
                entry.gameDbId,
                entry.userId,
                entry.opponentId,
                entry.pool,
                entry.won,
                entry.before,
                entry.after,
                entry.expected,
                entry.ownSas,
                entry.opponentSas,
                entry.keyDiff,
                entry.resultType,
                entry.configSnapshot
            ]
        );
    }

    async findUserIdByUsername(username) {
        const rows = await this.db.query(
            'SELECT "Id" FROM "Users" WHERE lower("Username") = lower($1)',
            [username]
        );

        return rows && rows[0] ? rows[0].Id : null;
    }

    /**
     * ARCHON admin tool: set a player's rating (and optionally games played)
     * in one pool directly. RatingHistory is left untouched as an audit
     * trail of how the rating actually evolved through games.
     */
    async adminSetRating(username, pool, rating, gamesPlayed) {
        if (!RATING_POOLS.includes(pool || 'archon')) {
            return {
                success: false,
                message: `Unknown pool "${pool}". Valid pools: ${RATING_POOLS.join(', ')}.`
            };
        }

        const userId = await this.findUserIdByUsername(username);

        if (!userId) {
            return { success: false, message: 'No such player' };
        }

        const numericRating = parseInt(rating, 10);
        if (!Number.isFinite(numericRating) || numericRating < 0 || numericRating > 5000) {
            return { success: false, message: 'Rating must be between 0 and 5000' };
        }

        const games =
            gamesPlayed === undefined || gamesPlayed === null ? null : parseInt(gamesPlayed, 10);
        if (games !== null && (!Number.isFinite(games) || games < 0 || games > 100000)) {
            return { success: false, message: 'Games played must be 0 or more' };
        }

        await this.db.query(
            'INSERT INTO "Ratings" ("UserId", "Pool", "Rating", "GamesPlayed", "UpdatedAt") ' +
                "VALUES ($1, $2, $3, COALESCE($4, 0), now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("UserId", "Pool") DO UPDATE SET "Rating" = $3, ' +
                '"GamesPlayed" = COALESCE($4, "Ratings"."GamesPlayed"), ' +
                '"UpdatedAt" = now() AT TIME ZONE \'utc\'',
            [userId, pool || 'archon', numericRating, games]
        );

        return { success: true };
    }

    /**
     * ARCHON admin tool: reset a player's rating in one pool (or all pools)
     * so they re-enter at the default as a fresh provisional player.
     * RatingHistory stays for auditability.
     */
    async adminResetRatings(username, pool) {
        if (pool && !RATING_POOLS.includes(pool)) {
            return {
                success: false,
                message: `Unknown pool "${pool}". Valid pools: ${RATING_POOLS.join(', ')}.`
            };
        }

        const userId = await this.findUserIdByUsername(username);

        if (!userId) {
            return { success: false, message: 'No such player' };
        }

        if (pool) {
            await this.db.query('DELETE FROM "Ratings" WHERE "UserId" = $1 AND "Pool" = $2', [
                userId,
                pool
            ]);
        } else {
            await this.db.query('DELETE FROM "Ratings" WHERE "UserId" = $1', [userId]);
        }

        return { success: true };
    }

    /**
     * Apply inactive-player rating decay across all pools. Idempotent: each row
     * records how far decay has been applied (LastDecayAt), so re-running only
     * decays newly-elapsed weeks. Safe to call on a schedule or from admin.
     */
    async applyDecay(nowMs) {
        const config = this.getConfig();
        const decayConfig = config.decay || {};

        if (!decayConfig.enabled) {
            return { decayed: 0, scanned: 0 };
        }

        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
        // Epochs are pulled straight from the (UTC) stored timestamps so the
        // decay math never depends on the server's local timezone.
        const rows = await this.db.query(
            'SELECT "UserId", "Pool", "Rating", ' +
                'EXTRACT(EPOCH FROM "UpdatedAt") AS "UpdatedEpoch", ' +
                'EXTRACT(EPOCH FROM "LastDecayAt") AS "DecayEpoch" FROM "Ratings"'
        );

        let decayed = 0;
        for (const row of rows || []) {
            const result = computeDecay(
                row.Rating,
                Number(row.UpdatedEpoch) * 1000,
                row.DecayEpoch != null ? Number(row.DecayEpoch) * 1000 : null,
                now,
                decayConfig
            );

            if (!result) {
                continue;
            }

            await this.db.query(
                'UPDATE "Ratings" SET "Rating" = $1, ' +
                    '"LastDecayAt" = to_timestamp($2) AT TIME ZONE \'utc\' ' +
                    'WHERE "UserId" = $3 AND "Pool" = $4',
                [result.newRating, result.decayThroughMs / 1000, row.UserId, row.Pool]
            );

            if (result.newRating < row.Rating) {
                decayed++;
            }
        }

        return { decayed, scanned: (rows || []).length };
    }

    /**
     * Start a new season: archive the outgoing season's final ladder, then
     * soft-reset every rating toward the baseline and record the new season.
     * Returns the new season number and how many ratings moved. The per-game
     * RatingHistory audit is left untouched.
     *
     * ARCHON (N4): the archive step is new. A season used to end by silently
     * overwriting every rating, so the ladder that just finished ceased to
     * exist - no final standings, no record of where anyone placed, and no way
     * to tell a player what the reset cost them. Each archived row carries both
     * halves of the transition (where they finished, what they carried
     * forward), which is also what the recalculation tool replays from.
     */
    async startNewSeason() {
        const config = this.getConfig();
        const seasonConfig = config.season || {};
        const eloConfig = normalizeConfig(config.elo);
        const baseline = seasonConfig.baseline ?? eloConfig.defaultRating;
        const floor = eloConfig.ratingFloor;
        const carry = seasonConfig.carryFactor ?? 0.5;

        const outgoing = await this.getCurrentSeason();
        // Ordered so the archived rank can be assigned per pool in one pass.
        const rows = await this.db.query(
            'SELECT r."UserId", r."Pool", r."Rating", r."GamesPlayed" FROM "Ratings" r ' +
                'JOIN "Users" u ON u."Id" = r."UserId" ' +
                'ORDER BY r."Pool", r."Rating" DESC, r."GamesPlayed" DESC, u."Username"'
        );

        // Rank only the players the leaderboards would have shown, so an
        // archived "#3 of season 2" means the same thing the board did.
        const rankByPool = {};
        const archive = [];
        let adjusted = 0;

        for (const row of rows || []) {
            const newRating = computeSeasonReset(row.Rating, baseline, carry, floor);

            if (newRating !== row.Rating) {
                adjusted++;
            }

            let rank = null;
            if (row.GamesPlayed >= config.leaderboardMinGames) {
                rankByPool[row.Pool] = (rankByPool[row.Pool] || 0) + 1;
                rank = rankByPool[row.Pool];
            }

            archive.push({
                userId: row.UserId,
                pool: row.Pool,
                rank,
                rating: row.Rating,
                gamesPlayed: row.GamesPlayed,
                ratingAfterReset: newRating
            });
        }

        const client = await this.db.startTransaction();

        try {
            // Archiving and resetting must land together: standings that
            // recorded a season nobody was reset out of - or a reset with no
            // record of what came before it - would both be worse than either.
            // Guarded on startedAt, NOT on the season number: getCurrentSeason()
            // reports season 1 for a site that has never started one, and there
            // is no Seasons row behind that number - archiving against it would
            // violate the foreign key.
            if (outgoing.startedAt && archive.length > 0) {
                for (const entry of archive) {
                    await this.db.queryTran(
                        client,
                        'INSERT INTO "SeasonStandings" ' +
                            '("SeasonId", "UserId", "Pool", "Rank", "Rating", "GamesPlayed", ' +
                            '"RatingAfterReset", "CreatedAt") ' +
                            "VALUES ($1, $2, $3, $4, $5, $6, $7, now() AT TIME ZONE 'utc') " +
                            'ON CONFLICT ("SeasonId", "UserId", "Pool") DO NOTHING',
                        [
                            outgoing.number,
                            entry.userId,
                            entry.pool,
                            entry.rank,
                            entry.rating,
                            entry.gamesPlayed,
                            entry.ratingAfterReset
                        ]
                    );
                }
            }

            for (const entry of archive) {
                await this.db.queryTran(
                    client,
                    'UPDATE "Ratings" SET "Rating" = $1, "LastDecayAt" = NULL ' +
                        'WHERE "UserId" = $2 AND "Pool" = $3',
                    [entry.ratingAfterReset, entry.userId, entry.pool]
                );
            }

            // Close the outgoing season only if it was ever actually recorded.
            // getCurrentSeason() reports season 1 for a site that has never
            // started one, and there is no row to stamp in that case.
            if (outgoing.startedAt) {
                await this.db.queryTran(
                    client,
                    'UPDATE "Seasons" SET "EndedAt" = now() AT TIME ZONE \'utc\' ' +
                        'WHERE "Id" = $1 AND "EndedAt" IS NULL',
                    [outgoing.number]
                );
            }

            const inserted = await this.db.queryTran(
                client,
                'INSERT INTO "Seasons" ("StartedAt") VALUES (now() AT TIME ZONE \'utc\') ' +
                    'RETURNING "Id", "StartedAt"'
            );
            const season = inserted && inserted[0] ? inserted[0] : null;

            await this.db.queryTran(client, 'COMMIT');

            return {
                success: true,
                season: season ? season.Id : null,
                startedAt: season ? season.StartedAt : null,
                adjusted,
                archived: outgoing.startedAt ? archive.length : 0
            };
        } catch (err) {
            await this.db.queryTran(client, 'ROLLBACK');
            logger.error('Failed to start a new season', err);

            return { success: false, message: 'Failed to start a new season' };
        } finally {
            // Matches processGameInner: the pool client must go back whether
            // the transaction committed or rolled back, and tests inject a db
            // whose client has no release().
            if (client.release) {
                client.release();
            }
        }
    }

    /**
     * ARCHON (N4): SQL fragment restricting a Ratings row to players active
     * within the configured window, or '' when the window is off.
     *
     * Built once here and used by every place that counts the ranked field, so
     * the leaderboard rows, the rank number on a player's own Ratings page and
     * the "of M" field size can never diverge. The interval is interpolated
     * rather than bound because it is a validated integer from the settings
     * registry (1..3650) and PostgreSQL will not take a parameter inside an
     * interval literal without a cast dance that obscures the query.
     *
     * @param {object} config effective rating config
     * @param {string} alias  the Ratings table alias in the caller's query
     */
    activityWindowSql(config, alias) {
        const days = Math.floor(Number(config.leaderboardActivityDays) || 0);

        if (!Number.isFinite(days) || days <= 0) {
            return '';
        }

        return `${alias}."UpdatedAt" >= (now() AT TIME ZONE 'utc') - interval '${days} days'`;
    }

    /**
     * ARCHON (N4): every season with its dates and how many players it ranked.
     * Newest first; the current (unfinished) season is included and flagged.
     */
    async getSeasons() {
        const rows = await this.db.query(
            'SELECT s."Id", s."StartedAt", s."EndedAt", ' +
                '(SELECT COUNT(*) FROM "SeasonStandings" ss ' +
                'WHERE ss."SeasonId" = s."Id" AND ss."Rank" IS NOT NULL) AS "ranked" ' +
                'FROM "Seasons" s ORDER BY s."Id" DESC'
        );

        return (rows || []).map((row) => ({
            number: row.Id,
            startedAt: row.StartedAt,
            endedAt: row.EndedAt,
            rankedPlayers: Number(row.ranked) || 0,
            current: !row.EndedAt
        }));
    }

    /**
     * ARCHON (N4): the archived final ladder for one finished season.
     *
     * Reads the standings recorded when the season ended rather than
     * recomputing from today's ratings - the whole point is that it is a
     * snapshot of a ladder that no longer exists.
     */
    async getSeasonStandings(seasonId, options = {}) {
        const season = parseInt(seasonId, 10);

        if (!Number.isFinite(season)) {
            return null;
        }

        const config = this.getConfig();
        const pool = this.normalizePool(options.pool);
        const limit = Math.min(
            Math.max(1, parseInt(options.limit, 10) || 50),
            config.leaderboardMaxLimit
        );
        const offset = Math.max(0, parseInt(options.offset, 10) || 0);

        const rows = await this.db.query(
            'SELECT ss."Rank", ss."Rating", ss."GamesPlayed", ss."RatingAfterReset", ' +
                'u."Username", u."Country", u."State", u."Settings_Avatar" ' +
                'FROM "SeasonStandings" ss JOIN "Users" u ON u."Id" = ss."UserId" ' +
                'WHERE ss."SeasonId" = $1 AND ss."Pool" = $2 AND ss."Rank" IS NOT NULL ' +
                'AND u."Disabled" IS NOT TRUE ' +
                'ORDER BY ss."Rank" LIMIT $3 OFFSET $4',
            [season, pool, limit, offset]
        );

        return {
            season,
            pool,
            entries: (rows || []).map((row) => ({
                rank: row.Rank,
                username: row.Username,
                country: row.Country,
                state: row.State,
                avatar: row.Settings_Avatar,
                rating: row.Rating,
                gamesPlayed: row.GamesPlayed,
                // What the soft reset carried into the next season.
                ratingAfterReset: row.RatingAfterReset,
                resetDelta: row.RatingAfterReset - row.Rating
            }))
        };
    }

    /**
     * ARCHON (N4): one player's season history - where they finished each
     * season and what the reset did to them. Backs both the end-of-season
     * summary on the Ratings page and the finish badges on public profiles.
     */
    async getSeasonHistoryForUsername(username) {
        if (!username) {
            return [];
        }

        const rows = await this.db.query(
            'SELECT ss."SeasonId", ss."Pool", ss."Rank", ss."Rating", ss."GamesPlayed", ' +
                'ss."RatingAfterReset", s."StartedAt", s."EndedAt" ' +
                'FROM "SeasonStandings" ss ' +
                'JOIN "Users" u ON u."Id" = ss."UserId" ' +
                'JOIN "Seasons" s ON s."Id" = ss."SeasonId" ' +
                'WHERE lower(u."Username") = lower($1) ' +
                'ORDER BY ss."SeasonId" DESC, ss."Pool"',
            [username]
        );

        return (rows || []).map((row) => ({
            season: row.SeasonId,
            pool: row.Pool,
            rank: row.Rank,
            rating: row.Rating,
            gamesPlayed: row.GamesPlayed,
            ratingAfterReset: row.RatingAfterReset,
            // Negative: the soft reset took this much off.
            resetDelta: row.RatingAfterReset - row.Rating,
            startedAt: row.StartedAt,
            endedAt: row.EndedAt
        }));
    }

    /**
     * ARCHON (N4): recalculate the ladder by replaying RatingHistory under a
     * different Elo configuration.
     *
     * Tuning the Elo config only ever affected games played *after* the change,
     * so a config that turned out wrong stayed baked into the ladder forever.
     * This replays the recorded results and rebuilds the standings.
     *
     * **Dry run by default.** Nothing is written unless `commit` is explicitly
     * true; the report it returns is the thing to look at first, because this
     * rewrites the competitive standing of every player on the site.
     *
     * Two things shape the replay:
     *
     *  - **It starts at the current season, not at the beginning of time.** A
     *    season soft-reset moves ratings without writing RatingHistory, so a
     *    replay from zero would silently undo every reset ever applied and hand
     *    players back Amber that a season deliberately took away. Seeds come
     *    from the archived standings (`RatingAfterReset`); a site that has
     *    never run a season replays from the default rating, which is the same
     *    thing.
     *  - **It does not replay decay.** Decay is a function of inactivity rather
     *    than of games, and is not in RatingHistory either. Committing clears
     *    `LastDecayAt` so the next decay sweep re-derives it from the rebuilt
     *    ratings rather than from a stale high-water mark.
     *
     * @param {object} [options]
     * @param {object} [options.elo]    Elo overrides to replay under; defaults
     *                                  to the live configuration, which makes
     *                                  the run a no-op consistency check.
     * @param {boolean} [options.commit] write the result (default false)
     * @param {number} [options.reportLimit] how many movers to list
     */
    async recalculateRatings(options = {}) {
        const config = this.getConfig();
        const commit = options.commit === true;
        const reportLimit = Math.min(Math.max(1, parseInt(options.reportLimit, 10) || 25), 200);

        let eloConfig;

        try {
            // normalizeConfig validates; a bad override must fail here, before
            // anything is replayed, not halfway through a rewrite.
            eloConfig = normalizeConfig(options.elo ?? config.elo);
        } catch (err) {
            return { success: false, message: `Invalid Elo configuration: ${err.message}` };
        }

        const seeds = await this.getRecalculationSeeds();
        const games = await this.getReplayableHistory(seeds.sinceStartedAt);

        // userId|pool -> { rating, gamesPlayed }
        const state = new Map();
        const keyFor = (userId, pool) => `${userId}|${pool}`;
        const stateFor = (userId, pool) => {
            const key = keyFor(userId, pool);

            if (!state.has(key)) {
                state.set(key, {
                    userId,
                    pool,
                    rating: seeds.byKey.get(key)?.rating ?? eloConfig.defaultRating,
                    gamesPlayed: seeds.byKey.get(key)?.gamesPlayed ?? 0
                });
            }

            return state.get(key);
        };

        for (const game of games) {
            const winner = stateFor(game.winnerId, game.pool);
            const loser = stateFor(game.loserId, game.pool);

            const result = calculateGameResult(
                {
                    winner: {
                        rating: winner.rating,
                        gamesPlayed: winner.gamesPlayed,
                        deckSas: game.winnerSas
                    },
                    loser: {
                        rating: loser.rating,
                        gamesPlayed: loser.gamesPlayed,
                        deckSas: game.loserSas
                    },
                    // movMultiplier only reads the difference, and the stored
                    // KeyDiff is exactly that - the raw key counts are not in
                    // RatingHistory and are not needed.
                    winnerKeys: game.keyDiff,
                    loserKeys: 0,
                    resultType: game.resultType,
                    isTournament: game.isTournament
                },
                eloConfig
            );

            winner.rating = result.winner.newRating;
            winner.gamesPlayed += 1;
            loser.rating = result.loser.newRating;
            loser.gamesPlayed += 1;
        }

        // Compare against what the ladder currently says.
        const currentRows = await this.db.query(
            'SELECT r."UserId", r."Pool", r."Rating", r."GamesPlayed", u."Username" ' +
                'FROM "Ratings" r JOIN "Users" u ON u."Id" = r."UserId"'
        );

        const changes = [];
        let unchanged = 0;

        for (const row of currentRows || []) {
            const replayed = state.get(keyFor(row.UserId, row.Pool));

            // A rating with no replayed games keeps whatever it has: it was
            // seeded by a season reset or set by an admin, and inventing a
            // value for it would be a change this tool never made.
            if (!replayed) {
                unchanged++;
                continue;
            }

            if (replayed.rating === row.Rating) {
                unchanged++;
                continue;
            }

            changes.push({
                userId: row.UserId,
                username: row.Username,
                pool: row.Pool,
                before: row.Rating,
                after: replayed.rating,
                delta: replayed.rating - row.Rating
            });
        }

        changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

        const report = {
            success: true,
            committed: false,
            dryRun: !commit,
            gamesReplayed: games.length,
            ratingsCompared: (currentRows || []).length,
            changed: changes.length,
            unchanged,
            seededFromSeason: seeds.season,
            largestGain: changes.find((entry) => entry.delta > 0) || null,
            largestLoss: changes.find((entry) => entry.delta < 0) || null,
            movers: changes.slice(0, reportLimit)
        };

        if (!commit) {
            return report;
        }

        const client = await this.db.startTransaction();

        try {
            for (const change of changes) {
                await this.db.queryTran(
                    client,
                    // LastDecayAt is cleared deliberately: the rebuilt rating
                    // has no relationship to the decay already applied to the
                    // old one, so the next sweep re-derives it.
                    'UPDATE "Ratings" SET "Rating" = $1, "LastDecayAt" = NULL ' +
                        'WHERE "UserId" = $2 AND "Pool" = $3',
                    [change.after, change.userId, change.pool]
                );
            }

            await this.db.queryTran(client, 'COMMIT');
        } catch (err) {
            await this.db.queryTran(client, 'ROLLBACK');
            logger.error('Rating recalculation failed to commit', err);

            return { success: false, message: 'Recalculation failed to commit; nothing changed' };
        } finally {
            if (client.release) {
                client.release();
            }
        }

        logger.warn(
            `RATING RECALCULATION committed: ${changes.length} rating(s) rewritten from ` +
                `${games.length} replayed game(s)`
        );

        return { ...report, committed: true, dryRun: false };
    }

    /**
     * Seed ratings for a replay: where each player stood when the current
     * season began, plus the history cut-off that season corresponds to.
     *
     * Returns empty seeds for a site that has never started a season, which
     * replays the whole history from the default rating.
     */
    async getRecalculationSeeds() {
        const current = await this.getCurrentSeason();
        const byKey = new Map();

        if (!current.startedAt) {
            return { byKey, season: null, sinceHistoryId: null };
        }

        // The standings archived when the PREVIOUS season ended are exactly the
        // ratings the current season started from.
        const rows = await this.db.query(
            'SELECT "UserId", "Pool", "RatingAfterReset", "GamesPlayed" ' +
                'FROM "SeasonStandings" WHERE "SeasonId" = $1',
            [current.number - 1]
        );

        for (const row of rows || []) {
            byKey.set(`${row.UserId}|${row.Pool}`, {
                rating: row.RatingAfterReset,
                gamesPlayed: row.GamesPlayed
            });
        }

        return { byKey, season: current.number, sinceStartedAt: current.startedAt };
    }

    /**
     * Recorded games in replay order, one entry per game (RatingHistory holds
     * two rows per game - winner and loser - which are folded together here).
     *
     * `sinceStartedAt` limits the replay to the current season.
     */
    async getReplayableHistory(sinceStartedAt) {
        // Only the winner's row per game. RatingHistory holds two rows per
        // game and the loser's is the mirror image, so replaying both would
        // double-count every result.
        const params = [];
        let where = 'WHERE w."Won" = true';

        if (sinceStartedAt) {
            params.push(sinceStartedAt);
            where += ` AND w."CreatedAt" >= $${params.length}`;
        }

        const rows = await this.db.query(
            'SELECT w."GameId", w."Pool", w."UserId" AS "WinnerId", w."OpponentId" AS "LoserId", ' +
                'w."OwnSas" AS "WinnerSas", w."OpponentSas" AS "LoserSas", ' +
                'w."KeyDiff", w."ResultType", w."CreatedAt", ' +
                // isTournament is not stored on the history row, but it changes
                // K via tournamentKMultiplier, so it has to be re-derived or
                // the replay would rate every event game as casual.
                'EXISTS (SELECT 1 FROM "TournamentMatchGames" tmg ' +
                'JOIN "Games" g ON g."Id" = w."GameId" ' +
                'WHERE tmg."GameUuid" = g."GameId") AS "IsTournament" ' +
                'FROM "RatingHistory" w ' +
                `${where} ` +
                // Chronological: a replay in any other order would feed each
                // game the wrong "rating before".
                'ORDER BY w."CreatedAt" ASC, w."GameId" ASC, w."Id" ASC',
            params
        );

        return (rows || []).map((row) => ({
            gameId: row.GameId,
            pool: row.Pool,
            winnerId: row.WinnerId,
            loserId: row.LoserId,
            winnerSas: row.WinnerSas,
            loserSas: row.LoserSas,
            // A missing key differential falls back to the narrowest margin
            // rather than to zero, which movMultiplier would clamp to 1 anyway.
            keyDiff: row.KeyDiff == null ? 1 : row.KeyDiff,
            resultType: row.ResultType || 'keys',
            isTournament: !!row.IsTournament
        }));
    }

    /**
     * The current (latest) season, or season 1 with no recorded start if none
     * has been started yet.
     */
    async getCurrentSeason() {
        const rows = await this.db.query(
            'SELECT "Id", "StartedAt" FROM "Seasons" ORDER BY "Id" DESC LIMIT 1'
        );

        if (rows && rows[0]) {
            return { number: rows[0].Id, startedAt: rows[0].StartedAt };
        }

        return { number: 1, startedAt: null };
    }

    /**
     * Public ratings for a user by username: [{ pool, rating, gamesPlayed }].
     */
    async getRatingsForUsername(username) {
        const config = this.getConfig();
        // ARCHON (N4): the same activity window the leaderboard applies, so
        // "#3 of 40" here means the same 40 the board shows.
        const rankWindow = this.activityWindowSql(config, 'r2');
        const totalWindow = this.activityWindowSql(config, 'r3');

        const rows = await this.db.query(
            'SELECT r."Pool", r."Rating", r."GamesPlayed", ' +
                // Worldwide rank in the pool (players with a strictly higher
                // rating, plus one) and the size of the rated field. Both count
                // only the same population the leaderboard shows - rated
                // (GamesPlayed >= minimum), non-disabled accounts, and within
                // the activity window - so the profile's "rank #N of M" agrees
                // with the leaderboard.
                '(SELECT COUNT(*) + 1 FROM "Ratings" r2 ' +
                'JOIN "Users" u2 ON u2."Id" = r2."UserId" WHERE r2."Pool" = r."Pool" ' +
                'AND r2."Rating" > r."Rating" AND r2."GamesPlayed" >= $2 ' +
                (rankWindow ? `AND ${rankWindow} ` : '') +
                'AND u2."Disabled" IS NOT TRUE) AS "Rank", ' +
                '(SELECT COUNT(*) FROM "Ratings" r3 ' +
                'JOIN "Users" u3 ON u3."Id" = r3."UserId" WHERE r3."Pool" = r."Pool" ' +
                'AND r3."GamesPlayed" >= $2 ' +
                (totalWindow ? `AND ${totalWindow} ` : '') +
                'AND u3."Disabled" IS NOT TRUE) AS "TotalRated", ' +
                // Win/loss record from the audit history.
                '(SELECT COUNT(*) FROM "RatingHistory" h WHERE h."UserId" = r."UserId" ' +
                'AND h."Pool" = r."Pool" AND h."Won") AS "Wins", ' +
                '(SELECT COUNT(*) FROM "RatingHistory" h WHERE h."UserId" = r."UserId" ' +
                'AND h."Pool" = r."Pool" AND NOT h."Won") AS "Losses" ' +
                'FROM "Ratings" r JOIN "Users" u ON u."Id" = r."UserId" ' +
                'WHERE lower(u."Username") = lower($1) AND u."Disabled" IS NOT TRUE ORDER BY r."Pool"',
            [username, config.leaderboardMinGames]
        );

        const eloConfig = normalizeConfig(config.elo);

        return (rows || []).map((row) => ({
            pool: row.Pool,
            rating: row.Rating,
            gamesPlayed: row.GamesPlayed,
            provisional: row.GamesPlayed < eloConfig.provisionalGames,
            rank: parseInt(row.Rank, 10),
            totalRated: parseInt(row.TotalRated, 10),
            wins: parseInt(row.Wins, 10) || 0,
            losses: parseInt(row.Losses, 10) || 0
        }));
    }

    /**
     * ARCHON: what a finished game did to both players' Amber, for the
     * post-game result screen.
     *
     * Everything here was already persisted by processGame - RatingHistory
     * stores the before/after, the SAS on both sides, the key differential and
     * the result type per player per game. This just reads it back keyed by the
     * game's external uuid and joins the usernames on, so the client can show a
     * player what their game was worth without recomputing anything.
     *
     * Returns null when the game was never rated (unrated game type, a bot or
     * tournament-unrated event, or the rating hook not having run), which the
     * UI shows as an explicit "not rated" state rather than a blank panel.
     */
    /**
     * ARCHON: whether a game that has no rating yet is still going to get one.
     *
     * Rating runs asynchronously after GAMEWIN, so "no RatingHistory row" is two
     * completely different answers: not yet, and never. The post-game panel used
     * to conflate them and told players their game was unrated - usually
     * wrongly, because the panel's request beats the rating write almost every
     * time, and nothing ever asked again.
     *
     * The conditions below mirror the guards in processGameInner. They are
     * duplicated deliberately and narrowly: this has to answer for a single
     * game without doing the rating work, and each is a stable rule. If the two
     * ever disagree the panel polls a little longer and then says the game was
     * not rated, which is the same thing it would have said anyway.
     *
     * @returns {Promise<{pending: boolean, reason?: string}>}
     */
    async describeMissingRating(gameUuid) {
        if (!gameUuid) {
            return { pending: false, reason: 'no game' };
        }

        if (!this.getConfig().enabled) {
            return { pending: false, reason: 'Rating is switched off on this site.' };
        }

        const rows = await this.db.query(
            'SELECT g."Id", g."WinnerId", g."WinReason", g."FinishedAt", ' +
                '(SELECT count(*) FROM "GamePlayers" gp WHERE gp."GameId" = g."Id") AS "Players" ' +
                'FROM "Games" g WHERE g."GameId" = $1',
            [gameUuid]
        );
        const game = rows && rows[0];

        if (!game) {
            // The result row is written by the same handler that triggers
            // rating, so a game that is not in the table yet is still in flight.
            return { pending: true };
        }

        if (!game.FinishedAt) {
            return { pending: true };
        }

        if (Number(game.Players) !== 2) {
            return { pending: false, reason: 'Only two-player games are rated.' };
        }

        if (!game.WinnerId) {
            return { pending: false, reason: 'The game ended without a winner.' };
        }

        if (this.getConfig().excludedWinReasons.includes(game.WinReason)) {
            return { pending: false, reason: 'This kind of result is not rated.' };
        }

        const tournamentRows = await this.db.query(
            'SELECT t."RatedGames" FROM "TournamentMatchGames" tmg ' +
                'JOIN "Tournaments" t ON t."Id" = tmg."TournamentId" ' +
                'WHERE tmg."GameUuid" = $1 LIMIT 1',
            [gameUuid]
        );

        if (tournamentRows && tournamentRows[0] && !tournamentRows[0].RatedGames) {
            return { pending: false, reason: 'This event is not rated.' };
        }

        // Everything says it should rate, and it has not yet. Either the write
        // is still in flight or it failed - the caller waits, then gives up.
        return { pending: true };
    }

    async getGameResult(gameUuid) {
        if (!gameUuid) {
            return null;
        }

        const rows = await this.db.query(
            'SELECT u."Username", o."Username" AS "OpponentUsername", h."Pool", h."Won", ' +
                'h."RatingBefore", h."RatingAfter", h."OwnSas", h."OpponentSas", ' +
                'h."KeyDiff", h."ResultType", r."GamesPlayed" ' +
                'FROM "RatingHistory" h ' +
                'JOIN "Games" g ON g."Id" = h."GameId" ' +
                'JOIN "Users" u ON u."Id" = h."UserId" ' +
                'LEFT JOIN "Users" o ON o."Id" = h."OpponentId" ' +
                'LEFT JOIN "Ratings" r ON r."UserId" = h."UserId" AND r."Pool" = h."Pool" ' +
                'WHERE g."GameId" = $1 ORDER BY h."Won" DESC',
            [gameUuid]
        );

        if (!rows || rows.length === 0) {
            return null;
        }

        const eloConfig = normalizeConfig(this.getConfig().elo);

        return {
            pool: rows[0].Pool,
            players: rows.map((row) => {
                const gamesPlayed = row.GamesPlayed == null ? null : Number(row.GamesPlayed);

                return {
                    username: row.Username,
                    opponent: row.OpponentUsername,
                    won: row.Won,
                    ratingBefore: row.RatingBefore,
                    ratingAfter: row.RatingAfter,
                    change: row.RatingAfter - row.RatingBefore,
                    ownSas: row.OwnSas,
                    opponentSas: row.OpponentSas,
                    keyDiff: row.KeyDiff,
                    resultType: row.ResultType,
                    gamesPlayed,
                    // Placement progress: how many rated games until the rating
                    // stops being provisional, so a new player can see the
                    // countdown rather than just a badge.
                    provisional: gamesPlayed != null && gamesPlayed < eloConfig.provisionalGames,
                    provisionalGames: eloConfig.provisionalGames
                };
            })
        };
    }

    /**
     * Player location (rankings scope). State is free-form except for
     * countries where the client offers a fixed list; both are stored
     * uppercase-code (country) and trimmed (state).
     */
    async getLocation(userId) {
        const rows = await this.db.query('SELECT "Country", "State" FROM "Users" WHERE "Id" = $1', [
            userId
        ]);

        const row = rows && rows[0];

        return {
            country: row?.Country || null,
            state: row?.State || null,
            region: row?.Country ? regionForCountry(row.Country) : null
        };
    }

    async setLocation(userId, country, state) {
        const normalizedCountry = country ? String(country).toUpperCase().trim() : null;
        const normalizedState = state ? String(state).trim().slice(0, 60) : null;

        if (normalizedCountry && !isValidCountry(normalizedCountry)) {
            return { success: false, message: 'Unknown country code' };
        }

        await this.db.query('UPDATE "Users" SET "Country" = $1, "State" = $2 WHERE "Id" = $3', [
            normalizedCountry,
            normalizedCountry ? normalizedState : null,
            userId
        ]);

        return {
            success: true,
            country: normalizedCountry,
            state: normalizedCountry ? normalizedState : null,
            region: normalizedCountry ? regionForCountry(normalizedCountry) : null
        };
    }

    /**
     * Ranked slice of a rating pool.
     *
     * @param {object} options
     * @param {string} options.pool rating pool (game format), e.g. 'archon'
     * @param {string} [options.scope] 'world' | 'region' | 'country' | 'state'
     * @param {string} [options.country] required for country/state scope
     * @param {string} [options.state] required for state scope
     * @param {string} [options.region] required for region scope
     * @param {number} [options.limit]
     * @param {number} [options.offset]
     */
    async getLeaderboard(options) {
        const config = this.getConfig();
        const pool = this.normalizePool(options.pool);
        const scope = options.scope || 'world';
        const limit = Math.min(
            Math.max(1, parseInt(options.limit, 10) || 50),
            config.leaderboardMaxLimit
        );
        const offset = Math.max(0, parseInt(options.offset, 10) || 0);

        const params = [pool, config.leaderboardMinGames];
        let where = 'r."Pool" = $1 AND r."GamesPlayed" >= $2';

        // ARCHON (N4): the activity window. Applied here AND in the rank
        // subquery on the Ratings page (see activityWindowSql) - if the two
        // disagreed, a player's "#3 of 40" would not match the board they are
        // looking at, which is worse than not having the window at all.
        const activityClause = this.activityWindowSql(config, 'r');

        if (activityClause) {
            where += ` AND ${activityClause}`;
        }

        if (scope === 'region') {
            const countries = countriesInRegion(options.region);
            if (countries.length === 0) {
                return { entries: [], scope, pool };
            }

            params.push(countries);
            where += ` AND u."Country" = ANY($${params.length})`;
        } else if (scope === 'country' || scope === 'state') {
            const country = options.country ? String(options.country).toUpperCase() : null;
            if (!country || !isValidCountry(country)) {
                return { entries: [], scope, pool };
            }

            params.push(country);
            where += ` AND u."Country" = $${params.length}`;

            if (scope === 'state') {
                if (!options.state) {
                    return { entries: [], scope, pool };
                }

                // Case-insensitive exact match. ILIKE with the raw value let a
                // '%' or '_' in the query act as a wildcard (e.g. state=%
                // returned the whole country); locations are stored trimmed.
                params.push(String(options.state).trim());
                where += ` AND lower(u."State") = lower($${params.length})`;
            }
        }

        params.push(limit);
        const limitIndex = params.length;
        params.push(offset);
        const offsetIndex = params.length;

        const rows = await this.db.query(
            'SELECT u."Username", u."Country", u."State", u."Settings_Avatar", ' +
                'r."Rating", r."GamesPlayed", record."Wins", record."Losses" ' +
                'FROM "Ratings" r JOIN "Users" u ON u."Id" = r."UserId" ' +
                // W/L from the audit history, one lateral scan per row.
                'LEFT JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE h."Won") AS "Wins", ' +
                'COUNT(*) FILTER (WHERE NOT h."Won") AS "Losses" ' +
                'FROM "RatingHistory" h WHERE h."UserId" = r."UserId" AND h."Pool" = r."Pool") record ON true ' +
                `WHERE ${where} AND (u."Disabled" IS NOT TRUE) ` +
                'ORDER BY r."Rating" DESC, r."GamesPlayed" DESC, u."Username" ASC ' +
                `LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
            params
        );

        const eloConfig = normalizeConfig(config.elo);

        return {
            pool: pool,
            scope: scope,
            entries: (rows || []).map((row, index) => ({
                rank: offset + index + 1,
                username: row.Username,
                country: row.Country,
                state: row.State,
                avatar: row.Settings_Avatar,
                rating: row.Rating,
                gamesPlayed: row.GamesPlayed,
                provisional: row.GamesPlayed < eloConfig.provisionalGames,
                wins: parseInt(row.Wins, 10) || 0,
                losses: parseInt(row.Losses, 10) || 0
            }))
        };
    }

    /**
     * ARCHON (N7): rank one club's members by Amber.
     *
     * Deliberately NOT a filtered slice of the world board. The site board
     * hides anyone under leaderboardMinGames and (when configured) anyone
     * inactive; applied to a twelve-person club that can empty the page,
     * which makes the feature pointless for exactly the small local scenes
     * it exists for. So a club board lists every rated member and marks the
     * ones who also qualify site-wide, rather than quietly using different
     * rules and looking like the world board disagrees with itself.
     */
    async getClubLeaderboard(clubId, options = {}) {
        const config = this.getConfig();
        const pool = this.normalizePool(options.pool);
        const id = parseInt(clubId, 10);

        if (!Number.isInteger(id)) {
            return [];
        }

        const rows = await this.db.query(
            'SELECT u."Username", u."Country", u."Settings_Avatar", cm."Role", ' +
                'r."Rating", r."GamesPlayed", record."Wins", record."Losses" ' +
                'FROM "ClubMembers" cm ' +
                'JOIN "Users" u ON u."Id" = cm."UserId" ' +
                'JOIN "Ratings" r ON r."UserId" = cm."UserId" AND r."Pool" = $2 ' +
                'LEFT JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE h."Won") AS "Wins", ' +
                'COUNT(*) FILTER (WHERE NOT h."Won") AS "Losses" ' +
                'FROM "RatingHistory" h WHERE h."UserId" = r."UserId" AND h."Pool" = r."Pool") record ON true ' +
                'WHERE cm."ClubId" = $1 AND cm."Status" = \'active\' AND (u."Disabled" IS NOT TRUE) ' +
                'ORDER BY r."Rating" DESC, r."GamesPlayed" DESC, u."Username" ASC LIMIT 200',
            [id, pool]
        );

        const eloConfig = normalizeConfig(config.elo);

        return (rows || []).map((row, index) => ({
            rank: index + 1,
            username: row.Username,
            country: row.Country,
            avatar: row.Settings_Avatar,
            role: row.Role,
            rating: row.Rating,
            gamesPlayed: row.GamesPlayed,
            provisional: row.GamesPlayed < eloConfig.provisionalGames,
            // Whether this player also appears on the site-wide board.
            rankedSiteWide: row.GamesPlayed >= config.leaderboardMinGames,
            wins: parseInt(row.Wins, 10) || 0,
            losses: parseInt(row.Losses, 10) || 0
        }));
    }
}

module.exports = RatingService;
module.exports.computeDecay = computeDecay;
module.exports.RATING_POOLS = RATING_POOLS;
module.exports.computeSeasonReset = computeSeasonReset;
