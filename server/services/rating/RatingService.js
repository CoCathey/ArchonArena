const logger = require('../../log');
const { calculateGameResult, normalizeConfig } = require('./EloCalculator');
const { isValidCountry, regionForCountry, countriesInRegion } = require('./regions');

const DEFAULT_RATING_CONFIG = {
    enabled: true,
    // Win reasons that never rate (a rematch overwrites the winner record).
    excludedWinReasons: ['rematch'],
    // Rated games required to appear on leaderboards.
    leaderboardMinGames: 5,
    // Maximum rows a single leaderboard request may return.
    leaderboardMaxLimit: 100,
    // Overrides for the Elo calculator (see eloDefaults.js).
    elo: {}
};

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
     * Public ratings for a user by username: [{ pool, rating, gamesPlayed }].
     */
    async getRatingsForUsername(username) {
        const config = this.getConfig();
        const rows = await this.db.query(
            'SELECT r."Pool", r."Rating", r."GamesPlayed", ' +
                // Worldwide rank in the pool (players with a strictly higher
                // rating, plus one) and the size of the rated field. Both count
                // only the same population the leaderboard shows - rated
                // (GamesPlayed >= minimum) and non-disabled accounts - so the
                // profile's "rank #N of M" agrees with the leaderboard.
                '(SELECT COUNT(*) + 1 FROM "Ratings" r2 ' +
                'JOIN "Users" u2 ON u2."Id" = r2."UserId" WHERE r2."Pool" = r."Pool" ' +
                'AND r2."Rating" > r."Rating" AND r2."GamesPlayed" >= $2 ' +
                'AND u2."Disabled" IS NOT TRUE) AS "Rank", ' +
                '(SELECT COUNT(*) FROM "Ratings" r3 ' +
                'JOIN "Users" u3 ON u3."Id" = r3."UserId" WHERE r3."Pool" = r."Pool" ' +
                'AND r3."GamesPlayed" >= $2 AND u3."Disabled" IS NOT TRUE) AS "TotalRated", ' +
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
}

module.exports = RatingService;
