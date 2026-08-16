const logger = require('../../log');
const {
    parseSets,
    setPredicate,
    SET_COLUMNS,
    SET_JOIN,
    SET_GROUP_BY,
    asSet
} = require('./setFilter');

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
 *   set                    Decks."ExpansionId" -> Expansions (see below)
 *
 * ## Sets
 *
 * Every figure here can be narrowed to a set, and several are also reported
 * broken down BY set, because in KeyForge the set is not a cosmetic label - a
 * deck belongs to exactly one, houses are not evenly distributed across them,
 * and events routinely restrict which ones may be brought. A house win rate
 * averaged over every set that has ever existed answers a question nobody is
 * asking; "how does Untamed do in Æmber Skies" is the real one.
 *
 * A deck's own record is deliberately NOT set-filterable: a deck IS one set, so
 * the filter would either be a no-op or empty the panel. What a deck gets
 * instead is `byOpposingSet` - how it fares against decks from each set - which
 * is the per-deck question the set dimension actually answers.
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

        // The deck's own set travels with its record: a deck belongs to exactly
        // one, and every screen that shows a deck wants to say which.
        const rows = await this.safeQuery(
            'SELECT ' +
                '  COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins", ' +
                // AVG over a saturating column; reported as "keys at end".
                '  AVG(gp."Keys")::float AS "avgKeys", ' +
                '  AVG(gp."Turn")::float AS "avgTurns", ' +
                '  AVG(EXTRACT(EPOCH FROM (g."FinishedAt" - g."StartedAt")))::float AS "avgSeconds", ' +
                '  MIN(g."FinishedAt") AS "firstPlayed", ' +
                '  MAX(g."FinishedAt") AS "lastPlayed", ' +
                `  ${SET_COLUMNS} ` +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                SET_JOIN('d') +
                ` WHERE gp."DeckId" = $1 AND ${DECIDED}${playerFilter} ` +
                `GROUP BY ${SET_GROUP_BY}`,
            params,
            'deckOverview'
        );

        if (!rows || !rows.length || !rows[0].games) {
            return { games: 0, wins: 0, losses: 0, winRate: null, set: null, available: false };
        }

        const row = rows[0];

        return {
            available: true,
            set: asSet(row),
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
     * Record split by the SET the opposing deck came from.
     *
     * The per-deck counterpart to the opposing-house table, and unlike that one
     * the counts here sum to the game count rather than three times it: a deck
     * has three houses but exactly one set.
     *
     * This is the per-deck question the set dimension actually answers. A deck
     * that is 70% against the older sets and 40% against the newest one is
     * telling its owner something specific about what to bring, and an average
     * over both hides it.
     */
    async deckByOpposingSet(deckId, { userId = null } = {}) {
        const params = [deckId];
        let playerFilter = '';

        if (userId) {
            params.push(userId);
            playerFilter = ` AND gp."PlayerId" = $${params.length}`;
        }

        const rows = await this.safeQuery(
            `SELECT ${SET_COLUMNS}, ` +
                '  COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins" ' +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                'JOIN "GamePlayers" ogp ON ogp."GameId" = gp."GameId" AND ogp."PlayerId" <> gp."PlayerId" ' +
                'JOIN "Decks" od ON od."Id" = ogp."DeckId" ' +
                SET_JOIN('od') +
                ` WHERE gp."DeckId" = $1 AND ${DECIDED}${playerFilter} ` +
                `GROUP BY ${SET_GROUP_BY} ORDER BY "games" DESC`,
            params,
            'deckByOpposingSet'
        );

        if (!rows || !rows.length) {
            return { available: false, rows: [] };
        }

        return {
            available: true,
            rows: rows.map((row) => ({
                set: asSet(row),
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
    async playerDeckRankings(userId, { minGames = 1, limit = 100, sets = [] } = {}) {
        const params = [userId];
        // Narrowing to a set is how a player asks the question they actually
        // have before an event: not "which of my decks is best" but "which of
        // the ones I am allowed to bring is best".
        const setFilter = setPredicate(parseSets(sets), params, 'd');

        params.push(Math.max(1, Number(minGames) || 1));
        const minGamesParam = params.length;
        params.push(Math.min(Number(limit) || 100, 500));

        const rows = await this.safeQuery(
            'SELECT d."Id" AS "deckId", d."Name" AS "deckName", d."Uuid" AS "uuid", ' +
                '  COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins", ' +
                '  AVG(gp."Keys")::float AS "avgKeys", ' +
                '  MAX(g."FinishedAt") AS "lastPlayed", ' +
                '  ds."SasRating" AS "sas", ' +
                `  ${SET_COLUMNS} ` +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                SET_JOIN('d') +
                ' LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                `WHERE gp."PlayerId" = $1 AND ${DECIDED}${setFilter} ` +
                `GROUP BY d."Id", d."Name", d."Uuid", ds."SasRating", ${SET_GROUP_BY} ` +
                `HAVING COUNT(*) >= $${minGamesParam} ` +
                'ORDER BY (COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId"))::float / COUNT(*) DESC, ' +
                `  COUNT(*) DESC LIMIT $${params.length}`,
            params,
            'playerDeckRankings'
        );

        if (!rows) {
            return [];
        }

        return rows.map((row) => ({
            deckId: row.deckId,
            deckName: row.deckName,
            uuid: row.uuid,
            set: asSet(row),
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
     * The player's record broken down by the set their deck came from.
     *
     * The set counterpart to `playerByOwnHouse`, and a cleaner number than that
     * one: a deck has one set, so these rows sum to the player's actual game
     * count and the percentages are shares of real games rather than of slots.
     *
     * It answers "which sets do I actually play well" - which is a different
     * and more actionable question than which decks, because a player can go
     * and acquire another deck from a set that suits them.
     */
    async playerBySet(userId) {
        const rows = await this.safeQuery(
            `SELECT ${SET_COLUMNS}, ` +
                '  COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins", ' +
                '  COUNT(DISTINCT gp."DeckId")::int AS "decks", ' +
                '  MAX(g."FinishedAt") AS "lastPlayed" ' +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                SET_JOIN('d') +
                ` WHERE gp."PlayerId" = $1 AND ${DECIDED} ` +
                `GROUP BY ${SET_GROUP_BY} ORDER BY "games" DESC`,
            [userId],
            'playerBySet'
        );

        if (!rows || !rows.length) {
            return [];
        }

        const total = rows.reduce((sum, row) => sum + row.games, 0);

        return rows.map((row) => ({
            set: asSet(row),
            games: row.games,
            wins: row.wins,
            losses: row.games - row.wins,
            winRate: row.games ? row.wins / row.games : null,
            decks: row.decks,
            // Share of this player's own games, so it sums to 100%.
            share: total ? row.games / total : null,
            lastPlayed: row.lastPlayed
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
    async playerVsExpectation(userId, { sinceDays = null, sets = [] } = {}) {
        const params = [userId];
        let sinceFilter = '';

        if (sinceDays) {
            params.push(Number(sinceDays));
            sinceFilter = ` AND rh."CreatedAt" >= now() AT TIME ZONE 'utc' - ($${params.length} || ' days')::interval`;
        }

        // RatingHistory has no deck of its own, so a set filter has to travel
        // back through GamePlayers on (GameId, UserId) - the pair that table is
        // uniquely indexed on - to reach the deck that was actually played.
        const wanted = parseSets(sets);
        let setFilter = '';

        if (wanted.length) {
            params.push(wanted);
            setFilter =
                ' AND EXISTS (SELECT 1 FROM "GamePlayers" gp ' +
                '  JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                '  JOIN "Expansions" xset ON xset."Id" = d."ExpansionId" ' +
                '  WHERE gp."GameId" = rh."GameId" AND gp."PlayerId" = rh."UserId" ' +
                `  AND xset."ExpansionId" = ANY($${params.length}))`;
        }

        const rows = await this.safeQuery(
            'SELECT COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE rh."Won")::int AS "wins", ' +
                '  SUM(rh."Expected")::float AS "expectedWins" ' +
                'FROM "RatingHistory" rh ' +
                `WHERE rh."UserId" = $1${sinceFilter}${setFilter}`,
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
     * ARCHON (N12): the same comparison as `playerVsExpectation`, with a time
     * axis - the preview programme's `performance-trend`.
     *
     * The lifetime figure answers "am I better than my rating says". It cannot
     * answer "am I getting better", which is the question people actually have,
     * because one number over three years of games hides every run of form
     * inside it. Bucketing by month is the smallest honest way to show the
     * shape: months with no rated games are simply absent rather than plotted
     * as zero, since "did not play" is not "performed at zero".
     *
     * @param {number} userId
     * @param {{months?: number, sets?: number[]}} [options]
     */
    async playerVsExpectationTrend(userId, { months = 12, sets = [] } = {}) {
        // Bounded so a hand-edited query string cannot ask for a scan of every
        // month that has ever existed.
        const window = Math.min(Math.max(Number(months) || 12, 1), 36);
        const params = [userId, window];

        const wanted = parseSets(sets);
        let setFilter = '';

        if (wanted.length) {
            params.push(wanted);
            setFilter =
                ' AND EXISTS (SELECT 1 FROM "GamePlayers" gp ' +
                '  JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                '  JOIN "Expansions" xset ON xset."Id" = d."ExpansionId" ' +
                '  WHERE gp."GameId" = rh."GameId" AND gp."PlayerId" = rh."UserId" ' +
                `  AND xset."ExpansionId" = ANY($${params.length}))`;
        }

        const rows = await this.safeQuery(
            'SELECT date_trunc(\'month\', rh."CreatedAt") AS "month", ' +
                '  COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE rh."Won")::int AS "wins", ' +
                '  SUM(rh."Expected")::float AS "expectedWins" ' +
                'FROM "RatingHistory" rh ' +
                'WHERE rh."UserId" = $1 ' +
                "  AND rh.\"CreatedAt\" >= date_trunc('month', now() AT TIME ZONE 'utc') " +
                `    - (($2 - 1) || ' months')::interval${setFilter} ` +
                'GROUP BY 1 ORDER BY 1',
            params,
            'playerVsExpectationTrend'
        );

        if (!rows) {
            return UNAVAILABLE('The trend is not available.');
        }

        if (!rows.length) {
            return UNAVAILABLE('No rated games in this window yet.');
        }

        return {
            available: true,
            months: window,
            points: rows.map((row) => ({
                month: row.month,
                games: row.games,
                wins: row.wins,
                expectedWins: row.expectedWins,
                vsExpectation: row.expectedWins === null ? null : row.wins - row.expectedWins,
                winRate: row.games ? row.wins / row.games : null,
                expectedWinRate: row.expectedWins === null ? null : row.expectedWins / row.games
            }))
        };
    }

    /**
     * ARCHON (N12): recent form and streaks - the preview programme's
     * `form-and-streaks`.
     *
     * Read from RatingHistory rather than Games because a rated result is the
     * one a player recognises as "a game I played": it excludes unrated and
     * unfinished games without a second predicate, and it is the same source
     * the rest of Player Intelligence uses, so this panel cannot disagree with
     * the one above it.
     *
     * The best streak is computed over the same bounded window as the run, and
     * says so - claiming an all-time best from a truncated read would be a
     * number that quietly changes meaning as somebody plays more.
     *
     * @param {number} userId
     * @param {{limit?: number, window?: number}} [options]
     */
    async playerForm(userId, { limit = 20, window = 200 } = {}) {
        const recent = Math.min(Math.max(Number(limit) || 20, 1), 50);
        const scanned = Math.min(Math.max(Number(window) || 200, recent), 500);

        const rows = await this.safeQuery(
            'SELECT rh."Won", rh."CreatedAt" FROM "RatingHistory" rh ' +
                'WHERE rh."UserId" = $1 ORDER BY rh."Id" DESC LIMIT $2',
            [userId, scanned],
            'playerForm'
        );

        if (!rows) {
            return UNAVAILABLE('Form is not available.');
        }

        if (!rows.length) {
            return UNAVAILABLE('No rated games yet.');
        }

        // Newest first, which is the order the run is read in.
        const results = rows.map((row) => ({ won: !!row.Won, at: row.CreatedAt }));

        // The current streak runs back from the most recent game and is of
        // whatever kind that game was - a losing streak is as much a fact about
        // form as a winning one, and hiding it would make the panel a
        // congratulation rather than a measurement.
        let current = 0;

        for (const result of results) {
            if (result.won !== results[0].won) {
                break;
            }

            current += 1;
        }

        let bestWin = 0;
        let bestLoss = 0;
        let runKind = null;
        let run = 0;

        for (const result of results) {
            if (result.won === runKind) {
                run += 1;
            } else {
                runKind = result.won;
                run = 1;
            }

            if (runKind) {
                bestWin = Math.max(bestWin, run);
            } else {
                bestLoss = Math.max(bestLoss, run);
            }
        }

        const window20 = results.slice(0, recent);
        const wins = window20.filter((result) => result.won).length;

        return {
            available: true,
            // Oldest first, so the client can draw it left to right without
            // reversing an array it did not build.
            recent: [...window20].reverse(),
            games: window20.length,
            wins,
            losses: window20.length - wins,
            winRate: window20.length ? wins / window20.length : null,
            currentStreak: { kind: results[0].won ? 'win' : 'loss', length: current },
            bestWinStreak: bestWin,
            worstLossStreak: bestLoss,
            // What "best" was measured over, so the number is not read as
            // all-time when it is not.
            streakWindow: results.length,
            streakWindowTruncated: results.length >= scanned
        };
    }

    /**
     * ARCHON (N12): does this player win more going first - the preview
     * programme's `turn-order-insights`.
     *
     * The per-deck counterpart of `deckByTurnOrder`, and it carries the same
     * caveat: WentFirst was only added in migration 62, so games played before
     * it are null and excluded rather than guessed at. That exclusion is
     * reported (`gamesWithoutData`) instead of being folded into the totals,
     * because a turn-order split computed over a partly-unrecorded history is
     * exactly the kind of number a player would act on and should not.
     *
     * @param {number} userId
     * @param {{sets?: number[]}} [options]
     */
    async playerByTurnOrder(userId, { sets = [] } = {}) {
        const params = [userId];
        const wanted = parseSets(sets);
        // The deck join is only paid for when a set filter is actually asked
        // for; without one this is a two-table aggregate.
        const deckJoin = wanted.length ? ' JOIN "Decks" d ON d."Id" = gp."DeckId"' : '';
        const setFilter = setPredicate(wanted, params, 'd');

        const rows = await this.safeQuery(
            'SELECT gp."WentFirst" AS "wentFirst", ' +
                '  COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins" ' +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId"' +
                `${deckJoin} ` +
                `WHERE gp."PlayerId" = $1 AND ${DECIDED}${setFilter} ` +
                'GROUP BY gp."WentFirst"',
            params,
            'playerByTurnOrder'
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

        const first = forOrder(true);
        const second = forOrder(false);

        return {
            available: true,
            first,
            second,
            // The headline: the gap, or null when one side has no games and a
            // difference would be a comparison with nothing.
            edge:
                first.winRate === null || second.winRate === null
                    ? null
                    : first.winRate - second.winRate,
            gamesWithoutData: unknown ? unknown.games : 0
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
    async playerByOwnHouse(userId, { sets = [] } = {}) {
        const params = [userId];
        // Houses are not evenly spread across sets, so an unfiltered house
        // table is partly a record of which sets the player happens to own.
        const setFilter = setPredicate(parseSets(sets), params, 'd');

        const rows = await this.safeQuery(
            'SELECT h."Code" AS "house", h."Name" AS "houseName", ' +
                '  COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins" ' +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                'JOIN "DeckHouses" dh ON dh."DeckId" = gp."DeckId" ' +
                'JOIN "Houses" h ON h."Id" = dh."HouseId" ' +
                `WHERE gp."PlayerId" = $1 AND ${DECIDED}${setFilter} ` +
                'GROUP BY h."Code", h."Name" ORDER BY "games" DESC',
            params,
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
    async metaHouses({ days = 30, sets = [] } = {}) {
        const params = [Math.max(1, Number(days) || 30)];
        // The most important filter on this page. House prevalence is a
        // property OF a set - each one ships a different distribution - so a
        // figure averaged across every set that has ever been printed describes
        // no format anybody actually plays.
        const setFilter = setPredicate(parseSets(sets), params, 'd');

        const rows = await this.safeQuery(
            'SELECT h."Code" AS "house", h."Name" AS "houseName", ' +
                '  COUNT(*)::int AS "appearances", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins" ' +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                'JOIN "DeckHouses" dh ON dh."DeckId" = gp."DeckId" ' +
                'JOIN "Houses" h ON h."Id" = dh."HouseId" ' +
                `WHERE ${DECIDED} ` +
                "AND g.\"FinishedAt\" >= now() AT TIME ZONE 'utc' - ($1 || ' days')::interval" +
                `${setFilter} ` +
                'GROUP BY h."Code", h."Name" ORDER BY "appearances" DESC',
            params,
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
    async metaSummary({ days = 30, sets = [] } = {}) {
        const params = [Math.max(1, Number(days) || 30)];
        const setFilter = setPredicate(parseSets(sets), params, 'd');

        const rows = await this.safeQuery(
            'SELECT COUNT(*)::int AS "games", ' +
                '  COUNT(DISTINCT gp."PlayerId")::int AS "players", ' +
                '  COUNT(DISTINCT gp."DeckId")::int AS "decks", ' +
                '  AVG(EXTRACT(EPOCH FROM (g."FinishedAt" - g."StartedAt")))::float AS "avgSeconds" ' +
                'FROM "Games" g JOIN "GamePlayers" gp ON gp."GameId" = g."Id" ' +
                'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                `WHERE ${DECIDED} ` +
                "AND g.\"FinishedAt\" >= now() AT TIME ZONE 'utc' - ($1 || ' days')::interval" +
                setFilter,
            params,
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
     * Which sets the field is actually playing, and how they are doing.
     *
     * Deliberately NOT filtered by set - this is the table you read to decide
     * what to filter the rest of the page to. `share` is a share of decks
     * brought to games in the window, and because a deck has exactly one set
     * these sum to 100%, unlike the house table above.
     *
     * The honest caution: a set's win rate here is mostly a statement about who
     * plays it and against what, not about the cards. A set played
     * predominantly by experienced players will read strong. It is a map of the
     * field, not a power ranking, and the UI says so.
     */
    async metaSets({ days = 30 } = {}) {
        const rows = await this.safeQuery(
            `SELECT ${SET_COLUMNS}, ` +
                '  COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins", ' +
                '  COUNT(DISTINCT gp."DeckId")::int AS "decks", ' +
                '  COUNT(DISTINCT gp."PlayerId")::int AS "players" ' +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                SET_JOIN('d') +
                ` WHERE ${DECIDED} ` +
                "AND g.\"FinishedAt\" >= now() AT TIME ZONE 'utc' - ($1 || ' days')::interval " +
                `GROUP BY ${SET_GROUP_BY} ORDER BY "games" DESC`,
            [Math.max(1, Number(days) || 30)],
            'metaSets'
        );

        if (!rows || !rows.length) {
            return { available: false, rows: [], totalGames: 0 };
        }

        const total = rows.reduce((sum, row) => sum + row.games, 0);

        return {
            available: true,
            totalGames: total,
            rows: rows.map((row) => ({
                set: asSet(row),
                games: row.games,
                wins: row.wins,
                winRate: row.games ? row.wins / row.games : null,
                decks: row.decks,
                players: row.players,
                // One set per deck, so unlike houses this really is a share.
                share: total ? row.games / total : null
            }))
        };
    }

    /**
     * Everything Deck Intelligence needs for one deck, in one call.
     */
    async deckIntelligence(deckId, { userId = null } = {}) {
        const [overview, rating, byOpposingHouse, byOpposingSet, byTurnOrder] = await Promise.all([
            this.deckOverview(deckId, { userId }),
            this.deckRating(deckId, userId),
            this.deckByOpposingHouse(deckId, { userId }),
            this.deckByOpposingSet(deckId, { userId }),
            this.deckByTurnOrder(deckId, { userId })
        ]);

        return { overview, rating, byOpposingHouse, byOpposingSet, byTurnOrder };
    }
}

module.exports = ArchonIntelligenceService;
