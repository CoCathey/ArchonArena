const logger = require('../../log');

/**
 * ARCHON (N12): the Tournament Lab.
 *
 * One question: "which of my decks should I bring to this event?"
 *
 * The answer is assembled entirely from the player's own recorded results -
 * record, rating swing, how they have done against each opposing house, and how
 * recently they have actually played the thing. No projections, no synthetic
 * scores dressed up as predictions: every column is a count or an average of
 * games that were really played, and a deck with too few games says so rather
 * than showing a confident-looking 100%.
 *
 * The one derived number is `confidence`, and it is deliberately about sample
 * size rather than about the deck. A player comparing two decks needs to know
 * which of the two records they can believe, and a 3-game 100% sitting next to
 * a 40-game 58% with no such marker is actively misleading.
 */

/** Below this, a record is shown but flagged as too thin to lean on. */
const MIN_CONFIDENT_GAMES = 10;

class TournamentLabService {
    constructor(db = require('../../db'), intelligence = null) {
        this.db = db;
        // Injected so both share one connection and the SQL lives in one place.
        this.intelligence = intelligence || new (require('./ArchonIntelligenceService'))(db);
    }

    /**
     * Every deck the player has actually played, as candidates for the picker.
     *
     * Ordered by games played: the decks worth considering for an event are the
     * ones there is a record for, and a collection can run to hundreds.
     */
    async candidates(userId, { limit = 60 } = {}) {
        try {
            return (
                await this.db.query(
                    'SELECT d."Id" AS "deckId", d."Name" AS "deckName", d."Uuid" AS "uuid", ' +
                        '  COUNT(*)::int AS "games", ' +
                        '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins", ' +
                        '  MAX(g."FinishedAt") AS "lastPlayed", ds."SasRating" AS "sas" ' +
                        'FROM "GamePlayers" gp ' +
                        'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                        'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                        'LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                        'WHERE gp."PlayerId" = $1 AND g."FinishedAt" IS NOT NULL ' +
                        '  AND g."WinnerId" IS NOT NULL ' +
                        'GROUP BY d."Id", d."Name", d."Uuid", ds."SasRating" ' +
                        'ORDER BY COUNT(*) DESC, MAX(g."FinishedAt") DESC LIMIT $2',
                    [userId, Math.min(Number(limit) || 60, 200)]
                )
            ).map((row) => ({
                deckId: row.deckId,
                deckName: row.deckName,
                uuid: row.uuid,
                games: row.games,
                wins: row.wins,
                winRate: row.games ? row.wins / row.games : null,
                lastPlayed: row.lastPlayed,
                sas: row.sas
            }));
        } catch (err) {
            logger.error('Tournament Lab candidates failed: %s', err.message);

            return [];
        }
    }

    /**
     * Form over the player's most recent games with a deck.
     *
     * "Recent performance" has to mean something specific to be useful, so it
     * is the last N games with that deck, not a time window - a deck played
     * twice in six months should not look cold because the calendar moved.
     */
    async recentForm(userId, deckId, { games = 10 } = {}) {
        try {
            const rows = await this.db.query(
                'SELECT (g."WinnerId" = gp."PlayerId") AS "won", g."FinishedAt" ' +
                    'FROM "GamePlayers" gp JOIN "Games" g ON g."Id" = gp."GameId" ' +
                    'WHERE gp."PlayerId" = $1 AND gp."DeckId" = $2 ' +
                    '  AND g."FinishedAt" IS NOT NULL AND g."WinnerId" IS NOT NULL ' +
                    'ORDER BY g."FinishedAt" DESC LIMIT $3',
                [userId, deckId, Math.min(Number(games) || 10, 50)]
            );

            const wins = rows.filter((row) => row.won).length;

            return {
                games: rows.length,
                wins,
                winRate: rows.length ? wins / rows.length : null,
                // Newest first, for a W/L strip in the UI.
                results: rows.map((row) => ({ won: !!row.won, at: row.FinishedAt }))
            };
        } catch (err) {
            logger.error('Tournament Lab recent form failed: %s', err.message);

            return { games: 0, wins: 0, winRate: null, results: [] };
        }
    }

    /**
     * Compare a set of decks side by side.
     *
     * @param {number} userId
     * @param {number[]} deckIds
     */
    async compare(userId, deckIds = []) {
        const candidates = await this.candidates(userId);

        if (!deckIds.length) {
            // Nothing selected yet: the UI shows the picker, so send only the
            // candidate list rather than doing per-deck work nobody asked for.
            return { candidates, decks: [], meta: null };
        }

        const owned = new Set(candidates.map((candidate) => candidate.deckId));
        const requested = deckIds.filter((deckId) => owned.has(deckId));

        const decks = await Promise.all(
            requested.map(async (deckId) => {
                const candidate = candidates.find((entry) => entry.deckId === deckId);

                const [overview, rating, byOpposingHouse, form] = await Promise.all([
                    this.intelligence.deckOverview(deckId, { userId }),
                    this.intelligence.deckRating(deckId, userId),
                    this.intelligence.deckByOpposingHouse(deckId, { userId }),
                    this.recentForm(userId, deckId, {})
                ]);

                const houseRows = byOpposingHouse.available ? byOpposingHouse.rows : [];
                // Only rank matchups with enough games to be worth naming; a
                // 1-0 record against a house is not a good matchup.
                const ranked = houseRows
                    .filter((row) => row.games >= 3)
                    .slice()
                    .sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0));

                return {
                    deckId,
                    deckName: candidate ? candidate.deckName : null,
                    uuid: candidate ? candidate.uuid : null,
                    sas: candidate ? candidate.sas : null,
                    overview,
                    rating,
                    byOpposingHouse: houseRows,
                    bestMatchups: ranked.slice(0, 3),
                    worstMatchups: ranked.slice(-3).reverse(),
                    form,
                    confident: (overview.games || 0) >= MIN_CONFIDENT_GAMES,
                    minConfidentGames: MIN_CONFIDENT_GAMES
                };
            })
        );

        // The field they would be bringing it into, so the comparison can be
        // read against what people are actually playing.
        const meta = await this.intelligence.metaHouses({ days: 30 });

        return { candidates, decks, meta };
    }
}

module.exports = TournamentLabService;
module.exports.MIN_CONFIDENT_GAMES = MIN_CONFIDENT_GAMES;
