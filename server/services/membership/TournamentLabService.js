const logger = require('../../log');
const {
    parseSets,
    setPredicate,
    SET_COLUMNS,
    SET_JOIN,
    SET_GROUP_BY,
    asSet
} = require('./setFilter');
const AriService = require('../rating/AriService');
const { expectedScore, normalizeConfig } = require('../rating/EloCalculator');
// The site's conservatism, in one function: the same 95% lower bound the
// hidden-gem badge has to clear before the Challenge will call a deck good.
const { wilsonLowerBound } = require('../championschallenge/labMath');

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

/**
 * ARCHON (N24): what the considered ranking is made of, and how much each part
 * counts. Weights renormalise over whatever a deck actually has, so a deck with
 * no Challenge games is not punished for it - it is simply ranked on the rest.
 *
 * Why these four:
 *
 *  - **ARI** is the platform's own opinion of the deck, seeded from SAS/AERC and
 *    moved by every game the deck has played anywhere here. It is the only term
 *    that knows anything about decks the player has never met.
 *  - **The meta-weighted win rate** is the player's own matchup record, weighted
 *    by how common each house actually is right now. This is the number that
 *    answers "how do I do against what is out there", as opposed to "how do I do
 *    against whoever I happened to play".
 *  - **The player's record** with the deck, as the 95% lower bound on its win
 *    rate rather than its face value - which is what stops a 3-0 outranking a
 *    40-game record. Shrinking a mean toward a prior was tried first and is not
 *    enough: with a ten-game prior a 3-0 still lands at 65%.
 *  - **Champion's Challenge games** - sparring, so weighted lowest, but there
 *    are usually far more of them than real games, and the field games in
 *    particular are against decks from the whole catalog.
 */
const RANKING_WEIGHTS = { ari: 0.3, meta: 0.3, record: 0.25, challenge: 0.15 };

/** Fallback when the platform has no rated decks to average yet. */
const ASSUMED_FIELD_ARI = 65;

class TournamentLabService {
    constructor(db = require('../../db'), intelligence = null, settingsService = null) {
        this.db = db;
        // Injected so both share one connection and the SQL lives in one place.
        this.intelligence = intelligence || new (require('./ArchonIntelligenceService'))(db);
        // ARCHON (N24): ARI, so the Lab weighs the platform's own deck rating
        // rather than win percentage alone.
        this.ariService = new AriService(db);
        this.settingsService = settingsService || require('../settings');
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
     * ARCHON (N24): what the Champion's Challenge has learned about these decks.
     *
     * Two records per deck, never added together: mirror games (against the
     * member's own roster) and field games (against catalog decks nobody here
     * owns). Sparring is weaker evidence than a real game, which is why the
     * ranking weights it lowest - but there is usually a great deal more of it,
     * and for a deck with three real games it may be all there is.
     *
     * Read-only, and never throws: a member with no Challenge history gets zeros
     * rather than a failed comparison.
     */
    async challengeRecords(userId, deckIds) {
        const empty = () => ({
            mirror: { games: 0, wins: 0, winRate: null },
            field: { games: 0, wins: 0, winRate: null, avgOpponentSas: null }
        });
        const records = new Map(deckIds.map((deckId) => [deckId, empty()]));

        if (!deckIds.length) {
            return records;
        }

        try {
            const [mirror, field] = await Promise.all([
                this.db.query(
                    'SELECT d."DeckId", COUNT(*)::int AS "Played", ' +
                        'COUNT(*) FILTER (WHERE d."Won")::int AS "Wins" FROM (' +
                        'SELECT "WinnerDeckId" AS "DeckId", true AS "Won" ' +
                        'FROM "ProvingGroundsGames" WHERE "UserId" = $1 ' +
                        'UNION ALL ' +
                        'SELECT "LoserDeckId", false FROM "ProvingGroundsGames" WHERE "UserId" = $1' +
                        ') d WHERE d."DeckId" = ANY($2) GROUP BY d."DeckId"',
                    [userId, deckIds]
                ),
                this.db.query(
                    'SELECT "DeckId", COUNT(*)::int AS "Played", ' +
                        'COUNT(*) FILTER (WHERE "Won")::int AS "Wins", ' +
                        'AVG("OpponentSas")::float AS "AvgOpponentSas" ' +
                        'FROM "GauntletGames" WHERE "UserId" = $1 AND "DeckId" = ANY($2) ' +
                        'GROUP BY "DeckId"',
                    [userId, deckIds]
                )
            ]);

            for (const row of mirror || []) {
                const record = records.get(row.DeckId) || empty();

                record.mirror = {
                    games: row.Played,
                    wins: row.Wins,
                    winRate: row.Played ? row.Wins / row.Played : null
                };
                records.set(row.DeckId, record);
            }

            for (const row of field || []) {
                const record = records.get(row.DeckId) || empty();

                record.field = {
                    games: row.Played,
                    wins: row.Wins,
                    winRate: row.Played ? row.Wins / row.Played : null,
                    avgOpponentSas:
                        row.AvgOpponentSas == null ? null : Math.round(row.AvgOpponentSas * 10) / 10
                };
                records.set(row.DeckId, record);
            }
        } catch (err) {
            logger.error('Deep Probe could not read Challenge records: %s', err.message);
        }

        return records;
    }

    /** The average ARI across rated decks - what "a typical deck" means today. */
    async fieldAri() {
        try {
            const rows = await this.db.query(
                'SELECT AVG("Ari")::float AS "Ari" FROM "DeckAri" WHERE "Ari" IS NOT NULL'
            );

            if (rows && rows[0] && rows[0].Ari != null) {
                return rows[0].Ari;
            }

            // Nothing has moved yet, so the seed distribution is the field.
            const seeds = await this.db.query(
                'SELECT AVG("SasRating")::float AS "Sas" FROM "DeckSas" ' +
                    'WHERE "SasRating" IS NOT NULL'
            );

            return seeds && seeds[0] && seeds[0].Sas != null ? seeds[0].Sas : ASSUMED_FIELD_ARI;
        } catch (err) {
            logger.error('Deep Probe could not read the field ARI: %s', err.message);

            return ASSUMED_FIELD_ARI;
        }
    }

    /**
     * ARCHON (N24): the player's win rate against the CURRENT meta.
     *
     * Their per-house record, weighted by how common each house is in the meta
     * window - so a deck that beats the houses everyone is playing scores above a
     * deck that beats the houses nobody brings. Houses with too few games are
     * left out rather than guessed at, and `coverage` says how much of the meta
     * the answer actually rests on: a 70% over a fifth of the field is a
     * different claim from a 70% over all of it.
     *
     * Pure - given rows, it does no IO - so the arithmetic is directly testable.
     *
     * @param {Array} houseRows from deckByOpposingHouse
     * @param {object} meta from metaHouses
     * @param {number} [minGames] games needed against a house to count it
     */
    metaWinRate(houseRows, meta, minGames = 3) {
        if (!meta || !meta.available || !Array.isArray(houseRows) || !houseRows.length) {
            return { winRate: null, coverage: 0, houses: 0 };
        }

        const byHouse = new Map(houseRows.map((row) => [row.house, row]));
        let weighted = 0;
        let weight = 0;
        let counted = 0;

        for (const metaRow of meta.rows) {
            const mine = byHouse.get(metaRow.house);
            const share = metaRow.prevalence || 0;

            if (!mine || mine.games < minGames || mine.winRate == null || !share) {
                continue;
            }

            weighted += mine.winRate * share;
            weight += share;
            counted++;
        }

        return {
            // Normalised over the covered share, so this reads as "your win rate
            // against the part of the meta you have played" rather than being
            // dragged toward zero by houses you have never met.
            winRate: weight ? weighted / weight : null,
            coverage: weight,
            houses: counted
        };
    }

    /**
     * ARCHON (N24): one deck's considered score, and the parts it is made of.
     *
     * Returned with its components rather than as a bare number: a ranking a
     * player cannot interrogate is a ranking they cannot disagree with, and the
     * whole point of this page is to lay the evidence out.
     *
     * `score` ORDERS decks; it is not a win probability and must never be
     * rendered as one. Two of its four terms are 95% lower bounds, so a strong
     * deck scores below 0.5 - deliberately, because the question each term
     * answers is "what can this evidence support", not "what will happen". The
     * page shows the winner's name and the terms behind it, never the number.
     */
    rankDeck({ ari, fieldAri, metaWinRate, overview, challenge, sasWeight }) {
        const components = {};

        if (ari != null) {
            // What ARI says this deck should score against a typical rated deck,
            // through the same SAS term the platform's Elo uses - so "ARI 78 vs a
            // field of 65" becomes a win rate rather than a number of points.
            components.ari = {
                weight: RANKING_WEIGHTS.ari,
                value: expectedScore(0, 0, ari - fieldAri, { sasWeight }),
                detail: { ari: Math.round(ari), fieldAri: Math.round(fieldAri) }
            };
        }

        if (metaWinRate && metaWinRate.winRate != null) {
            components.meta = {
                weight: RANKING_WEIGHTS.meta,
                value: metaWinRate.winRate,
                detail: { coverage: metaWinRate.coverage, houses: metaWinRate.houses }
            };
        }

        // The player's own record, as the 95% LOWER BOUND on its win rate rather
        // than the win rate itself.
        //
        // Shrinking a mean toward a prior is not enough here: with a 10-game
        // prior at 55%, a 3-0 still lands at 65% and outranks a genuine 62% over
        // forty games, which is exactly the "highest win percentage wins"
        // behaviour this ranking exists to replace. A lower bound asks the right
        // question - what can this record actually support - so three games
        // cannot outrank forty by being lucky, and the same statistic the
        // hidden-gem badge must clear governs here too.
        const games = (overview && overview.games) || 0;

        if (games > 0) {
            const wins = Math.round((overview.winRate || 0) * games);

            components.record = {
                weight: RANKING_WEIGHTS.record,
                value: wilsonLowerBound(wins, games),
                detail: { games, winRate: overview.winRate, basis: 'wilson-lower-bound' }
            };
        }

        const sparring =
            (challenge && (challenge.mirror.games || 0) + (challenge.field.games || 0)) || 0;

        if (sparring > 0) {
            // Field games count double: a stranger's deck is a harder and more
            // informative test than one of the member's own.
            const mirrorWeight = challenge.mirror.games;
            const fieldWeight = challenge.field.games * 2;
            const total = mirrorWeight + fieldWeight;
            const blended =
                ((challenge.mirror.winRate || 0) * mirrorWeight +
                    (challenge.field.winRate || 0) * fieldWeight) /
                (total || 1);

            components.challenge = {
                weight: RANKING_WEIGHTS.challenge,
                // Bounded the same way, on the effective sample - sparring is
                // plentiful, so this is usually close to the rate itself, but a
                // deck with eight Challenge games does not get to claim 100%.
                value: wilsonLowerBound(Math.round(blended * total), total),
                detail: {
                    mirrorGames: challenge.mirror.games,
                    fieldGames: challenge.field.games,
                    winRate: blended
                }
            };
        }

        const present = Object.values(components);
        const weightSum = present.reduce((sum, part) => sum + part.weight, 0);

        return {
            // Renormalised over what exists, so a missing term is a term that
            // does not count rather than a term that counts as zero.
            score: weightSum
                ? present.reduce((sum, part) => sum + part.weight * part.value, 0) / weightSum
                : null,
            components
        };
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

        // ARCHON (N24): the meta comes FIRST now, because the per-deck numbers
        // are computed against it - "your win rate against the current meta"
        // cannot be worked out deck by deck in isolation.
        const [meta, metaSets, challengeRecords, fieldAri, ratingConfig] = await Promise.all([
            this.intelligence.metaHouses({ days: 30, sets: scope }),
            this.intelligence.metaSets({ days: 30 }),
            this.challengeRecords(userId, requested),
            this.fieldAri(),
            this.ratingConfig()
        ]);
        const ariByUuid = await this.ariService.ariForUuids(
            requested
                .map((deckId) => candidates.find((entry) => entry.deckId === deckId))
                .map((candidate) => candidate && candidate.uuid)
        );

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

                // ARCHON (N24): the three things this page used not to weigh -
                // the deck's ARI, what the Challenge has found, and the
                // player's record against the meta as it actually stands.
                const ariInfo = candidate ? ariByUuid.get(candidate.uuid) : null;
                const ari = ariInfo ? ariInfo.ari : null;
                const challenge = challengeRecords.get(deckId) || null;
                const vsMeta = this.metaWinRate(houseRows, meta);
                const { score, components } = this.rankDeck({
                    ari,
                    fieldAri,
                    metaWinRate: vsMeta,
                    overview,
                    challenge,
                    sasWeight: ratingConfig.sasWeight
                });

                return {
                    deckId,
                    deckName: candidate ? candidate.deckName : null,
                    uuid: candidate ? candidate.uuid : null,
                    sas: candidate ? candidate.sas : null,
                    ari,
                    ariGames: ariInfo ? ariInfo.ratedGames + ariInfo.simGames : 0,
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
                    vsMeta,
                    challenge,
                    score,
                    scoreComponents: components,
                    confident: (overview.games || 0) >= MIN_CONFIDENT_GAMES,
                    minConfidentGames: MIN_CONFIDENT_GAMES
                };
            })
        );

        return {
            candidates,
            decks,
            meta,
            metaSets,
            scoping,
            // ARCHON (N24): the two headline answers, named rather than left for
            // the reader to squint out of a table. `bestOverall` is the
            // considered ranking - ARI, the meta, the player's record and the
            // Challenge, weighted - and `bestVsMeta` answers the narrower
            // question of which deck does best against what is actually being
            // played. They are often different decks, which is the interesting
            // part.
            ranking: this.summariseRanking(decks),
            rankingWeights: RANKING_WEIGHTS,
            fieldAri: Math.round(fieldAri)
        };
    }

    /** The named winners of the two rankings, or nulls when nothing qualifies. */
    summariseRanking(decks) {
        const scored = decks.filter((deck) => deck.score != null);
        const withMeta = decks.filter((deck) => deck.vsMeta && deck.vsMeta.winRate != null);
        const pick = (list, of) =>
            list.length ? list.slice().sort((a, b) => of(b) - of(a))[0] : null;
        const best = pick(scored, (deck) => deck.score);
        const bestMeta = pick(withMeta, (deck) => deck.vsMeta.winRate);

        return {
            bestOverall: best
                ? {
                      deckId: best.deckId,
                      deckName: best.deckName,
                      score: best.score,
                      // Whether the pick rests on a real sample or is the best of
                      // several thin records - the caller shows this, so the
                      // ranking never overstates itself.
                      confident: best.confident
                  }
                : null,
            bestVsMeta: bestMeta
                ? {
                      deckId: bestMeta.deckId,
                      deckName: bestMeta.deckName,
                      winRate: bestMeta.vsMeta.winRate,
                      coverage: bestMeta.vsMeta.coverage,
                      houses: bestMeta.vsMeta.houses
                  }
                : null,
            order: scored
                .slice()
                .sort((a, b) => b.score - a.score)
                .map((deck) => deck.deckId)
        };
    }

    /**
     * The Elo model's SAS exchange rate, read through the same settings
     * authority the rating engine uses - so a rating difference means the same
     * thing on this page as it does when a real game is scored.
     */
    async ratingConfig() {
        try {
            const section = this.settingsService.getSection('rating') || {};

            return normalizeConfig(section.elo || {});
        } catch (err) {
            logger.error('Deep Probe could not read the rating config: %s', err.message);

            return normalizeConfig({});
        }
    }
}

module.exports = TournamentLabService;
module.exports.MIN_CONFIDENT_GAMES = MIN_CONFIDENT_GAMES;
