const logger = require('../../log');

/**
 * ARCHON (N12): Archon Intelligence - the analytics behind the Archon tier.
 *
 * It answers three questions, in this order:
 *
 *   1. Is this actually a good deck?      -> Deck Intelligence
 *   2. Am I actually good with this deck? -> Player Intelligence
 *   3. How does it fare against the field? -> Meta Intelligence
 *
 * ## Every number here comes from a real column
 *
 * Nothing in this file invents a statistic to fill a panel. Where the data does
 * not exist the metric is returned as `{ available: false, reason }` and the UI
 * renders it as "not recorded yet" rather than as a zero - a fabricated zero is
 * worse than an absent number, because a player will act on it.
 *
 * What is real, and from where:
 *
 *   record, win %          GamePlayers x Games (WinnerId)
 *   keys forged            GamePlayers."Keys"  (see the cap below)
 *   game length            Games."FinishedAt" - "StartedAt", GamePlayers."Turn"
 *   rating swing           RatingHistory."RatingBefore"/"RatingAfter"
 *   expected win rate      RatingHistory."Expected" (the Elo expectation)
 *   vs expectation         actual wins - SUM(Expected): the honest answer to
 *                          "am I good with this deck, or is it just a good deck"
 *   opposing house         opponent's GamePlayers -> Decks -> DeckHouses
 *   over time              RatingHistory."CreatedAt" ordered series
 *   meta prevalence        DeckHouses across all finished games in a window
 *
 * What is NOT, and why:
 *
 *   going first vs second  `game.firstPlayer` exists in memory
 *                          (FirstPlayerSelection.js) but was never persisted.
 *                          Migration 62 adds GamePlayers."WentFirst" and the
 *                          engine now records it, so this fills in for games
 *                          played from that point on - historic games stay
 *                          null and are excluded rather than guessed at.
 *   house played per turn  only inside GameReplays."Data" snapshots, not in a
 *                          queryable column. "Strongest house" is therefore
 *                          reported as win rate with decks CONTAINING a house,
 *                          which is a different (and weaker) claim, and is
 *                          labelled as such.
 *
 * ## A caution about Keys
 *
 * GamePlayers."Keys" for an online game is computed by counting three booleans
 * (GameService.update), so it saturates at 3 even when a game was won at 4+.
 * It is reported as "keys at game end" rather than "keys forged" for that
 * reason. In-person rows are uncapped, which is why online and IRL are not
 * averaged together without saying so.
 */

/** Only decided games count: unfinished and abandoned games are not results. */
const DECIDED = 'g."FinishedAt" IS NOT NULL AND g."WinnerId" IS NOT NULL';

const UNAVAILABLE = (reason) => ({ available: false, reason });

class ArchonIntelligenceService {
    constructor(db = require('../../db')) {
        this.db = db;
    }

    /**
     * Every query here is wrapped: analytics are an enhancement, and a failing
     * aggregate should degrade one card rather than 500 the page.
     */
    async safeQuery(sql, params, label) {
        try {
            return await this.db.query(sql, params);
        } catch (err) {
            logger.error('Archon Intelligence query failed (%s): %s', label, err.message);

            return null;
        }
    }

    /**
     * Does this deck belong to this user?
     *
     * Ownership is checked before any per-deck intelligence is returned. Deck
     * analytics are the player's own record, and letting one account read
     * another's would be a privacy change dressed as a premium feature.
     */
    async deckBelongsTo(deckId, userId) {
        const rows = await this.safeQuery(
            'SELECT 1 FROM "Decks" WHERE "Id" = $1 AND "UserId" = $2',
            [deckId, userId],
            'deckBelongsTo'
        );

        return !!(rows && rows.length);
    }

    // ---- Deck Intelligence --------------------------------------------------

    /**
     * "Is this actually a good deck?" - the deck's own record, independent of
     * who played it.
     *
     * @param {number} deckId
     * @param {{userId?: number}} [scope] restrict to one player's games
     */
    async deckOverview(deckId, { userId = null } = {}) {
        const params = [deckId];
        let playerFilter = '';

        if (userId) {
            params.push(userId);
            playerFilter = ` AND gp."PlayerId" = $${params.length}`;
        }

        const rows = await this.safeQuery(
            'SELECT ' +
                '  COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins", ' +
                // AVG over a saturating column; reported as "keys at end".
                '  AVG(gp."Keys")::float AS "avgKeys", ' +
                '  AVG(gp."Turn")::float AS "avgTurns", ' +
                '  AVG(EXTRACT(EPOCH FROM (g."FinishedAt" - g."StartedAt")))::float AS "avgSeconds", ' +
                '  MIN(g."FinishedAt") AS "firstPlayed", ' +
                '  MAX(g."FinishedAt") AS "lastPlayed" ' +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                `WHERE gp."DeckId" = $1 AND ${DECIDED}${playerFilter}`,
            params,
            'deckOverview'
        );

        if (!rows || !rows.length || !rows[0].games) {
            return { games: 0, wins: 0, losses: 0, winRate: null, available: false };
        }

        const row = rows[0];

        return {
            available: true,
            games: row.games,
            wins: row.wins,
            losses: row.games - row.wins,
            winRate: row.games ? row.wins / row.games : null,
            avgKeysAtEnd: row.avgKeys,
            avgTurns: row.avgTurns,
            avgSeconds: row.avgSeconds,
            firstPlayed: row.firstPlayed,
            lastPlayed: row.lastPlayed
        };
    }

    /**
     * Rating movement while playing this deck.
     *
     * RatingHistory has no deck column, so it is joined back through
     * GamePlayers on (GameId, PlayerId) - which is exactly the pair that table
     * is uniquely indexed on. This is a real per-deck rating signal rather than
     * a separate per-deck Elo, and is labelled "rating swing with this deck"
     * because that is what it is.
     */
    async deckRating(deckId, userId) {
        if (!userId) {
            return UNAVAILABLE('Rating movement is per player; sign in to see yours.');
        }

        const rows = await this.safeQuery(
            'SELECT ' +
                '  COUNT(*)::int AS "rated", ' +
                '  SUM(rh."RatingAfter" - rh."RatingBefore")::int AS "netSwing", ' +
                '  AVG(rh."Expected")::float AS "avgExpected", ' +
                '  COUNT(*) FILTER (WHERE rh."Won")::int AS "wins", ' +
                '  AVG(rh."OwnSas")::float AS "avgOwnSas", ' +
                '  AVG(rh."OpponentSas")::float AS "avgOpponentSas" ' +
                'FROM "RatingHistory" rh ' +
                'JOIN "GamePlayers" gp ON gp."GameId" = rh."GameId" AND gp."PlayerId" = rh."UserId" ' +
                'WHERE gp."DeckId" = $1 AND rh."UserId" = $2',
            [deckId, userId],
            'deckRating'
        );

        if (!rows || !rows.length || !rows[0].rated) {
            return UNAVAILABLE('No rated games with this deck yet.');
        }

        const row = rows[0];

        // The question "am I good with this deck, or is it just a good deck?"
        // has an actual answer: the rating engine predicted `avgExpected` wins
        // per game before each one was played. Beating that is skill (or luck);
        // missing it is the deck carrying you less far than the rating thinks.
        const expectedWins = row.avgExpected === null ? null : row.avgExpected * row.rated;

        return {
            available: true,
            ratedGames: row.rated,
            netSwing: row.netSwing,
            wins: row.wins,
            expectedWins,
            // Positive = outperforming what the rating engine expected.
            vsExpectation: expectedWins === null ? null : row.wins - expectedWins,
            avgOwnSas: row.avgOwnSas,
            avgOpponentSas: row.avgOpponentSas
        };
    }

    /**
     * Record split by the houses the OPPOSING deck contained.
     *
     * One game contributes to three rows (the opponent's three houses), so the
     * counts sum to 3x the game count by design - it answers "how do I do
     * against decks with Dis in them", not "against Dis".
     */
    async deckByOpposingHouse(deckId, { userId = null } = {}) {
        const params = [deckId];
        let playerFilter = '';

        if (userId) {
            params.push(userId);
            playerFilter = ` AND gp."PlayerId" = $${params.length}`;
        }

        const rows = await this.safeQuery(
            'SELECT h."Code" AS "house", h."Name" AS "houseName", ' +
                '  COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins" ' +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                'JOIN "GamePlayers" ogp ON ogp."GameId" = gp."GameId" AND ogp."PlayerId" <> gp."PlayerId" ' +
                'JOIN "DeckHouses" dh ON dh."DeckId" = ogp."DeckId" ' +
                'JOIN "Houses" h ON h."Id" = dh."HouseId" ' +
                `WHERE gp."DeckId" = $1 AND ${DECIDED}${playerFilter} ` +
                'GROUP BY h."Code", h."Name" ORDER BY "games" DESC',
            params,
            'deckByOpposingHouse'
        );

        if (!rows || !rows.length) {
            return { available: false, rows: [] };
        }

        return {
            available: true,
            rows: rows.map((row) => ({
                house: row.house,
                houseName: row.houseName,
                games: row.games,
                wins: row.wins,
                losses: row.games - row.wins,
                winRate: row.games ? row.wins / row.games : null
            }))
        };
    }

    /**
     * Going first vs second.
     *
     * Real only for games played after migration 62 added
     * GamePlayers."WentFirst"; earlier rows are NULL and are excluded rather
     * than assumed. Returning `available: false` with a count of how many games
     * lack the data is the honest rendering - the UI says "recorded from now
     * on" instead of showing a fabricated 50%.
     */
    async deckByTurnOrder(deckId, { userId = null } = {}) {
        const params = [deckId];
        let playerFilter = '';

        if (userId) {
            params.push(userId);
            playerFilter = ` AND gp."PlayerId" = $${params.length}`;
        }

        const rows = await this.safeQuery(
            'SELECT gp."WentFirst" AS "wentFirst", ' +
                '  COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins" ' +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                `WHERE gp."DeckId" = $1 AND ${DECIDED}${playerFilter} ` +
                'GROUP BY gp."WentFirst"',
            params,
            'deckByTurnOrder'
        );

        if (!rows) {
            return UNAVAILABLE('Turn order is not available.');
        }

        const known = rows.filter((row) => row.wentFirst !== null);
        const unknown = rows.find((row) => row.wentFirst === null);

        if (!known.length) {
            return {
                ...UNAVAILABLE(
                    'Turn order was not recorded for these games. It is recorded from now on.'
                ),
                gamesWithoutData: unknown ? unknown.games : 0
            };
        }

        const forOrder = (wentFirst) => {
            const row = known.find((candidate) => candidate.wentFirst === wentFirst);

            if (!row) {
                return { games: 0, wins: 0, winRate: null };
            }

            return {
                games: row.games,
                wins: row.wins,
                winRate: row.games ? row.wins / row.games : null
            };
        };

        return {
            available: true,
            first: forOrder(true),
            second: forOrder(false),
            gamesWithoutData: unknown ? unknown.games : 0
        };
    }

    // ---- Player Intelligence ------------------------------------------------

    /**
     * "Am I actually good with this deck?" across every deck a player owns -
     * their personal deck rankings.
     *
     * Ordered by win rate but carrying the game count, because a 100% win rate
     * over two games is not a ranking and the UI needs to be able to say so.
     */
    async playerDeckRankings(userId, { minGames = 1, limit = 100 } = {}) {
        const rows = await this.safeQuery(
            'SELECT d."Id" AS "deckId", d."Name" AS "deckName", d."Uuid" AS "uuid", ' +
                '  COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins", ' +
                '  AVG(gp."Keys")::float AS "avgKeys", ' +
                '  MAX(g."FinishedAt") AS "lastPlayed", ' +
                '  ds."SasRating" AS "sas" ' +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                `WHERE gp."PlayerId" = $1 AND ${DECIDED} ` +
                'GROUP BY d."Id", d."Name", d."Uuid", ds."SasRating" ' +
                'HAVING COUNT(*) >= $2 ' +
                'ORDER BY (COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId"))::float / COUNT(*) DESC, ' +
                '  COUNT(*) DESC LIMIT $3',
            [userId, Math.max(1, Number(minGames) || 1), Math.min(Number(limit) || 100, 500)],
            'playerDeckRankings'
        );

        if (!rows) {
            return [];
        }

        return rows.map((row) => ({
            deckId: row.deckId,
            deckName: row.deckName,
            uuid: row.uuid,
            games: row.games,
            wins: row.wins,
            losses: row.games - row.wins,
            winRate: row.games ? row.wins / row.games : null,
            avgKeysAtEnd: row.avgKeys,
            lastPlayed: row.lastPlayed,
            sas: row.sas
        }));
    }

    /**
     * The player's rating over time - the full Elo history the Supporter tier
     * unlocks. Straight from RatingHistory, which records every rated game.
     */
    async playerRatingHistory(userId, { pool = null, limit = 500 } = {}) {
        const params = [userId];
        let poolFilter = '';

        if (pool) {
            params.push(pool);
            poolFilter = ` AND rh."Pool" = $${params.length}`;
        }

        params.push(Math.min(Number(limit) || 500, 2000));

        const rows = await this.safeQuery(
            'SELECT rh."CreatedAt", rh."Pool", rh."Won", rh."RatingBefore", rh."RatingAfter", ' +
                '  rh."Expected", rh."OwnSas", rh."OpponentSas", rh."KeyDiff", rh."ResultType", ' +
                '  o."Username" AS "opponent" ' +
                'FROM "RatingHistory" rh ' +
                'LEFT JOIN "Users" o ON o."Id" = rh."OpponentId" ' +
                `WHERE rh."UserId" = $1${poolFilter} ` +
                `ORDER BY rh."Id" DESC LIMIT $${params.length}`,
            params,
            'playerRatingHistory'
        );

        if (!rows) {
            return [];
        }

        // Oldest first so the client can plot it without reversing.
        return rows.reverse().map((row) => ({
            at: row.CreatedAt,
            pool: row.Pool,
            won: row.Won,
            ratingBefore: row.RatingBefore,
            ratingAfter: row.RatingAfter,
            change: row.RatingAfter - row.RatingBefore,
            expected: row.Expected,
            ownSas: row.OwnSas,
            opponentSas: row.OpponentSas,
            keyDiff: row.KeyDiff,
            resultType: row.ResultType,
            opponent: row.opponent
        }));
    }

    /**
     * How the player has done against what the rating engine expected.
     *
     * This is the single most useful number in the product: the engine records
     * an `Expected` score per game before it is played, so summing it gives the
     * wins a purely rating-based model predicted. The gap is the part that is
     * the player.
     */
    async playerVsExpectation(userId, { sinceDays = null } = {}) {
        const params = [userId];
        let sinceFilter = '';

        if (sinceDays) {
            params.push(Number(sinceDays));
            sinceFilter = ` AND rh."CreatedAt" >= now() AT TIME ZONE 'utc' - ($${params.length} || ' days')::interval`;
        }

        const rows = await this.safeQuery(
            'SELECT COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE rh."Won")::int AS "wins", ' +
                '  SUM(rh."Expected")::float AS "expectedWins" ' +
                'FROM "RatingHistory" rh ' +
                `WHERE rh."UserId" = $1${sinceFilter}`,
            params,
            'playerVsExpectation'
        );

        if (!rows || !rows.length || !rows[0].games) {
            return UNAVAILABLE('No rated games yet.');
        }

        const row = rows[0];

        return {
            available: true,
            games: row.games,
            wins: row.wins,
            expectedWins: row.expectedWins,
            vsExpectation: row.expectedWins === null ? null : row.wins - row.expectedWins,
            winRate: row.games ? row.wins / row.games : null,
            expectedWinRate: row.expectedWins === null ? null : row.expectedWins / row.games
        };
    }

    /**
     * Win rate with decks containing each house.
     *
     * Deliberately NOT called "strongest house": which house a player actually
     * chose on a given turn lives only in replay snapshots, so this measures
     * decks that CONTAIN a house, not turns played in it. The UI carries the
     * same caveat.
     */
    async playerByOwnHouse(userId) {
        const rows = await this.safeQuery(
            'SELECT h."Code" AS "house", h."Name" AS "houseName", ' +
                '  COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins" ' +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                'JOIN "DeckHouses" dh ON dh."DeckId" = gp."DeckId" ' +
                'JOIN "Houses" h ON h."Id" = dh."HouseId" ' +
                `WHERE gp."PlayerId" = $1 AND ${DECIDED} ` +
                'GROUP BY h."Code", h."Name" ORDER BY "games" DESC',
            [userId],
            'playerByOwnHouse'
        );

        if (!rows) {
            return [];
        }

        return rows.map((row) => ({
            house: row.house,
            houseName: row.houseName,
            games: row.games,
            wins: row.wins,
            winRate: row.games ? row.wins / row.games : null
        }));
    }

    // ---- Meta Intelligence --------------------------------------------------

    /**
     * What the field is playing, and how it is doing - site-wide, over a window.
     */
    async metaHouses({ days = 30 } = {}) {
        const rows = await this.safeQuery(
            'SELECT h."Code" AS "house", h."Name" AS "houseName", ' +
                '  COUNT(*)::int AS "appearances", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins" ' +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                'JOIN "DeckHouses" dh ON dh."DeckId" = gp."DeckId" ' +
                'JOIN "Houses" h ON h."Id" = dh."HouseId" ' +
                `WHERE ${DECIDED} ` +
                "AND g.\"FinishedAt\" >= now() AT TIME ZONE 'utc' - ($1 || ' days')::interval " +
                'GROUP BY h."Code", h."Name" ORDER BY "appearances" DESC',
            [Math.max(1, Number(days) || 30)],
            'metaHouses'
        );

        if (!rows || !rows.length) {
            return { available: false, rows: [], totalAppearances: 0 };
        }

        const total = rows.reduce((sum, row) => sum + row.appearances, 0);

        return {
            available: true,
            totalAppearances: total,
            rows: rows.map((row) => ({
                house: row.house,
                houseName: row.houseName,
                appearances: row.appearances,
                // Share of all house slots played, not share of games: every
                // deck contributes three.
                prevalence: total ? row.appearances / total : null,
                wins: row.wins,
                winRate: row.appearances ? row.wins / row.appearances : null
            }))
        };
    }

    /** Overall shape of the meta window, for context under the house table. */
    async metaSummary({ days = 30 } = {}) {
        const rows = await this.safeQuery(
            'SELECT COUNT(*)::int AS "games", ' +
                '  COUNT(DISTINCT gp."PlayerId")::int AS "players", ' +
                '  COUNT(DISTINCT gp."DeckId")::int AS "decks", ' +
                '  AVG(EXTRACT(EPOCH FROM (g."FinishedAt" - g."StartedAt")))::float AS "avgSeconds" ' +
                'FROM "Games" g JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
                `WHERE ${DECIDED} ` +
                "AND g.\"FinishedAt\" >= now() AT TIME ZONE 'utc' - ($1 || ' days')::interval",
            [Math.max(1, Number(days) || 30)],
            'metaSummary'
        );

        if (!rows || !rows.length) {
            return { available: false };
        }

        return {
            available: true,
            games: rows[0].games,
            players: rows[0].players,
            decks: rows[0].decks,
            avgSeconds: rows[0].avgSeconds,
            windowDays: Math.max(1, Number(days) || 30)
        };
    }

    /**
     * Everything Deck Intelligence needs for one deck, in one call.
     */
    async deckIntelligence(deckId, { userId = null } = {}) {
        const [overview, rating, byOpposingHouse, byTurnOrder] = await Promise.all([
            this.deckOverview(deckId, { userId }),
            this.deckRating(deckId, userId),
            this.deckByOpposingHouse(deckId, { userId }),
            this.deckByTurnOrder(deckId, { userId })
        ]);

        return { overview, rating, byOpposingHouse, byTurnOrder };
    }
}

module.exports = ArchonIntelligenceService;
