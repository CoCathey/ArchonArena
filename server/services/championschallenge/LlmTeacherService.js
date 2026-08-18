const logger = require('../../log');
const { decisionRecord } = require('./labFeatures');
const { sectionDefaults } = require('../settings/registry');

/**
 * ARCHON (N38): the AI teacher - a third teacher for the learning loop, on a
 * token budget measured in cents.
 *
 * The loop already has two teachers. Outcomes are free and plentiful but
 * noisy: a label says "this move appeared in a game somebody won". The deep
 * bot's search is measured but expensive CPU, and it can only value what the
 * fast policy's rollouts can reach. A language model brings the one thing
 * neither has - it can READ the cards - so it slots in as a rare, deliberate
 * reviewer rather than a player: it never sits in the per-game loop, and a
 * week of its coaching costs less than a cup of anything.
 *
 * The shape of it:
 *
 *  - **Capture is free.** While sparring games play, a sampler quietly keeps
 *    a handful of positions a day (a readable board summary plus every legal
 *    candidate as a decision record). Deep games contribute positions WITH
 *    the search's measured win probability per candidate.
 *  - **Review is the spend.** A weekly budget of positions goes to the model,
 *    which scores every candidate's chance of winning. One position is one
 *    small request; the whole week is tens of thousands of tokens.
 *  - **Calibration is the licence.** Positions the deep bot measured are the
 *    exam: the teacher's picks are compared with the search's measurements,
 *    and only while its recent agreement clears the admin's bar do its
 *    reviews of UNmeasured positions become training lessons. An unproven
 *    (or drifting) teacher is quietly kept on exam duty. This is the same
 *    conservatism the title fight applies to candidates, applied to the
 *    teacher itself - and behind it stands the arena anyway: lessons only
 *    ever shape a CANDIDATE, and no candidate takes the champion's place
 *    without beating it under the sequential test.
 *  - **Lessons are ordinary diary rows.** Each taught candidate becomes a
 *    decision with an explicit target and its own gradient weight
 *    (labPolicy), so training, arena and promotion need nothing new.
 *
 * Everything degrades to off: no API key, the admin switch, a zero budget,
 * or any API failure just means the loop learns the way it always did.
 */

/** The table is a working set like the diary, not an archive. */
const KEEP_POSITIONS = 500;

/** Recent calibration reviews the teaching licence is judged over. */
const CALIBRATION_WINDOW = 50;

/** Calibration reviews required before teaching can start at all. */
const MIN_CALIBRATION = 10;

/** Reviews per sweep tick, so the weekly budget trickles rather than bursts. */
const REVIEWS_PER_RUN = 5;

/**
 * Sparring games rotate which eligible decision gets captured, so the table
 * holds a spread of game phases rather than a pile of first house calls.
 */
const ROTATION = 4;

/** Room for adaptive thinking plus the scores; typical use is far less. */
const MAX_TOKENS = 4000;

const RUBRIC = [
    'You are an expert competitive KeyForge player reviewing positions from',
    'simulated games. You are shown one position - the board as the acting',
    'player sees it - and the legal candidate moves. For EACH candidate,',
    'estimate the probability (0.00-1.00) that the ACTING player goes on to',
    'win the game if they make that move and both sides play reasonably',
    'afterward.',
    '',
    'KeyForge essentials: the first player to forge three keys wins; a key is',
    'forged at the start of your turn by paying its cost (usually 6 amber);',
    'reaping with a creature gains 1 amber; fighting trades tempo for board',
    'control; the called house limits which cards may act this turn; amber can',
    'be stolen and captured. Racing amber and denying the opponent the turn',
    'they would forge are usually what decide games.',
    '',
    'Score every candidate, keyed by its index. Differences between candidates',
    'are the point - rank them honestly rather than clustering at 0.5.'
].join('\n');

const SCORES_SCHEMA = {
    type: 'object',
    properties: {
        scores: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    index: { type: 'integer' },
                    winProbability: { type: 'number' }
                },
                required: ['index', 'winProbability'],
                additionalProperties: false
            }
        }
    },
    required: ['scores'],
    additionalProperties: false
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));

/** The showcase labels, shared with DeepGame's annotations. */
function describeCandidate(candidate) {
    if (!candidate) {
        return 'unknown';
    }

    if (candidate.kind === 'houseCall' || candidate.house) {
        return `call ${candidate.house}`;
    }

    if (candidate.kind === 'select') {
        const name = candidate.card ? candidate.card.name || candidate.card.id : 'a card';

        return `target ${name}`;
    }

    const verbs = {
        playCreature: 'play',
        playArtifact: 'play',
        playAction: 'play',
        playUpgrade: 'play',
        reap: 'reap with',
        fight: 'fight with',
        useAbility: 'use',
        discard: 'discard'
    };
    const name = candidate.card ? candidate.card.name || candidate.card.id : 'a card';

    return `${verbs[candidate.kind] || candidate.kind} ${name}`;
}

/** One seat, in the plain terms the reviewer's prompt is rendered from. */
function seatSummary(player, withHand) {
    if (!player) {
        return null;
    }

    const summary = {
        amber: player.amber || 0,
        keys: typeof player.getForgedKeys === 'function' ? player.getForgedKeys() : 0,
        keyCost: typeof player.getCurrentKeyCost === 'function' ? player.getCurrentKeyCost() : 6,
        creatures: (player.creaturesInPlay || []).map((card) => ({
            name: card.name || card.id,
            power: card.power || 0,
            exhausted: !!card.exhausted
        })),
        artifacts: (player.cardsInPlay || [])
            .filter((card) => card.type === 'artifact')
            .map((card) => card.name || card.id),
        handCount: (player.hand || []).length,
        deckCount: (player.deck || []).length,
        discardCount: (player.discard || []).length,
        archivesCount: (player.archives || []).length
    };

    // Only the deciding seat's hand: the summary keeps to what that player
    // could see, the same fairness contract the features live by.
    if (withHand) {
        summary.hand = (player.hand || []).map((card) => card.name || card.id);
    }

    return summary;
}

class LlmTeacherService {
    /**
     * @param {object} configService file config (the `anthropic` section)
     * @param {object} [db]
     * @param {object} [settingsService]
     * @param {object} [deps] injectable for tests
     * @param {object} [deps.policyService] the diary door (BotPolicyService)
     * @param {object} [deps.client] a Claude client with messages.create
     */
    constructor(
        configService,
        db = require('../../db'),
        settingsService = require('../settings'),
        { policyService = null, client = null } = {}
    ) {
        this.configService = configService;
        this.db = db;
        this.settingsService = settingsService;
        this.policyService = policyService;
        this.injectedClient = client;
        this.lazyClient = null;
        this.rotation = 0;
    }

    /** The admin's challenge knobs, defaults composed the settings way. */
    challengeSection() {
        try {
            return {
                ...sectionDefaults('championsChallenge'),
                ...((this.settingsService.getSection &&
                    this.settingsService.getSection('championsChallenge')) ||
                    {})
            };
        } catch (err) {
            logger.error('Challenge AI teacher: could not read settings', err);

            return {};
        }
    }

    /** File config: the key and model. Key comes from ANTHROPIC_API_KEY. */
    anthropicConfig() {
        const config =
            (this.configService &&
                this.configService.getValue &&
                this.configService.getValue('anthropic')) ||
            {};

        return {
            apiKey: config.apiKey || '',
            model: config.model || 'claude-opus-5',
            requestTimeoutMs: parseInt(config.requestTimeoutMs, 10) || 60000
        };
    }

    /** On only when the admin switched it on AND a key exists to spend. */
    isEnabled() {
        return (
            this.challengeSection().llmTeacherEnabled === true &&
            (!!this.anthropicConfig().apiKey || !!this.injectedClient)
        );
    }

    client() {
        if (this.injectedClient) {
            return this.injectedClient;
        }

        if (!this.lazyClient) {
            // Loaded on first use: the lobby must not pay for an SDK the
            // teacher may never be switched on to spend.
            const Anthropic = require('@anthropic-ai/sdk');
            const config = this.anthropicConfig();

            this.lazyClient = new Anthropic({
                apiKey: config.apiKey,
                timeout: config.requestTimeoutMs,
                maxRetries: 1
            });
        }

        return this.lazyClient;
    }

    /**
     * Today's capture budget, shared by every sampler this sweep creates.
     *
     * Calibration positions get at most half of it: deep games run early in
     * a roster's day, and without the cap they would fill the whole budget
     * before a single sparring position - the teachable kind - was kept.
     */
    async captureBudget() {
        const section = this.challengeSection();
        const perDay = Math.max(0, parseInt(section.llmPositionsPerDay, 10) || 0);

        if (!perDay) {
            return { remaining: 0, deepRemaining: 0 };
        }

        try {
            const rows = await this.db.query(
                'SELECT COUNT(*)::int AS "Count", ' +
                    'COUNT(*) FILTER (WHERE "DeepTargets" IS NOT NULL)::int AS "Deep" ' +
                    'FROM "ChallengeLlmPositions" ' +
                    "WHERE \"CreatedAt\" >= date_trunc('day', now() AT TIME ZONE 'utc')"
            );
            const used = (rows && rows[0] && rows[0].Count) || 0;
            const deepUsed = (rows && rows[0] && rows[0].Deep) || 0;

            return {
                remaining: Math.max(0, perDay - used),
                deepRemaining: Math.max(0, Math.ceil(perDay / 2) - deepUsed)
            };
        } catch (err) {
            logger.error('Challenge AI teacher: could not read the capture budget', err);

            return { remaining: 0, deepRemaining: 0 };
        }
    }

    /**
     * A per-game sampler. `budget` is shared across the sweep
     * ({ remaining: n }); each capture spends one. The sampler buffers in
     * memory and only `flush(winnerSide)` - called once the game completed -
     * writes anything, so an abandoned game records nothing.
     *
     * `analyzer` fits SimulatedGame's analyzer hook (always answers null, so
     * the policy still makes every move); `deepRecorder` fits DeepGame's
     * positionRecorder hook and keeps the search's measured targets.
     */
    gameSampler({ policyVersion = null, budget }) {
        const service = this;
        const target = this.rotation;
        const buffered = [];
        let eligibleSeen = 0;

        this.rotation = (this.rotation + 1) % ROTATION;

        // Deep thought's own eligibility rule, reused: house calls always,
        // board decisions when a forge is close, anything in the opening.
        const eligible = (game, player, kind) => {
            if (kind === 'house') {
                return true;
            }

            const near = (side) => side && side.amber >= Math.max(0, side.getCurrentKeyCost() - 3);

            return near(player) || near(player.opponent) || (game.round || 0) <= 2;
        };

        const capture = (game, player, kind, candidates, deepTargets) => {
            if (budget.remaining <= 0 || buffered.length > 0 || candidates.length < 2) {
                return;
            }

            if (deepTargets && budget.deepRemaining <= 0) {
                return;
            }

            try {
                buffered.push({
                    policyVersion,
                    summary: {
                        round: game.round || 0,
                        side: player.name,
                        kind,
                        prompt:
                            (candidates[0] &&
                                candidates[0].prompt &&
                                String(candidates[0].prompt)) ||
                            null,
                        me: seatSummary(player, true),
                        them: seatSummary(player.opponent, false)
                    },
                    candidates: candidates.map((candidate) => ({
                        label: describeCandidate(candidate),
                        record: decisionRecord(game, player, {
                            kind: candidate.kind,
                            card: candidate.card,
                            house: candidate.house,
                            prompt: candidate.prompt,
                            player
                        })
                    })),
                    deepTargets: deepTargets || null
                });
                budget.remaining--;

                if (deepTargets) {
                    budget.deepRemaining--;
                }
            } catch (err) {
                // A sampler must never cost the game it is watching.
                logger.error('Challenge AI teacher: failed to capture a position', err);
            }
        };

        return {
            /** SimulatedGame analyzer: watch, maybe keep, never steer. */
            analyzer: async ({ game, player, kind, candidates }) => {
                if (budget.remaining > 0 && buffered.length === 0 && eligible(game, player, kind)) {
                    if (eligibleSeen === target) {
                        capture(game, player, kind, candidates, null);
                    }

                    eligibleSeen++;
                }

                return null;
            },

            /**
             * DeepGame positionRecorder: the search just measured these
             * candidates, so the capture keeps record and target together -
             * a calibration position.
             */
            deepRecorder: ({ game, player, kind, candidates, scored }) => {
                const usable = (scored || []).filter(
                    (entry) => entry.winProb !== null && candidates[entry.index]
                );

                if (usable.length < 2) {
                    return;
                }

                capture(
                    game,
                    player,
                    kind,
                    usable.map((entry) => candidates[entry.index]),
                    usable.map((entry) => entry.winProb)
                );
            },

            /** Persist this game's capture, labelled by who won. */
            flush: async (winnerSide) => {
                if (!buffered.length || !winnerSide) {
                    return 0;
                }

                try {
                    for (const position of buffered) {
                        await service.db.query(
                            'INSERT INTO "ChallengeLlmPositions" ' +
                                '("PolicyVersion", "WinnerSide", "Summary", "Candidates", ' +
                                '"DeepTargets", "CreatedAt") ' +
                                "VALUES ($1, $2, $3, $4, $5, now() AT TIME ZONE 'utc')",
                            [
                                position.policyVersion,
                                winnerSide,
                                JSON.stringify(position.summary),
                                JSON.stringify(position.candidates),
                                position.deepTargets ? JSON.stringify(position.deepTargets) : null
                            ]
                        );
                    }

                    // A working set, pruned like the diary: oldest beyond the
                    // cap go, reviewed or not.
                    await service.db.query(
                        'DELETE FROM "ChallengeLlmPositions" WHERE "Id" IN (' +
                            'SELECT "Id" FROM "ChallengeLlmPositions" ' +
                            'ORDER BY "Id" DESC OFFSET $1)',
                        [KEEP_POSITIONS]
                    );

                    return buffered.length;
                } catch (err) {
                    logger.error('Challenge AI teacher: failed to store positions', err);

                    return 0;
                }
            }
        };
    }

    /**
     * The teaching licence: recent calibration agreement, and whether it
     * clears the admin's bar. `topMatch` per review means the teacher's best
     * candidate was also the search's.
     */
    async licence() {
        const section = this.challengeSection();
        const bar = Number(section.llmMinAgreement);
        let rows;

        try {
            rows = await this.db.query(
                'SELECT "Review" FROM "ChallengeLlmPositions" ' +
                    'WHERE "Status" = \'reviewed\' AND "DeepTargets" IS NOT NULL ' +
                    'ORDER BY "ReviewedAt" DESC LIMIT $1',
                [CALIBRATION_WINDOW]
            );
        } catch (err) {
            logger.error('Challenge AI teacher: could not read the licence', err);

            rows = [];
        }

        const reviews = (rows || []).filter((row) => row.Review);
        const matches = reviews.filter((row) => row.Review.topMatch === true).length;
        const agreement = reviews.length ? matches / reviews.length : 0;

        return {
            reviews: reviews.length,
            agreement,
            teaching:
                reviews.length >= MIN_CALIBRATION && agreement >= (Number.isFinite(bar) ? bar : 0.5)
        };
    }

    /** Reviews already spent inside the rolling week - the token budget. */
    async reviewsThisWeek() {
        const rows = await this.db.query(
            'SELECT COUNT(*)::int AS "Count" FROM "ChallengeLlmPositions" ' +
                "WHERE \"ReviewedAt\" >= now() AT TIME ZONE 'utc' - interval '7 days'"
        );

        return (rows && rows[0] && rows[0].Count) || 0;
    }

    /** The reviewer's prompt: the summary rendered in plain sentences. */
    renderPosition(summary, candidates) {
        const lines = [];
        const seat = (label, side) => {
            if (!side) {
                return;
            }

            lines.push(
                `${label}: ${side.amber} amber, ${side.keys} keys forged, ` +
                    `next key costs ${side.keyCost}. ` +
                    `Hand ${side.handCount}, deck ${side.deckCount}, ` +
                    `discard ${side.discardCount}, archives ${side.archivesCount}.`
            );

            if (side.hand) {
                lines.push(`  Hand: ${side.hand.join(', ') || '(empty)'}`);
            }

            const creatures = side.creatures
                .map(
                    (creature) =>
                        `${creature.name} (power ${creature.power}` +
                        `${creature.exhausted ? ', exhausted' : ''})`
                )
                .join(', ');

            lines.push(`  Board: ${creatures || '(no creatures)'}`);

            if (side.artifacts.length) {
                lines.push(`  Artifacts: ${side.artifacts.join(', ')}`);
            }
        };

        lines.push(`Round ${summary.round}. ${summary.side} is deciding.`);

        const decisions = {
            house: 'Decision: which house to call this turn.',
            action: 'Decision: which card to play, use or discard.',
            select: `Decision: choose a target${summary.prompt ? ` for "${summary.prompt}"` : ''}.`
        };

        lines.push(decisions[summary.kind] || 'Decision.');
        seat(`Acting player (${summary.side})`, summary.me);
        seat('Opponent', summary.them);
        lines.push('');
        lines.push('Candidates:');

        candidates.forEach((candidate, index) => {
            lines.push(`  ${index}. ${candidate.label}`);
        });

        return lines.join('\n');
    }

    /** One position to the model; aligned scores back, or a throw. */
    async scorePosition(position) {
        const config = this.anthropicConfig();
        const candidates = position.Candidates || [];
        const response = await this.client().messages.create({
            model: config.model,
            max_tokens: MAX_TOKENS,
            system: RUBRIC,
            messages: [
                { role: 'user', content: this.renderPosition(position.Summary, candidates) }
            ],
            output_config: { format: { type: 'json_schema', schema: SCORES_SCHEMA } }
        });

        // Two failure families, told apart for the caller: `unusable` means
        // the MODEL answered and the answer cannot be used (spend the
        // position); anything else is the API failing (stop the run, the
        // position keeps its turn).
        const unusable = (message) => {
            const err = new Error(message);

            err.unusable = true;

            return err;
        };

        if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
            throw unusable(`review stopped: ${response.stop_reason}`);
        }

        const text = (response.content || [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('');
        let entries;

        try {
            entries = JSON.parse(text).scores || [];
        } catch (err) {
            throw unusable(`unparseable review: ${err.message}`);
        }

        const scores = candidates.map(() => null);

        for (const entry of entries) {
            if (Number.isInteger(entry.index) && entry.index >= 0 && entry.index < scores.length) {
                scores[entry.index] = clamp01(Number(entry.winProbability));
            }
        }

        if (scores.some((score) => score === null || !Number.isFinite(score))) {
            throw unusable('review did not score every candidate');
        }

        return scores;
    }

    /**
     * The scheduled spend: review a few pending positions, newest budget
     * first calibration, then - licence permitting - teaching. Called from
     * the sweep tail; every failure path degrades to "reviewed nothing".
     */
    async reviewPending() {
        if (!this.isEnabled()) {
            return { skipped: 'off' };
        }

        const section = this.challengeSection();
        const perWeek = Math.max(0, parseInt(section.llmReviewsPerWeek, 10) || 0);

        if (!perWeek) {
            return { skipped: 'no-budget' };
        }

        let spent;

        try {
            spent = await this.reviewsThisWeek();
        } catch (err) {
            logger.error('Challenge AI teacher: could not read the weekly budget', err);

            return { skipped: 'budget-unreadable' };
        }

        const chunk = Math.min(REVIEWS_PER_RUN, perWeek - spent);

        if (chunk <= 0) {
            return { skipped: 'budget-spent' };
        }

        const licence = await this.licence();
        // An unproven teacher only sits exams: calibration positions, where
        // the deep bot's measurement can grade the answers. A proven one
        // still sits a trickle of them - a licence must stay earned - but
        // most of the budget goes to positions it can actually teach from.
        const calibrationCap = licence.teaching ? Math.max(1, Math.floor(chunk / 3)) : chunk;
        const fields =
            'SELECT "Id", "PolicyVersion", "WinnerSide", "Summary", "Candidates", "DeepTargets" ' +
            'FROM "ChallengeLlmPositions" WHERE "Status" = \'pending\' ';
        const rows =
            (await this.db.query(fields + 'AND "DeepTargets" IS NOT NULL ORDER BY "Id" LIMIT $1', [
                calibrationCap
            ])) || [];

        if (licence.teaching && rows.length < chunk) {
            const teachable = await this.db.query(
                fields + 'AND "DeepTargets" IS NULL ORDER BY "Id" LIMIT $1',
                [chunk - rows.length]
            );

            rows.push(...(teachable || []));
        }

        const outcome = { reviewed: 0, calibrated: 0, taught: 0, failed: 0 };

        for (const position of rows || []) {
            let scores;

            try {
                scores = await this.scorePosition(position);
            } catch (err) {
                if (err.unusable) {
                    // The model answered and the answer cannot be used: this
                    // position is spent.
                    await this.settle(position.Id, 'failed', { error: String(err.message) });
                    outcome.failed++;
                    continue;
                }

                // An API failure (outage, rate limit): stop the run, leave
                // the rows pending, and let a later sweep try again.
                logger.error('Challenge AI teacher: review call failed; stopping this run', err);
                break;
            }

            const review = { scores };

            if (position.DeepTargets) {
                const targets = position.DeepTargets;
                const best = (values) => values.indexOf(Math.max(...values));

                review.topMatch = best(scores) === best(targets);
                review.meanError =
                    Math.round(
                        (targets.reduce((sum, target, i) => sum + Math.abs(scores[i] - target), 0) /
                            targets.length) *
                            1000
                    ) / 1000;
                outcome.calibrated++;
            } else if (licence.teaching && this.policyService) {
                const weight = Math.max(0, Number(section.llmTargetWeight) || 0);
                const decisions = (position.Candidates || []).map((candidate, index) => ({
                    ...candidate.record,
                    target: scores[index],
                    weight
                }));

                try {
                    await this.policyService.recordTrainingGame(
                        {
                            policyVersion: position.PolicyVersion,
                            winnerSide: position.WinnerSide,
                            decisions
                        },
                        section.trainingGamesKept
                    );
                    review.taught = true;
                    outcome.taught++;
                } catch (err) {
                    logger.error('Challenge AI teacher: could not store a lesson', err);
                }
            }

            await this.settle(position.Id, 'reviewed', review);
            outcome.reviewed++;
        }

        if (outcome.reviewed || outcome.failed) {
            logger.info(
                `Challenge AI teacher: reviewed ${outcome.reviewed} ` +
                    `(${outcome.calibrated} calibration, ${outcome.taught} taught, ` +
                    `${outcome.failed} failed); agreement ` +
                    `${Math.round(licence.agreement * 100)}% over ${licence.reviews} exams` +
                    (licence.teaching ? '' : ' - not yet teaching')
            );
        }

        return outcome;
    }

    /** Mark one position done, best effort. */
    async settle(id, status, review) {
        try {
            await this.db.query(
                'UPDATE "ChallengeLlmPositions" SET "Status" = $2, "Review" = $3, ' +
                    '"ReviewedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
                [id, status, JSON.stringify(review)]
            );
        } catch (err) {
            logger.error('Challenge AI teacher: could not settle a review', err);
        }
    }

    /** The teacher's public vitals, for health pages and curious admins. */
    async vitals() {
        const licence = await this.licence();
        let pending = 0;
        let spent = 0;

        try {
            const rows = await this.db.query(
                'SELECT COUNT(*) FILTER (WHERE "Status" = \'pending\')::int AS "Pending" ' +
                    'FROM "ChallengeLlmPositions"'
            );

            pending = (rows && rows[0] && rows[0].Pending) || 0;
            spent = await this.reviewsThisWeek();
        } catch (err) {
            logger.error('Challenge AI teacher: could not read vitals', err);
        }

        return {
            enabled: this.isEnabled(),
            pending,
            reviewsThisWeek: spent,
            calibrationReviews: licence.reviews,
            agreement: licence.agreement,
            teaching: licence.teaching
        };
    }
}

module.exports = LlmTeacherService;
module.exports.describeCandidate = describeCandidate;
module.exports.seatSummary = seatSummary;
