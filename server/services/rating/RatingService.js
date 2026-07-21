const logger = require('../../log');
const { calculateGameResult, normalizeConfig } = require('./EloCalculator');
const { isValidCountry, regionForCountry, countriesInRegion } = require('./regions');

const DEFAULT_RATING_CONFIG = {
    enabled: true,
    // Game types (beginner/casual/competitive) that move ratings.
    ratedTypes: ['casual', 'competitive'],
    // Win reasons that never rate (a rematch overwrites the winner record).
    excludedWinReasons: ['rematch'],
    // Rated games required to appear on leaderboards.
    leaderboardMinGames: 5,
    // Maximum rows a single leaderboard request may return.
    leaderboardMaxLimit: 100,
    // Overrides for the Elo calculator (see eloDefaults.js).
    elo: {}
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
    constructor(configService, db = require('../../db')) {
        this.configService = configService;
        this.db = db;
    }

    getConfig() {
        const fileConfig = this.configService.getValue('rating') || {};

        return {
            ...DEFAULT_RATING_CONFIG,
            ...fileConfig,
            elo: { ...DEFAULT_RATING_CONFIG.elo, ...(fileConfig.elo || {}) }
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
            'SELECT g."Id" AS "GameDbId", g."GameType", g."GameFormat", g."WinnerId", g."WinReason", ' +
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

        if (!game.WinnerId || !game.GameType) {
            return;
        }

        if (!config.ratedTypes.includes(game.GameType)) {
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

        const pool = game.GameFormat || 'archon';
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
                resultType: resultType
            },
            config.elo
        );

        const keyDiff = (winnerRow.Keys || 0) - (loserRow.Keys || 0);
        const configSnapshot = JSON.stringify(eloConfig);

        const client = await this.db.startTransaction();
        try {
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

            await this.insertHistory(client, {
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

    async insertHistory(client, entry) {
        await this.db.queryTran(
            client,
            'INSERT INTO "RatingHistory" ("GameId", "UserId", "OpponentId", "Pool", "Won", ' +
                '"RatingBefore", "RatingAfter", "Expected", "OwnSas", "OpponentSas", "KeyDiff", ' +
                '"ResultType", "ConfigSnapshot", "CreatedAt") ' +
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("GameId", "UserId") DO NOTHING',
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

    /**
     * Public ratings for a user by username: [{ pool, rating, gamesPlayed }].
     */
    async getRatingsForUsername(username) {
        const rows = await this.db.query(
            'SELECT r."Pool", r."Rating", r."GamesPlayed" FROM "Ratings" r ' +
                'JOIN "Users" u ON u."Id" = r."UserId" WHERE u."Username" = $1 ' +
                'ORDER BY r."Pool"',
            [username]
        );

        const eloConfig = normalizeConfig(this.getConfig().elo);

        return (rows || []).map((row) => ({
            pool: row.Pool,
            rating: row.Rating,
            gamesPlayed: row.GamesPlayed,
            provisional: row.GamesPlayed < eloConfig.provisionalGames
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
        const pool = options.pool || 'archon';
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

                params.push(String(options.state).trim());
                where += ` AND u."State" ILIKE $${params.length}`;
            }
        }

        params.push(limit);
        const limitIndex = params.length;
        params.push(offset);
        const offsetIndex = params.length;

        const rows = await this.db.query(
            'SELECT u."Username", u."Country", u."State", r."Rating", r."GamesPlayed" ' +
                'FROM "Ratings" r JOIN "Users" u ON u."Id" = r."UserId" ' +
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
                rating: row.Rating,
                gamesPlayed: row.GamesPlayed,
                provisional: row.GamesPlayed < eloConfig.provisionalGames
            }))
        };
    }
}

module.exports = RatingService;
