const logger = require('../../log');
const { parseSets, setPredicate } = require('./setFilter');

/**
 * ARCHON: analysis in AERC terms rather than in SAS.
 *
 * ## Why this exists
 *
 * SAS is one number for how good a deck is. It answers "is this deck strong",
 * which is a question a player can already answer by looking at it. AERC is
 * what that number is made of - how much amber control, creature control,
 * efficiency and so on the deck actually has - and it answers a different and
 * far more useful question: WHICH KIND of deck suits you, and which kind beats
 * you.
 *
 * "My win rate drops against decks with amber control above 8" is an
 * actionable sentence. "I lose to decks with 5 more SAS" is not, because there
 * is nothing to do about it.
 *
 * ## Where the numbers come from
 *
 * Nowhere new. Decks of KeyForge returns the full AERC breakdown with every
 * SAS lookup, and the whole payload has been stored in `DeckSas.RawData` since
 * SAS enrichment landed. Everything here reads that cache, so the entire
 * feature costs zero outbound API calls and cannot push the site over its DoK
 * rate limit no matter how many people use it.
 *
 * The consequence is a coverage limit worth being honest about: a deck DoK has
 * never rated has no row, and games involving it are excluded rather than
 * guessed at. Every result carries the game count it was computed from.
 *
 * ## Bands, and why they are site-wide
 *
 * A trait value on its own means nothing to a player - is 7 amber control a
 * lot? So values are bucketed into four bands cut at the site-wide quartiles
 * of that trait, which makes "high creature control" mean the same thing for
 * every player and every comparison on the site. Cutting per player would make
 * one player's "high" another's "low" and quietly break every comparison the
 * feature exists to support.
 *
 * ## What this deliberately does not claim
 *
 * Correlation. A band where a player wins more is a band where they have won
 * more, not proof the trait caused it - deck power, who they happened to play,
 * and their own practice all ride along. The wording throughout says "your
 * record against" rather than "this trait beats you", every figure carries its
 * sample size, and anything under the confidence threshold is marked rather
 * than quietly ranked next to a solid number.
 */

/** Only decided games are results. */
const DECIDED = 'g."FinishedAt" IS NOT NULL AND g."WinnerId" IS NOT NULL';

/**
 * The AERC traits, in DoK's own order. Keys must match the JSON keys in
 * `DeckSas.RawData`; anything not in this list is not queryable.
 */
const TRAITS = [
    { key: 'amberControl', label: 'Amber Control', short: 'A' },
    { key: 'expectedAmber', label: 'Expected Amber', short: 'E' },
    { key: 'artifactControl', label: 'Artifact Control', short: 'R' },
    { key: 'creatureControl', label: 'Creature Control', short: 'C' },
    { key: 'efficiency', label: 'Efficiency', short: 'F' },
    { key: 'recursion', label: 'Recursion', short: 'U' },
    { key: 'disruption', label: 'Disruption', short: 'D' },
    { key: 'effectivePower', label: 'Effective Power', short: 'P' },
    { key: 'creatureProtection', label: 'Creature Protection', short: 'CP' }
];

const TRAIT_KEYS = new Set(TRAITS.map((trait) => trait.key));

/** Band labels, lowest first. Four bands, cut at the site-wide quartiles. */
const BANDS = ['Low', 'Mid', 'High', 'Very high'];

/**
 * Below this many games a figure is shown but marked as too thin to lean on.
 * The same threshold the Tournament Lab uses, for the same reason: a player
 * comparing two numbers needs to know which of them they can believe.
 */
const MIN_CONFIDENT_GAMES = 10;

/**
 * How far a band's win rate must sit from the baseline before it is worth
 * saying out loud. Ten points, the same bar `findings` applies to the gap
 * between two bands: below that the difference is noise wearing a headline.
 */
const MIN_EDGE = 0.1;

/** A trait's value for a deck alias, as a number, or NULL when DoK had none. */
const traitValue = (sasAlias, trait) => `(${sasAlias}."RawData" ->> '${trait}')::numeric`;

/**
 * ARCHON: the opponent's SAS row, reached without requiring their deck to still
 * exist.
 *
 * This used to be a plain join through "Decks" on ogp."DeckId", which is null
 * for any opponent who has since deleted the deck - so every game against a
 * deck its owner later tidied away silently left the analysis. The uuid the
 * game itself recorded (migration 71) does not care what is in anyone's
 * collection today, and the "Decks" join stays as the fallback for rows written
 * before that column existed.
 */
const OPPONENT_SAS_JOIN =
    'LEFT JOIN "Decks" od ON od."Id" = ogp."DeckId" ' +
    'JOIN "DeckSas" ods ON ods."Uuid" = COALESCE(ogp."DeckUuid", od."Uuid") ';

class AercAnalyticsService {
    constructor(db = require('../../db')) {
        this.db = db;
        // Band cut points are a site-wide property that moves only as decks are
        // imported, and every panel on the page needs them. Computed once per
        // process lifetime per trait rather than per request.
        this.bandCache = new Map();
    }

    /** Analytics degrade one panel rather than 500 the page. */
    async safeQuery(sql, params, label) {
        try {
            return await this.db.query(sql, params);
        } catch (err) {
            logger.error('AERC analytics query failed (%s): %s', label, err.message);

            return null;
        }
    }

    static get traits() {
        return TRAITS;
    }

    /** Guards the trait name before it is interpolated into SQL. */
    static isTrait(key) {
        return TRAIT_KEYS.has(key);
    }

    /**
     * The three quartile cut points for a trait, across every deck DoK has
     * rated on this site.
     *
     * Interpolated into SQL by name, so the caller MUST have gone through
     * `isTrait` first - which every public method here does.
     */
    async bandCuts(trait) {
        if (!AercAnalyticsService.isTrait(trait)) {
            return null;
        }

        if (this.bandCache.has(trait)) {
            return this.bandCache.get(trait);
        }

        const rows = await this.safeQuery(
            'SELECT ' +
                `  percentile_cont(0.25) WITHIN GROUP (ORDER BY ${traitValue(
                    'ds',
                    trait
                )}) AS "q1", ` +
                `  percentile_cont(0.5) WITHIN GROUP (ORDER BY ${traitValue(
                    'ds',
                    trait
                )}) AS "q2", ` +
                `  percentile_cont(0.75) WITHIN GROUP (ORDER BY ${traitValue(
                    'ds',
                    trait
                )}) AS "q3", ` +
                '  COUNT(*)::int AS "decks" ' +
                'FROM "DeckSas" ds ' +
                `WHERE ${traitValue('ds', trait)} IS NOT NULL`,
            [],
            'bandCuts'
        );

        const row = rows && rows[0];

        if (!row || !row.decks || row.q1 === null) {
            return null;
        }

        const cuts = {
            q1: Number(row.q1),
            q2: Number(row.q2),
            q3: Number(row.q3),
            decks: row.decks
        };

        this.bandCache.set(trait, cuts);

        return cuts;
    }

    /** The CASE that buckets a trait value into a band, given its cut points. */
    bandCase(sasAlias, trait, cuts) {
        const value = traitValue(sasAlias, trait);

        return (
            `CASE WHEN ${value} <= ${cuts.q1} THEN 'Low' ` +
            `WHEN ${value} <= ${cuts.q2} THEN 'Mid' ` +
            `WHEN ${value} <= ${cuts.q3} THEN 'High' ` +
            "ELSE 'Very high' END"
        );
    }

    /** Puts rows in band order and fills in bands with no games. */
    shapeBands(rows, cuts) {
        const byBand = new Map((rows || []).map((row) => [row.band, row]));

        return BANDS.map((band, index) => {
            const row = byBand.get(band);
            const games = row ? row.games : 0;
            const wins = row ? row.wins : 0;

            return {
                band,
                // The range each band covers, so a player can tell what "High"
                // actually means rather than trusting the word.
                from: index === 0 ? null : [cuts.q1, cuts.q2, cuts.q3][index - 1],
                to: index === 3 ? null : [cuts.q1, cuts.q2, cuts.q3][index],
                games,
                wins,
                losses: games - wins,
                winRate: games ? wins / games : null,
                confident: games >= MIN_CONFIDENT_GAMES
            };
        });
    }

    /**
     * The player's record split by a trait of their OWN deck.
     *
     * "Which kind of deck do I actually play well?"
     */
    async byOwnTrait(userId, trait, { sets = [] } = {}) {
        const cuts = await this.bandCuts(trait);

        if (!cuts) {
            return null;
        }

        const params = [userId];
        const setFilter = setPredicate(parseSets(sets), params, 'd');

        const rows = await this.safeQuery(
            `SELECT ${this.bandCase('ds', trait, cuts)} AS "band", ` +
                '  COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins" ' +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                'JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                `WHERE gp."PlayerId" = $1 AND ${DECIDED}${setFilter} ` +
                `  AND ${traitValue('ds', trait)} IS NOT NULL ` +
                'GROUP BY 1',
            params,
            'byOwnTrait'
        );

        return { trait, cuts, bands: this.shapeBands(rows, cuts) };
    }

    /**
     * The player's record split by a trait of the OPPONENT's deck.
     *
     * "Which kind of deck beats me?" - the question this whole feature is for.
     */
    async byOpponentTrait(userId, trait, { sets = [] } = {}) {
        const cuts = await this.bandCuts(trait);

        if (!cuts) {
            return null;
        }

        const params = [userId];
        // The set filter applies to the player's own deck: "when I bring an
        // Æmber Skies deck, what beats me" is the useful reading. Filtering the
        // opponent's set instead would answer a question nobody asked.
        const setFilter = setPredicate(parseSets(sets), params, 'd');

        const rows = await this.safeQuery(
            `SELECT ${this.bandCase('ods', trait, cuts)} AS "band", ` +
                '  COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins" ' +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                'JOIN "GamePlayers" ogp ON ogp."GameId" = gp."GameId" ' +
                '  AND ogp."PlayerId" <> gp."PlayerId" ' +
                OPPONENT_SAS_JOIN +
                `WHERE gp."PlayerId" = $1 AND ${DECIDED}${setFilter} ` +
                `  AND ${traitValue('ods', trait)} IS NOT NULL ` +
                'GROUP BY 1',
            params,
            'byOpponentTrait'
        );

        return { trait, cuts, bands: this.shapeBands(rows, cuts) };
    }

    /**
     * ARCHON: the deck's own record against each band of an opponent trait.
     *
     * The player-level version answers "which kind of deck beats ME". This one
     * answers "which kind of deck does THIS DECK beat", which is the question a
     * player actually has in front of them when they are choosing what to
     * bring, and it is the only form that can say a deck is good against
     * something rather than that its pilot is.
     *
     * Pooled across every copy of the deck, by the uuid the game recorded. Deck
     * matchup samples are thin enough as it is, and a friend playing your deck
     * is still that deck playing that matchup. `deck` comes from
     * `resolveDeck`, which is where ownership is established.
     */
    async deckByOpponentTrait(deck, trait) {
        const cuts = await this.bandCuts(trait);

        if (!deck || !cuts) {
            return null;
        }

        const rows = await this.safeQuery(
            `SELECT ${this.bandCase('ods', trait, cuts)} AS "band", ` +
                '  COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins" ' +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                'JOIN "GamePlayers" ogp ON ogp."GameId" = gp."GameId" ' +
                '  AND ogp."PlayerId" <> gp."PlayerId" ' +
                OPPONENT_SAS_JOIN +
                `WHERE ${deck.predicate} AND ${DECIDED} ` +
                `  AND ${traitValue('ods', trait)} IS NOT NULL ` +
                'GROUP BY 1',
            [deck.param],
            'deckByOpponentTrait'
        );

        return { trait, cuts, bands: this.shapeBands(rows, cuts) };
    }

    /**
     * Which of the player's houses hold up against each opponent band.
     *
     * The "what should I lean into against this" question. Houses rather than
     * decks because a house is something a player can go and acquire more of,
     * and because per-deck samples are far too thin to say anything.
     *
     * A deck contributes its three houses to every row, so these counts do not
     * sum to the game count - the same caveat the house tables elsewhere carry.
     */
    async housesVsOpponentTrait(userId, trait, { sets = [], minGames = 5 } = {}) {
        const cuts = await this.bandCuts(trait);

        if (!cuts) {
            return null;
        }

        const params = [userId];
        const setFilter = setPredicate(parseSets(sets), params, 'd');

        params.push(Math.max(1, Number(minGames) || 5));

        const rows = await this.safeQuery(
            `SELECT ${this.bandCase('ods', trait, cuts)} AS "band", ` +
                '  h."Code" AS "house", h."Name" AS "houseName", ' +
                '  COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins" ' +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                'JOIN "DeckHouses" dh ON dh."DeckId" = d."Id" ' +
                'JOIN "Houses" h ON h."Id" = dh."HouseId" ' +
                'JOIN "GamePlayers" ogp ON ogp."GameId" = gp."GameId" ' +
                '  AND ogp."PlayerId" <> gp."PlayerId" ' +
                'JOIN "Decks" od ON od."Id" = ogp."DeckId" ' +
                'JOIN "DeckSas" ods ON ods."Uuid" = od."Uuid" ' +
                `WHERE gp."PlayerId" = $1 AND ${DECIDED}${setFilter} ` +
                `  AND ${traitValue('ods', trait)} IS NOT NULL ` +
                'GROUP BY 1, h."Code", h."Name" ' +
                `HAVING COUNT(*) >= $${params.length} ` +
                // The aggregate is repeated rather than referred to as "wins":
                // an output alias is only usable in ORDER BY as a bare name,
                // and inside an expression it is read as a column that does
                // not exist.
                'ORDER BY 1, (COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId"))::float ' +
                '  / COUNT(*) DESC',
            params,
            'housesVsOpponentTrait'
        );

        if (!rows) {
            return null;
        }

        return {
            trait,
            cuts,
            minGames: Math.max(1, Number(minGames) || 5),
            bands: BANDS.map((band) => ({
                band,
                houses: rows
                    .filter((row) => row.band === band)
                    .map((row) => ({
                        house: row.house,
                        houseName: row.houseName,
                        games: row.games,
                        wins: row.wins,
                        winRate: row.games ? row.wins / row.games : null
                    }))
            }))
        };
    }

    /**
     * What the field looks like in AERC terms, over a window.
     *
     * This is the "compare the metas" half: the average and spread of each
     * trait across the decks actually being brought, optionally narrowed to a
     * set, so two formats can be held against each other.
     */
    async metaTraitProfile({ days = 30, sets = [] } = {}) {
        const params = [Math.max(1, Number(days) || 30)];
        const setFilter = setPredicate(parseSets(sets), params, 'd');

        const columns = TRAITS.map(
            (trait) =>
                `AVG(${traitValue('ds', trait.key)})::float AS "${trait.key}", ` +
                `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${traitValue('ds', trait.key)}) AS "${
                    trait.key
                }_median"`
        ).join(', ');

        const rows = await this.safeQuery(
            `SELECT COUNT(*)::int AS "decks", ${columns} ` +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                'JOIN "DeckSas" ds ON ds."Uuid" = d."Uuid" ' +
                `WHERE ${DECIDED} ` +
                "AND g.\"FinishedAt\" >= now() AT TIME ZONE 'utc' - ($1 || ' days')::interval" +
                setFilter,
            params,
            'metaTraitProfile'
        );

        const row = rows && rows[0];

        if (!row || !row.decks) {
            return { available: false, decks: 0, traits: [] };
        }

        return {
            available: true,
            decks: row.decks,
            traits: TRAITS.map((trait) => ({
                key: trait.key,
                label: trait.label,
                short: trait.short,
                mean: row[trait.key] === null ? null : Number(row[trait.key]),
                median:
                    row[`${trait.key}_median`] === null ? null : Number(row[`${trait.key}_median`])
            })).filter((trait) => trait.mean !== null)
        };
    }

    /**
     * The player's record with decks containing each card.
     *
     * The closest honest answer to "compare cards". It is a record of decks
     * that CONTAINED a card, not of the card being played - which turn a card
     * was played on lives only in replay snapshots - so a card that never left
     * the hand still counts. It is labelled that way and gated hard on sample
     * size, because there are thousands of cards and almost all of them will
     * have three games behind them.
     */
    async byCard(userId, { sets = [], minGames = 10, limit = 40 } = {}) {
        const params = [userId];
        const setFilter = setPredicate(parseSets(sets), params, 'd');

        params.push(Math.max(3, Number(minGames) || 10));
        const minGamesParam = params.length;
        params.push(Math.min(Number(limit) || 40, 200));

        const rows = await this.safeQuery(
            'SELECT c."Name" AS "card", dc."CardId" AS "cardId", ' +
                '  COUNT(DISTINCT gp."Id")::int AS "games", ' +
                '  COUNT(DISTINCT gp."Id") FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins" ' +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                'JOIN "Decks" d ON d."Id" = gp."DeckId" ' +
                'JOIN "DeckCards" dc ON dc."DeckId" = d."Id" ' +
                'JOIN "Cards" c ON c."CardId" = dc."CardId" ' +
                `WHERE gp."PlayerId" = $1 AND ${DECIDED}${setFilter} ` +
                '  AND dc."IsNonDeck" IS NOT TRUE ' +
                'GROUP BY c."Name", dc."CardId" ' +
                `HAVING COUNT(DISTINCT gp."Id") >= $${minGamesParam} ` +
                'ORDER BY (COUNT(DISTINCT gp."Id") FILTER (WHERE g."WinnerId" = gp."PlayerId"))::float ' +
                `  / COUNT(DISTINCT gp."Id") DESC, "games" DESC LIMIT $${params.length}`,
            params,
            'byCard'
        );

        if (!rows) {
            return [];
        }

        return rows.map((row) => ({
            card: row.card,
            cardId: row.cardId,
            games: row.games,
            wins: row.wins,
            losses: row.games - row.wins,
            winRate: row.games ? row.wins / row.games : null
        }));
    }

    /**
     * The findings, as sentences.
     *
     * A grid of nine traits times four bands is 36 numbers, and a player will
     * not find the two that matter by reading it. This walks every trait, takes
     * the widest gap between two bands that BOTH clear the confidence
     * threshold, and ranks what is left - so the page can lead with "your win
     * rate is 61% against low creature control and 38% against very high"
     * instead of asking the reader to spot it.
     *
     * Requiring both ends to be confident is what stops the headline being a
     * 100% record over two games, which is otherwise always the widest gap.
     */
    async findings(userId, { sets = [], limit = 5 } = {}) {
        const found = [];

        for (const side of ['own', 'opponent']) {
            for (const trait of TRAITS) {
                const result =
                    side === 'own'
                        ? await this.byOwnTrait(userId, trait.key, { sets })
                        : await this.byOpponentTrait(userId, trait.key, { sets });

                if (!result) {
                    continue;
                }

                const usable = result.bands.filter((band) => band.confident);

                if (usable.length < 2) {
                    continue;
                }

                const best = usable.reduce((a, b) => (b.winRate > a.winRate ? b : a));
                const worst = usable.reduce((a, b) => (b.winRate < a.winRate ? b : a));
                const gap = best.winRate - worst.winRate;

                // Below this the difference is not worth a sentence; two bands
                // five points apart is noise dressed as a finding.
                if (gap < 0.1) {
                    continue;
                }

                found.push({
                    side,
                    trait: trait.key,
                    label: trait.label,
                    short: trait.short,
                    gap,
                    best,
                    worst,
                    games: best.games + worst.games
                });
            }
        }

        return found.sort((a, b) => b.gap - a.gap).slice(0, Math.max(1, Number(limit) || 5));
    }

    /**
     * ARCHON: turn a deck id into the thing every deck query here matches on.
     *
     * A deck's identity is its Master Vault uuid, so that is what the games are
     * matched by - which pools every copy of the deck and survives any one
     * owner deleting theirs. Alliance and standalone decks have no uuid and
     * fall back to the row id, which means their profile covers that row alone.
     *
     * Returns null for a deck that does not exist. Ownership is NOT checked
     * here: the caller decides who may ask, because a shared deck is legitimately
     * readable by more than its importer.
     */
    async resolveDeck(deckId) {
        const rows = await this.safeQuery(
            'SELECT "Id", "Uuid", "Name", "UserId" FROM "Decks" WHERE "Id" = $1',
            [deckId],
            'resolveDeck'
        );

        const row = rows && rows[0];

        if (!row) {
            return null;
        }

        return {
            id: row.Id,
            uuid: row.Uuid,
            name: row.Name,
            userId: row.UserId,
            pooled: !!row.Uuid,
            predicate: row.Uuid ? 'gp."DeckUuid" = $1' : 'gp."DeckId" = $1',
            param: row.Uuid || row.Id
        };
    }

    /** The deck's overall record, on the same games the bands are cut from. */
    async deckRecord(deck) {
        if (!deck) {
            return null;
        }

        const rows = await this.safeQuery(
            'SELECT COUNT(*)::int AS "games", ' +
                '  COUNT(*) FILTER (WHERE g."WinnerId" = gp."PlayerId")::int AS "wins" ' +
                'FROM "GamePlayers" gp ' +
                'JOIN "Games" g ON g."Id" = gp."GameId" ' +
                `WHERE ${deck.predicate} AND ${DECIDED}`,
            [deck.param],
            'deckRecord'
        );

        const row = (rows && rows[0]) || { games: 0, wins: 0 };

        return {
            games: row.games,
            wins: row.wins,
            losses: row.games - row.wins,
            winRate: row.games ? row.wins / row.games : null
        };
    }

    /**
     * ARCHON: what this deck is good against, and what beats it.
     *
     * Every trait, banded the same site-wide way as everywhere else, with the
     * bands the deck over- and under-performs its OWN average in. The baseline
     * matters: measured against the site the answer would mostly restate which
     * decks are strong, and the player already knows this deck's overall win
     * rate. Measured against itself it says something they cannot see - this
     * deck does better than it usually does when the other side is short on
     * creature control.
     *
     * The bar for saying anything at all is deliberately high, and it is the
     * same bar `findings` uses at player level:
     *
     *   - both the band and the deck's overall record must clear
     *     MIN_CONFIDENT_GAMES, so a 100% record over two games is never a
     *     headline;
     *   - the edge must be at least MIN_EDGE, because five points is noise
     *     dressed as a finding.
     *
     * A deck with too few games gets `bands` and an empty good/bad list rather
     * than an invented story, and the caller is told how many games short it is.
     */
    async deckStrategyProfile(deckId, { minGames = MIN_CONFIDENT_GAMES } = {}) {
        const deck = await this.resolveDeck(deckId);

        if (!deck) {
            return null;
        }

        const record = await this.deckRecord(deck);
        const threshold = Math.max(1, Number(minGames) || MIN_CONFIDENT_GAMES);
        const traits = [];

        for (const trait of TRAITS) {
            const result = await this.deckByOpponentTrait(deck, trait.key);

            if (result) {
                traits.push({ ...trait, ...result });
            }
        }

        const goodAgainst = [];
        const badAgainst = [];

        if (record && record.games >= threshold && record.winRate !== null) {
            for (const trait of traits) {
                for (const band of trait.bands) {
                    if (band.games < threshold || band.winRate === null) {
                        continue;
                    }

                    const edge = band.winRate - record.winRate;

                    if (Math.abs(edge) < MIN_EDGE) {
                        continue;
                    }

                    const entry = {
                        trait: trait.key,
                        label: trait.label,
                        short: trait.short,
                        band: band.band,
                        from: band.from,
                        to: band.to,
                        games: band.games,
                        wins: band.wins,
                        losses: band.losses,
                        winRate: band.winRate,
                        edge
                    };

                    (edge > 0 ? goodAgainst : badAgainst).push(entry);
                }
            }
        }

        goodAgainst.sort((a, b) => b.edge - a.edge);
        badAgainst.sort((a, b) => a.edge - b.edge);

        return {
            deck: { id: deck.id, uuid: deck.uuid, name: deck.name, pooled: deck.pooled },
            record,
            // What the reader needs to know before believing any of it.
            threshold,
            enoughGames: !!record && record.games >= threshold,
            gamesShort: record ? Math.max(0, threshold - record.games) : threshold,
            traits,
            goodAgainst,
            badAgainst
        };
    }
}

module.exports = AercAnalyticsService;
module.exports.TRAITS = TRAITS;
module.exports.BANDS = BANDS;
module.exports.MIN_CONFIDENT_GAMES = MIN_CONFIDENT_GAMES;
