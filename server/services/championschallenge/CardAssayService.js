const logger = require('../../log');
const { wilsonInterval } = require('./labMath');
const { getCardIndex, cloneCard } = require('./packCards');

/**
 * ARCHON (N44): the assay - card knowledge from measurement, not estimation.
 *
 * Every card number this platform has carried so far was somebody's
 * ESTIMATE: DoK's curators, the LLM's priors and tags, the model's own
 * outcome-trained weights. The assay is the instrument that can settle
 * arguments between them, because a simulator that executes real card code
 * under deterministic seeds can measure what everyone else guesses at.
 *
 * Phase 1 - MINE (free). An incremental walker over the training diary
 * aggregates, per card actually played, games and wins - and the same for
 * pairs the synergy tags hypothesize about, when both halves saw play on
 * the same side of the same game. Deep-search and teacher lesson rows are
 * skipped: a rolled-out candidate road is not a play, and counting rejected
 * roads as plays would poison the record. Observational and confounded by
 * deck quality, so it is treated as prior-grade evidence: it AUDITS the
 * synergy tags (a claimed combo whose measured lift runs negative gets
 * flagged for the advisor), it does not convict.
 *
 * Phase 2 - EXPERIMENT (CPU, zero tokens). One experiment at a time, a few
 * games per sweep: two synthetic decks identical except for one card - the
 * target versus a duplicate of a filler from the same house - head to head,
 * paired seeds, the champion piloting both seats greedily. The target arm's
 * win rate IS the card's marginal value, measured causally, and the Wilson
 * interval says how settled the number is. With a partner card seated in
 * both hosts, the same instrument measures the card WITH its combo
 * available; the difference against its neutral experiment is the synergy,
 * in win percentage. Fixed budgets rather than verdicts on purpose: one
 * card in thirty-six rarely moves a game ten points, so the deliverable is
 * the measurement, not a promotion.
 *
 * The honest caveat, built into the shape of the data: fidelity is capped
 * by the champion's play quality, so measurements carry timestamps and
 * re-measuring under a stronger champion is expected. The assay is a
 * flywheel, not a one-time census.
 */

/** Diary rows folded into the aggregates per sweep tick. */
const MINE_BATCH = 200;

/** Observed games a pair needs before its lift is worth an audit flag. */
const AUDIT_MIN_GAMES = 30;

/** Cap on how many observed-pair rows the miner will keep admitting. */
const MAX_PAIR_ROWS = 20000;

class CardAssayService {
    /**
     * @param {object} [db]
     * @param {object} [deps] injectable for tests
     * @param {object} [deps.policyService] champion supplier (BotPolicyService)
     * @param {function} [deps.runMatch] (deckA, deckB, options) => result
     * @param {function} [deps.newSeed] deterministic-game seed supplier
     * @param {function} [deps.synergiesFor] cardTraits.synergiesFor
     * @param {function} [deps.cardIndex] () => the pack card index
     */
    constructor(
        db = require('../../db'),
        {
            policyService = null,
            runMatch = null,
            newSeed = null,
            synergiesFor = require('./cardTraits').synergiesFor,
            cardIndex = getCardIndex
        } = {}
    ) {
        this.db = db;
        this.policyService = policyService;
        this.runMatch = runMatch;
        this.newSeed = newSeed;
        this.synergiesFor = synergiesFor;
        this.cardIndex = cardIndex;
    }

    /**
     * One sweep's worth of assay work: fold fresh diary games into the
     * observed aggregates, then spend the experiment budget. Every failure
     * path degrades to "measured nothing this tick".
     */
    async sweepStep(config) {
        try {
            await this.minePendingGames();
        } catch (err) {
            logger.error('Card assay: mining failed', err);
        }

        const budget = Math.max(0, parseInt(config.assayGamesPerSweep, 10) || 0);

        if (budget > 0) {
            try {
                await this.runExperimentStep(config, budget);
            } catch (err) {
                logger.error('Card assay: experiment step failed', err);
            }
        }
    }

    /**
     * Phase 1: walk the diary forward from the cursor and aggregate.
     *
     * A "play" is a decision row carrying a cardId and NO explicit target or
     * weight - lesson rows (deep search, teacher) describe candidate roads,
     * most of them deliberately not taken.
     */
    async minePendingGames(batch = MINE_BATCH) {
        const state = await this.db.query(
            'SELECT "MinedThroughDiaryId" FROM "ChallengeAssayState" WHERE "Id" = 1'
        );
        const cursor = (state && state[0] && state[0].MinedThroughDiaryId) || 0;
        const rows = await this.db.query(
            'SELECT "Id", "WinnerSide", "Decisions" FROM "BotTrainingGames" ' +
                'WHERE "Id" > $1 ORDER BY "Id" LIMIT $2',
            [cursor, batch]
        );

        if (!rows || !rows.length) {
            return 0;
        }

        const cards = new Map(); // id -> { games, wins }
        const pairs = new Map(); // 'a|b' -> { a, b, games, wins }
        const bump = (map, key, seed, won) => {
            const entry = map.get(key) || { ...seed, games: 0, wins: 0 };

            entry.games++;
            entry.wins += won ? 1 : 0;
            map.set(key, entry);
        };

        for (const row of rows) {
            const bySide = new Map();

            for (const decision of row.Decisions || []) {
                if (
                    !decision ||
                    !decision.cardId ||
                    !decision.side ||
                    typeof decision.target === 'number' ||
                    typeof decision.weight === 'number'
                ) {
                    continue;
                }

                if (!bySide.has(decision.side)) {
                    bySide.set(decision.side, new Set());
                }

                bySide.get(decision.side).add(decision.cardId);
            }

            for (const [side, played] of bySide) {
                const won = side === row.WinnerSide;
                const ids = [...played].sort();

                for (const id of ids) {
                    bump(cards, id, {}, won);
                }

                for (let i = 0; i < ids.length; i++) {
                    for (let j = i + 1; j < ids.length; j++) {
                        if (this.hypothesized(ids[i], ids[j])) {
                            bump(pairs, `${ids[i]}|${ids[j]}`, { a: ids[i], b: ids[j] }, won);
                        }
                    }
                }
            }
        }

        if (cards.size) {
            const ids = [...cards.keys()];

            await this.db.query(
                'INSERT INTO "ChallengeCardObserved" ("CardId", "Games", "Wins") ' +
                    'SELECT * FROM unnest($1::text[], $2::int[], $3::int[]) ' +
                    'ON CONFLICT ("CardId") DO UPDATE SET ' +
                    '"Games" = "ChallengeCardObserved"."Games" + EXCLUDED."Games", ' +
                    '"Wins" = "ChallengeCardObserved"."Wins" + EXCLUDED."Wins"',
                [ids, ids.map((id) => cards.get(id).games), ids.map((id) => cards.get(id).wins)]
            );
        }

        if (pairs.size) {
            const admitted = await this.db.query(
                'SELECT COUNT(*)::int AS "Count" FROM "ChallengeCardPairObserved"'
            );

            if (((admitted && admitted[0] && admitted[0].Count) || 0) < MAX_PAIR_ROWS) {
                const entries = [...pairs.values()];

                await this.db.query(
                    'INSERT INTO "ChallengeCardPairObserved" ("CardA", "CardB", "Games", "Wins") ' +
                        'SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::int[]) ' +
                        'ON CONFLICT ("CardA", "CardB") DO UPDATE SET ' +
                        '"Games" = "ChallengeCardPairObserved"."Games" + EXCLUDED."Games", ' +
                        '"Wins" = "ChallengeCardPairObserved"."Wins" + EXCLUDED."Wins"',
                    [
                        entries.map((entry) => entry.a),
                        entries.map((entry) => entry.b),
                        entries.map((entry) => entry.games),
                        entries.map((entry) => entry.wins)
                    ]
                );
            }
        }

        await this.db.query(
            'INSERT INTO "ChallengeAssayState" ("Id", "MinedThroughDiaryId") VALUES (1, $1) ' +
                'ON CONFLICT ("Id") DO UPDATE SET "MinedThroughDiaryId" = EXCLUDED."MinedThroughDiaryId"',
            [rows[rows.length - 1].Id]
        );

        return rows.length;
    }

    /** Do the synergy tags claim these two cards want each other? */
    hypothesized(idA, idB) {
        const a = this.synergiesFor(idA);
        const b = this.synergiesFor(idB);

        if (!a || !b) {
            return false;
        }

        return (
            a.wants.some((tag) => b.provides.includes(tag)) ||
            b.wants.some((tag) => a.provides.includes(tag))
        );
    }

    /**
     * Phase 2: continue (or start) the current experiment with up to
     * `budget` games this sweep.
     */
    async runExperimentStep(config, budget) {
        let experiment = await this.currentExperiment();

        if (!experiment) {
            experiment = await this.startNextExperiment();
        }

        if (!experiment) {
            return;
        }

        const decks = this.assayDecks(
            experiment.CardId,
            experiment.ReplacementCardId,
            experiment.PartnerCardId
        );

        if (!decks) {
            // The pool changed under a running experiment (a set removed, an
            // id renamed). Abandon rather than measure the wrong thing.
            await this.db.query(
                'UPDATE "ChallengeCardExperiments" SET "Status" = \'abandoned\' WHERE "Id" = $1',
                [experiment.Id]
            );

            return;
        }

        const perExperiment = Math.max(40, parseInt(config.assayGamesPerExperiment, 10) || 120);
        const champion = this.policyService ? await this.policyService.champion() : null;
        let games = experiment.Games;
        let wins = experiment.Wins;
        let played = 0;

        while (played < budget && games < perExperiment) {
            const seed = this.newSeed();
            // Paired seeds, seats swapped - the arena's instrument. What
            // survives the pair is the difference between the decks, and the
            // decks differ by exactly one card. The pair commits ATOMICALLY:
            // an abandoned half would leave an unpaired game in the record,
            // which is exactly the noise pairing exists to remove.
            let pairGames = 0;
            let pairWins = 0;
            let aborted = false;

            for (const targetIsAlpha of [true, false]) {
                const result = await this.runMatch(
                    targetIsAlpha ? decks.target : decks.control,
                    targetIsAlpha ? decks.control : decks.target,
                    {
                        seed,
                        maxTurns: config.maxTurnsPerGame,
                        policy: champion,
                        temperature: 0,
                        recordDecisions: false
                    }
                );

                if (!result || !result.completed) {
                    aborted = true;
                    break;
                }

                // Seat-independent: the winning DECK names the winning arm.
                const targetWon =
                    !!result.winnerDeck && result.winnerDeck.uuid === decks.target.uuid;

                pairGames++;
                pairWins += targetWon ? 1 : 0;
            }

            if (aborted) {
                break;
            }

            games += pairGames;
            wins += pairWins;
            played += pairGames;
        }

        const finished = games >= perExperiment;

        await this.db.query(
            'UPDATE "ChallengeCardExperiments" SET "Games" = $2, "Wins" = $3' +
                (finished
                    ? ', "Status" = \'measured\', "MeasuredAt" = now() AT TIME ZONE \'utc\''
                    : '') +
                ' WHERE "Id" = $1',
            [experiment.Id, games, wins]
        );

        if (finished) {
            logger.info(
                `Card assay: measured ${experiment.CardId}` +
                    (experiment.PartnerCardId ? ` with ${experiment.PartnerCardId}` : '') +
                    ` at ${wins}/${games} vs ${experiment.ReplacementCardId}`
            );
        }
    }

    async currentExperiment() {
        const rows = await this.db.query(
            'SELECT "Id", "CardId", "PartnerCardId", "ReplacementCardId", "Games", "Wins" ' +
                'FROM "ChallengeCardExperiments" WHERE "Status" = \'running\' ' +
                'ORDER BY "Id" LIMIT 1'
        );

        return rows && rows[0] ? rows[0] : null;
    }

    /**
     * Choose what to measure next: hypothesized PAIRS whose payoff already
     * has a neutral measurement take priority (the synergy question needs
     * both numbers), then the most-played card never measured. Nothing to
     * measure is a normal state.
     */
    async startNextExperiment() {
        const pick = (await this.nextPairTarget()) || (await this.nextCardTarget());

        if (!pick) {
            return null;
        }

        const decks = this.assayDecks(pick.cardId, null, pick.partnerId || null);

        if (!decks) {
            return null;
        }

        const inserted = await this.db.query(
            'INSERT INTO "ChallengeCardExperiments" ' +
                '("CardId", "PartnerCardId", "ReplacementCardId", "CreatedAt") ' +
                'VALUES ($1, $2, $3, now() AT TIME ZONE \'utc\') RETURNING "Id"',
            [pick.cardId, pick.partnerId || null, decks.replacementId]
        );

        return {
            Id: inserted[0].Id,
            CardId: pick.cardId,
            PartnerCardId: pick.partnerId || null,
            ReplacementCardId: decks.replacementId,
            Games: 0,
            Wins: 0
        };
    }

    /** The most co-played hypothesized pair whose synergy is still unmeasured. */
    async nextPairTarget() {
        const pairs = await this.db.query(
            'SELECT "CardA", "CardB", "Games" FROM "ChallengeCardPairObserved" ' +
                'ORDER BY "Games" DESC LIMIT 50'
        );

        for (const pair of pairs || []) {
            for (const [cardId, partnerId] of [
                [pair.CardA, pair.CardB],
                [pair.CardB, pair.CardA]
            ]) {
                const synergy = this.synergiesFor(cardId);

                if (!synergy || !synergy.wants.length) {
                    continue;
                }

                const partner = this.synergiesFor(partnerId);

                if (!partner || !synergy.wants.some((tag) => partner.provides.includes(tag))) {
                    continue;
                }

                // The synergy delta needs the payoff's neutral number first,
                // and the pair itself must not already be measured or running.
                const done = await this.db.query(
                    'SELECT ' +
                        'COUNT(*) FILTER (WHERE "PartnerCardId" IS NULL AND "Status" = \'measured\' AND "CardId" = $1)::int AS "Neutral", ' +
                        'COUNT(*) FILTER (WHERE "PartnerCardId" = $2 AND "CardId" = $1)::int AS "Together" ' +
                        'FROM "ChallengeCardExperiments"',
                    [cardId, partnerId]
                );

                if (done && done[0] && done[0].Neutral > 0 && done[0].Together === 0) {
                    return { cardId, partnerId };
                }
            }
        }

        return null;
    }

    /** The most-played card with no experiment on record. */
    async nextCardTarget() {
        const rows = await this.db.query(
            'SELECT o."CardId" FROM "ChallengeCardObserved" o ' +
                'WHERE NOT EXISTS (SELECT 1 FROM "ChallengeCardExperiments" e ' +
                'WHERE e."CardId" = o."CardId" AND e."PartnerCardId" IS NULL) ' +
                'ORDER BY o."Games" DESC LIMIT 25'
        );

        for (const row of rows || []) {
            if (this.assayDecks(row.CardId)) {
                return { cardId: row.CardId };
            }
        }

        return null;
    }

    /**
     * The instrument itself: two engine-ready decks identical except that
     * the target's slot holds the target in one arm and a DUPLICATE of the
     * first filler in the other (duplicates are legal in KeyForge). With a
     * partner, both arms carry it, so the target is measured with its combo
     * available. Deterministic for a given (card, replacement, partner), so
     * an experiment resumed next sweep plays the same decks.
     */
    assayDecks(cardId, replacementId = null, partnerId = null) {
        const index = this.cardIndex();
        const target = index[cardId];
        const partner = partnerId ? index[partnerId] : null;
        const playable = (card) =>
            card &&
            card.house &&
            !card.isNonDeck &&
            ['creature', 'artifact', 'action', 'upgrade'].includes(card.type);

        if (!playable(target) || (partnerId && !playable(partner))) {
            return null;
        }

        // Three houses: the target's, the partner's when it differs, and
        // fixed companions to fill the slate.
        const houses = [target.house];

        if (partner && !houses.includes(partner.house)) {
            houses.push(partner.house);
        }

        for (const house of ['brobnar', 'dis', 'logos', 'sanctum', 'shadows', 'untamed']) {
            if (houses.length < 3 && !houses.includes(house)) {
                houses.push(house);
            }
        }

        const byHouse = {};

        for (const card of Object.values(index)) {
            if (
                playable(card) &&
                houses.includes(card.house) &&
                card.id !== cardId &&
                card.id !== partnerId
            ) {
                (byHouse[card.house] = byHouse[card.house] || []).push(card);
            }
        }

        const entry = (id) => ({ id, count: 1, card: cloneCard(id) });
        const build = (name, targetSlotId) => {
            const cards = [];

            for (const house of houses) {
                const pool = byHouse[house] || [];

                if (pool.length < 12) {
                    return null;
                }

                const slots = [];

                for (let i = 0; i < 12; i++) {
                    slots.push(pool[(i * 5) % pool.length].id);
                }

                // The target (or its stand-in) takes the last slot of its
                // house; the partner takes the second-to-last of its own.
                if (house === target.house) {
                    slots[11] = targetSlotId;
                }

                if (partner && house === partner.house) {
                    slots[house === target.house ? 10 : 11] = partner.id;
                }

                for (const id of slots) {
                    cards.push(entry(id));
                }
            }

            return { name, uuid: `assay-${name}`, expansion: 341, houses, cards };
        };

        const pool = byHouse[target.house] || [];

        if (!pool.length) {
            return null;
        }

        const replacement = replacementId || pool[0].id;
        const targetDeck = build('Assay Target', cardId);
        const controlDeck = build('Assay Control', replacement);

        if (!targetDeck || !controlDeck) {
            return null;
        }

        return { target: targetDeck, control: controlDeck, replacementId: replacement };
    }

    /**
     * The read layer, for the advisor packet and the curious: what the
     * mining has observed, what the experiments have measured, and where
     * the measurements argue with the synergy tags.
     */
    async report({ minGames = AUDIT_MIN_GAMES } = {}) {
        try {
            const [observed, pairRows, experiments] = await Promise.all([
                this.db.query(
                    'SELECT "CardId", "Games", "Wins" FROM "ChallengeCardObserved" ' +
                        'WHERE "Games" >= $1 ORDER BY "Games" DESC LIMIT 400',
                    [minGames]
                ),
                this.db.query(
                    'SELECT "CardA", "CardB", "Games", "Wins" FROM "ChallengeCardPairObserved" ' +
                        'WHERE "Games" >= $1 ORDER BY "Games" DESC LIMIT 100',
                    [minGames]
                ),
                this.db.query(
                    'SELECT "CardId", "PartnerCardId", "ReplacementCardId", "Games", "Wins", ' +
                        '"MeasuredAt" FROM "ChallengeCardExperiments" ' +
                        'WHERE "Status" = \'measured\' ORDER BY "Id" DESC LIMIT 60'
                )
            ]);
            const index = this.cardIndex();
            const nameOf = (id) => (index[id] && index[id].name) || id;
            const rateOf = new Map(
                (observed || []).map((row) => [row.CardId, row.Wins / Math.max(1, row.Games)])
            );
            const withRate = (row) => ({
                card: nameOf(row.CardId),
                games: row.Games,
                ...wilsonInterval(row.Wins, row.Games)
            });
            const ranked = (observed || []).map(withRate);
            const measured = (experiments || []).map((row) => ({
                card: nameOf(row.CardId),
                with: row.PartnerCardId ? nameOf(row.PartnerCardId) : null,
                insteadOf: nameOf(row.ReplacementCardId),
                games: row.Games,
                measuredAt: row.MeasuredAt,
                ...wilsonInterval(row.Wins, row.Games)
            }));
            // The audit: hypothesized pairs whose OBSERVED lift argues with
            // the tags. Lift compares the pair's rate to its halves' average;
            // prior-grade, so only clear contradictions are flagged.
            const audit = (pairRows || [])
                .filter((row) => rateOf.has(row.CardA) && rateOf.has(row.CardB))
                .map((row) => {
                    const together = row.Wins / Math.max(1, row.Games);
                    const apart = (rateOf.get(row.CardA) + rateOf.get(row.CardB)) / 2;

                    return {
                        pair: `${nameOf(row.CardA)} + ${nameOf(row.CardB)}`,
                        games: row.Games,
                        together: Math.round(together * 1000) / 1000,
                        apart: Math.round(apart * 1000) / 1000,
                        lift: Math.round((together - apart) * 1000) / 1000
                    };
                })
                .sort((left, right) => left.lift - right.lift);

            return {
                observedCards: {
                    // Ranked by the interval's cautious end - the hidden-gem
                    // badge's own conservatism: strongest by the LOW bound,
                    // weakest by the HIGH one, so small samples cannot brag.
                    strongest: [...ranked].sort((left, right) => right.low - left.low).slice(0, 15),
                    weakest: [...ranked].sort((left, right) => left.high - right.high).slice(0, 15)
                },
                measured,
                tagAudit: {
                    contradicted: audit.filter((row) => row.lift < -0.05).slice(0, 15),
                    confirmed: audit
                        .filter((row) => row.lift > 0.05)
                        .slice(-15)
                        .reverse()
                }
            };
        } catch (err) {
            logger.error('Card assay: could not build the report', err);

            return { observedCards: null, measured: [], tagAudit: null };
        }
    }
}

module.exports = CardAssayService;
