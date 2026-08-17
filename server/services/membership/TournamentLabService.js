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
 * ARCHON (N12): the Tournament Lab - sold as "Deep Probe" since the rename;
 * class, routes and capability id keep the working name.
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
 *
 * ## Sets are the first filter, not a refinement
 *
 * Most real events restrict which sets may be brought, and a comparison that
 * includes decks the player cannot legally register is worse than useless - it
 * is a recommendation to show up with an illegal deck. So the Lab takes an
 * event's set list, either directly or by being pointed at a tournament, and
 * narrows the candidates before it computes anything.
 *
 * When it is scoped to a tournament it also scopes the meta panel underneath to
 * the same sets, because "what you would be walking into" means the field of
 * that event's format, not the field in general.
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
    async candidates(userId, { limit = 60, sets = [] } = {}) {
        const params = [userId];
        const setFilter = setPredicate(parseSets(sets), params, 'd');

        params.push(Math.min(Number(limit) || 60, 200));

        try {
            return (
                await this.db.query(
                    'SELECT d."Id" AS "deckId", d."Name" AS "deckName", d."Uuid" AS "uuid", ' +
                        '  COUNT(*)::int AS "games", ' +
                        '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins", ' +
                        '  MAX(g."FinishedAt") AS "lastPlayed", ds."SasRating" AS "sas", ' +
                        `  ${SET_COLUMNS} ` +
                        'FROM "GamePlayers" gp ' +
                        'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                        'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                        SET_JOIN('d') +
                        ' LEFT JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                        'WHERE gp."PlayerId" = $1 AND g."FinishedAt" IS NOT NULL AND g."BotGame" IS NOT TRUE ' +
                        `  AND g."WinnerId" IS NOT NULL${setFilter} ` +
                        `GROUP BY d."Id", d."Name", d."Uuid", ds."SasRating", ${SET_GROUP_BY} ` +
                        `ORDER BY COUNT(*) DESC, MAX(g."FinishedAt") DESC LIMIT $${params.length}`,
                    params
                )
            ).map((row) => ({
                deckId: row.deckId,
                deckName: row.deckName,
                uuid: row.uuid,
                set: asSet(row),
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
     * The sets an event allows, for scoping the Lab to a real tournament.
     *
     * An event with no restriction stores null, which means every set - so the
     * empty list this returns is the correct answer for it, not a failure. The
     * caller cannot tell those apart from the list alone, which is why the
     * tournament's name and its restriction are returned together.
     */
    async tournamentSets(tournamentId) {
        const id = parseInt(tournamentId, 10);

        if (!Number.isFinite(id)) {
            return null;
        }

        try {
            const rows = await this.db.query(
                'SELECT "Id", "Name", "AllowedSets" FROM "Tournaments" WHERE "Id" = $1',
                [id]
            );
            const tournament = rows && rows[0];

            if (!tournament) {
                return null;
            }

            let allowed = tournament.AllowedSets;

            if (typeof allowed === 'string') {
                try {
                    allowed = JSON.parse(allowed);
                } catch (err) {
                    allowed = null;
                }
            }

            return {
                id: tournament.Id,
                name: tournament.Name,
                sets: parseSets(Array.isArray(allowed) ? allowed : []),
                restricted: Array.isArray(allowed) && allowed.length > 0
            };
        } catch (err) {
            logger.error('Tournament Lab could not read event sets: %s', err.message);

            return null;
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
                    '  AND g."FinishedAt" IS NOT NULL AND g."BotGame" IS NOT TRUE AND g."WinnerId" IS NOT NULL ' +
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
    async compare(userId, deckIds = [], { sets = [], tournamentId = null } = {}) {
        // An event's own list wins over a hand-picked one: if the player said
        // "compare for THIS event", the event decides what is legal.
        const event = tournamentId ? await this.tournamentSets(tournamentId) : null;
        const scope = event && event.restricted ? event.sets : parseSets(sets);

        const candidates = await this.candidates(userId, { sets: scope });
        const scoping = {
            sets: scope,
            tournament: event ? { id: event.id, name: event.name } : null,
            // An unrestricted event is worth saying out loud - otherwise a
            // player who scoped to it wonders why nothing was filtered.
            tournamentAllowsAllSets: !!event && !event.restricted
        };

        if (!deckIds.length) {
            // Nothing selected yet: the UI shows the picker, so send only the
            // candidate list rather than doing per-deck work nobody asked for.
            return { candidates, decks: [], meta: null, scoping };
        }

        const owned = new Set(candidates.map((candidate) => candidate.deckId));
        const requested = deckIds.filter((deckId) => owned.has(deckId));

        const decks = await Promise.all(
            requested.map(async (deckId) => {
                const candidate = candidates.find((entry) => entry.deckId === deckId);

                const [overview, rating, byOpposingHouse, byOpposingSet, form] = await Promise.all([
                    this.intelligence.deckOverview(deckId, { userId }),
                    this.intelligence.deckRating(deckId, userId),
                    this.intelligence.deckByOpposingHouse(deckId, { userId }),
                    this.intelligence.deckByOpposingSet(deckId, { userId }),
                    this.recentForm(userId, deckId, {})
                ]);

                const houseRows = byOpposingHouse.available ? byOpposingHouse.rows : [];
                // Only rank matchups with enough games to be worth naming; a
                // 1-0 record against a house is not a good matchup.
                const ranked = houseRows
                    .filter((row) => row.games >= 3)
                    .slice()
                    .sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0));

                const setRows = byOpposingSet.available ? byOpposingSet.rows : [];

                return {
                    deckId,
                    deckName: candidate ? candidate.deckName : null,
                    uuid: candidate ? candidate.uuid : null,
                    sas: candidate ? candidate.sas : null,
                    set: candidate ? candidate.set : overview.set || null,
                    overview,
                    rating,
                    byOpposingHouse: houseRows,
                    byOpposingSet: setRows,
                    // When the comparison is scoped, the only opposing-set rows
                    // worth showing are the ones that event can actually field.
                    vsScopedSets: scope.length
                        ? setRows.filter((row) => row.set && scope.includes(row.set.id))
                        : setRows,
                    bestMatchups: ranked.slice(0, 3),
                    worstMatchups: ranked.slice(-3).reverse(),
                    form,
                    confident: (overview.games || 0) >= MIN_CONFIDENT_GAMES,
                    minConfidentGames: MIN_CONFIDENT_GAMES
                };
            })
        );

        // The field they would be bringing it into - narrowed to the same sets,
        // because the field of a set-restricted event is not the field at large.
        const [meta, metaSets] = await Promise.all([
            this.intelligence.metaHouses({ days: 30, sets: scope }),
            this.intelligence.metaSets({ days: 30 })
        ]);

        return { candidates, decks, meta, metaSets, scoping };
    }
}

module.exports = TournamentLabService;
module.exports.MIN_CONFIDENT_GAMES = MIN_CONFIDENT_GAMES;
