const LlmTeacherService = require('../../../../server/services/championschallenge/LlmTeacherService');

/**
 * ARCHON (N38): the AI teacher, pinned end to end against fakes.
 *
 * The claims that matter: capture never steers a game and never exceeds its
 * budgets; nothing is written for abandoned games; the review job respects
 * the weekly token budget; and - the heart of it - an unproven teacher only
 * sits calibration exams, while a proven one's reviews become diary rows
 * with their own gradient weight.
 */
describe('LlmTeacherService', function () {
    let db;
    let policyService;
    let client;

    // A settings stub: section overrides on top of registry defaults, the
    // way the real settings service composes them.
    const settings = (overrides = {}) => ({
        getSection: () => ({ llmTeacherEnabled: true, ...overrides })
    });

    const configService = { getValue: () => ({ apiKey: 'test-key' }) };

    const service = (overrides = {}, deps = {}) =>
        new LlmTeacherService(configService, db, settings(overrides), {
            policyService,
            client,
            ...deps
        });

    /** The model's answer for one review, as the API would return it. */
    const modelAnswer = (scores) => ({
        stop_reason: 'end_turn',
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    scores: scores.map((winProbability, index) => ({ index, winProbability }))
                })
            }
        ]
    });

    const answer = (handlers) =>
        db.query.mockImplementation(async (sql, params) => {
            for (const [fragment, rows] of handlers) {
                if (sql.includes(fragment)) {
                    return typeof rows === 'function' ? rows(sql, params) : rows;
                }
            }

            return [];
        });

    const queriesMatching = (fragment) =>
        db.query.mock.calls.filter(([sql]) => sql.includes(fragment));

    // The stand-ins the features read - same skeletons the learning-loop
    // specs use.
    const card = (name, overrides = {}) => ({
        id: name.toLowerCase().replace(/ /g, '-'),
        name,
        power: 3,
        armor: 0,
        exhausted: false,
        stunned: false,
        type: 'creature',
        location: 'play area',
        tokens: {},
        cardData: {},
        hasHouse: () => true,
        ...overrides
    });

    const player = (name, overrides = {}) => ({
        name,
        amber: 2,
        hand: [card('Krump'), card('Bait and Switch', { type: 'action' })],
        cardsInPlay: [],
        creaturesInPlay: [],
        archives: [],
        deck: [card('Troll')],
        discard: [],
        getForgedKeys: () => 0,
        getCurrentKeyCost: () => 6,
        opponent: null,
        ...overrides
    });

    const position = (game = {}, me = {}, them = {}) => {
        const alpha = player('challenger-alpha', me);
        const omega = player('challenger-omega', them);

        alpha.opponent = omega;
        omega.opponent = alpha;

        return { game: { round: 1, ...game }, player: alpha };
    };

    const houseCandidates = [
        { kind: 'houseCall', house: 'brobnar' },
        { kind: 'houseCall', house: 'dis' },
        { kind: 'houseCall', house: 'logos' }
    ];

    beforeEach(function () {
        db = { query: vi.fn().mockResolvedValue([]) };
        policyService = { recordTrainingGame: vi.fn().mockResolvedValue(1) };
        client = { messages: { create: vi.fn() } };
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    describe('the switch', function () {
        it('is off by default, and off without a key to spend', function () {
            expect(
                new LlmTeacherService(configService, db, { getSection: () => ({}) }).isEnabled()
            ).toBe(false);
            expect(
                new LlmTeacherService({ getValue: () => ({}) }, db, settings()).isEnabled()
            ).toBe(false);
        });

        it('is on with the admin switch and a key', function () {
            expect(service().isEnabled()).toBe(true);
        });
    });

    describe('capture', function () {
        it('keeps an eligible decision, never steers, and flushes with the winner', async function () {
            const teacher = service();
            const budget = { remaining: 3, deepRemaining: 2 };
            const sampler = teacher.gameSampler({ policyVersion: 7, budget });
            const { game, player: alpha } = position();

            const steer = await sampler.analyzer({
                game,
                player: alpha,
                kind: 'house',
                candidates: houseCandidates
            });

            expect(steer).toBeNull();
            expect(budget.remaining).toBe(2);

            const stored = await sampler.flush('challenger-alpha');

            expect(stored).toBe(1);

            const [insert] = queriesMatching('INSERT INTO "ChallengeLlmPositions"');

            expect(insert[1][0]).toBe(7);
            expect(insert[1][1]).toBe('challenger-alpha');

            const summary = JSON.parse(insert[1][2]);
            const candidates = JSON.parse(insert[1][3]);

            expect(summary.side).toBe('challenger-alpha');
            expect(summary.me.hand).toContain('Krump');
            // The opponent's hand stays a count - the summary sees only what
            // the deciding seat could.
            expect(summary.them.hand).toBeUndefined();
            expect(candidates.map((entry) => entry.label)).toEqual([
                'call brobnar',
                'call dis',
                'call logos'
            ]);
            expect(candidates[0].record.side).toBe('challenger-alpha');
            expect(insert[1][4]).toBeNull();
        });

        it('captures at most one position per game, and none past the budget', async function () {
            const teacher = service();
            const spent = { remaining: 0, deepRemaining: 0 };
            const sampler = teacher.gameSampler({ policyVersion: 1, budget: spent });
            const { game, player: alpha } = position();

            await sampler.analyzer({
                game,
                player: alpha,
                kind: 'house',
                candidates: houseCandidates
            });
            expect(await sampler.flush('challenger-alpha')).toBe(0);

            const budget = { remaining: 5, deepRemaining: 2 };
            const twice = teacher.gameSampler({ policyVersion: 1, budget });

            await twice.analyzer({
                game,
                player: alpha,
                kind: 'house',
                candidates: houseCandidates
            });
            await twice.analyzer({
                game,
                player: alpha,
                kind: 'house',
                candidates: houseCandidates
            });
            expect(budget.remaining).toBe(4);
        });

        it('skips uninteresting decisions: mid-game actions far from a forge', async function () {
            const teacher = service();
            const budget = { remaining: 5, deepRemaining: 2 };
            const sampler = teacher.gameSampler({ policyVersion: 1, budget });
            const { game, player: alpha } = position({ round: 9 });

            await sampler.analyzer({
                game,
                player: alpha,
                kind: 'action',
                candidates: [
                    { kind: 'reap', card: card('Krump') },
                    { kind: 'playCreature', card: card('Troll') }
                ]
            });

            expect(budget.remaining).toBe(5);

            // The same decision with a forge in reach is a capture.
            const { game: lateGame, player: racer } = position({ round: 9 }, { amber: 5 });

            await sampler.analyzer({
                game: lateGame,
                player: racer,
                kind: 'action',
                candidates: [
                    { kind: 'reap', card: card('Krump') },
                    { kind: 'playCreature', card: card('Troll') }
                ]
            });

            expect(budget.remaining).toBe(4);
        });

        it('rotates which eligible decision is kept across games', async function () {
            const teacher = service();
            const budget = { remaining: 5, deepRemaining: 2 };
            // First sampler took rotation slot 0 - this one waits for the
            // SECOND eligible decision.
            teacher.gameSampler({ policyVersion: 1, budget });

            const sampler = teacher.gameSampler({ policyVersion: 1, budget });
            const { game, player: alpha } = position();

            await sampler.analyzer({
                game,
                player: alpha,
                kind: 'house',
                candidates: houseCandidates
            });
            expect(budget.remaining).toBe(5);
            await sampler.analyzer({
                game,
                player: alpha,
                kind: 'house',
                candidates: houseCandidates
            });
            expect(budget.remaining).toBe(4);
        });

        it('keeps a deep decision with its measured targets, inside the deep cap', async function () {
            const teacher = service();
            const budget = { remaining: 5, deepRemaining: 1 };
            const sampler = teacher.gameSampler({ policyVersion: 2, budget });
            const { game, player: alpha } = position();
            const candidates = [
                { kind: 'reap', card: card('Krump') },
                { kind: 'playCreature', card: card('Troll') },
                { kind: 'discard', card: card('Bait and Switch') }
            ];

            sampler.deepRecorder({
                game,
                player: alpha,
                kind: 'action',
                candidates,
                scored: [
                    { index: 0, label: 'reap with Krump', winProb: 0.61 },
                    { index: 2, label: 'discard Bait and Switch', winProb: null },
                    { index: 1, label: 'play Troll', winProb: 0.44 }
                ]
            });

            expect(budget.deepRemaining).toBe(0);
            await sampler.flush('challenger-omega');

            const [insert] = queriesMatching('INSERT INTO "ChallengeLlmPositions"');
            const candidatesStored = JSON.parse(insert[1][3]);
            const targets = JSON.parse(insert[1][4]);

            // The unmeasured road is dropped; records stay aligned with
            // targets.
            expect(candidatesStored).toHaveLength(2);
            expect(candidatesStored.map((entry) => entry.label)).toEqual([
                'reap with Krump',
                'play Troll'
            ]);
            expect(targets).toEqual([0.61, 0.44]);

            const spentDeep = { remaining: 5, deepRemaining: 0 };
            const capped = teacher.gameSampler({ policyVersion: 2, budget: spentDeep });

            capped.deepRecorder({
                game,
                player: alpha,
                kind: 'action',
                candidates,
                scored: [
                    { index: 0, label: 'reap with Krump', winProb: 0.61 },
                    { index: 1, label: 'play Troll', winProb: 0.44 }
                ]
            });

            expect(spentDeep.remaining).toBe(5);
        });

        it('halves the daily budget for deep captures', async function () {
            answer([['COUNT(*)::int AS "Count"', [{ Count: 2, Deep: 2 }]]]);

            const budget = await service({ llmPositionsPerDay: 4 }).captureBudget();

            expect(budget.remaining).toBe(2);
            expect(budget.deepRemaining).toBe(0);
        });
    });

    describe('the review job', function () {
        const calibrationRow = (id) => ({
            Id: id,
            PolicyVersion: 3,
            WinnerSide: 'challenger-alpha',
            Summary: {
                round: 2,
                side: 'challenger-alpha',
                kind: 'action',
                prompt: null,
                me: {
                    amber: 4,
                    keys: 1,
                    keyCost: 6,
                    creatures: [{ name: 'Krump', power: 6, exhausted: false }],
                    artifacts: [],
                    hand: ['Bait and Switch'],
                    handCount: 1,
                    deckCount: 20,
                    discardCount: 5,
                    archivesCount: 0
                },
                them: {
                    amber: 5,
                    keys: 1,
                    keyCost: 6,
                    creatures: [],
                    artifacts: [],
                    handCount: 6,
                    deckCount: 18,
                    discardCount: 8,
                    archivesCount: 1
                }
            },
            Candidates: [
                {
                    label: 'reap with Krump',
                    record: {
                        state: { bias: 1 },
                        action: { 'act:reap': 1 },
                        cardId: 'krump',
                        side: 'challenger-alpha'
                    }
                },
                {
                    label: 'fight with Krump',
                    record: {
                        state: { bias: 1 },
                        action: { 'act:fight': 1 },
                        cardId: 'krump',
                        side: 'challenger-alpha'
                    }
                }
            ],
            DeepTargets: [0.6, 0.4]
        });

        const teachingRow = (id) => ({
            ...calibrationRow(id),
            DeepTargets: null
        });

        const licenceRows = (count, matches) =>
            Array.from({ length: count }, (unused, i) => ({
                Review: { topMatch: i < matches }
            }));

        it('does nothing while off, and nothing past the weekly budget', async function () {
            expect(
                await new LlmTeacherService(configService, db, {
                    getSection: () => ({})
                }).reviewPending()
            ).toEqual({ skipped: 'off' });

            answer([['"ReviewedAt" >=', [{ Count: 25 }]]]);
            expect((await service().reviewPending()).skipped).toBe('budget-spent');
            expect(client.messages.create).not.toHaveBeenCalled();
        });

        it('an unproven teacher only sits exams, and its marks are recorded', async function () {
            answer([
                ['"ReviewedAt" >=', [{ Count: 0 }]],
                ['"Status" = \'reviewed\'', []],
                ['IS NOT NULL ORDER BY', [calibrationRow(41)]],
                ['IS NULL ORDER BY', [teachingRow(42)]]
            ]);
            // The teacher disagrees with the search: it prefers the fight.
            client.messages.create.mockResolvedValue(modelAnswer([0.3, 0.7]));

            const outcome = await service().reviewPending();

            expect(outcome).toMatchObject({ reviewed: 1, calibrated: 1, taught: 0 });
            // Unproven: the teaching-row query must never have been made.
            expect(queriesMatching('IS NULL ORDER BY')).toHaveLength(0);
            expect(policyService.recordTrainingGame).not.toHaveBeenCalled();

            const [settle] = queriesMatching('SET "Status"');

            expect(settle[1][0]).toBe(41);
            expect(settle[1][1]).toBe('reviewed');
            expect(JSON.parse(settle[1][2])).toMatchObject({ topMatch: false });

            // The prompt the model saw was the rendered position.
            const request = client.messages.create.mock.calls[0][0];

            expect(request.messages[0].content).toContain('reap with Krump');
            expect(request.messages[0].content).toContain('4 amber');
            expect(request.output_config.format.type).toBe('json_schema');
        });

        it('a proven teacher turns reviews into weighted diary lessons', async function () {
            answer([
                ['"ReviewedAt" >=', [{ Count: 3 }]],
                ['"Status" = \'reviewed\'', licenceRows(20, 16)],
                ['IS NOT NULL ORDER BY', []],
                ['IS NULL ORDER BY', [teachingRow(50)]]
            ]);
            client.messages.create.mockResolvedValue(modelAnswer([0.8, 0.35]));

            const outcome = await service({ llmTargetWeight: 3 }).reviewPending();

            expect(outcome).toMatchObject({ reviewed: 1, taught: 1 });

            const [logged, keep] = policyService.recordTrainingGame.mock.calls[0];

            expect(keep).toBe(4000);
            expect(logged.winnerSide).toBe('challenger-alpha');
            expect(logged.decisions).toHaveLength(2);
            expect(logged.decisions[0]).toMatchObject({
                cardId: 'krump',
                target: 0.8,
                weight: 3
            });
            expect(logged.decisions[1].target).toBeCloseTo(0.35, 10);
        });

        it('a teacher that lost its licence stops teaching again', async function () {
            answer([
                ['"ReviewedAt" >=', [{ Count: 0 }]],
                // 20 exams, 6 agreed: under the 0.5 bar.
                ['"Status" = \'reviewed\'', licenceRows(20, 6)],
                ['IS NOT NULL ORDER BY', []],
                ['IS NULL ORDER BY', [teachingRow(51)]]
            ]);

            const outcome = await service().reviewPending();

            expect(outcome).toMatchObject({ reviewed: 0, taught: 0 });
            expect(client.messages.create).not.toHaveBeenCalled();
            expect(policyService.recordTrainingGame).not.toHaveBeenCalled();
        });

        it('an unusable answer spends the position; an API failure does not', async function () {
            answer([
                ['"ReviewedAt" >=', [{ Count: 0 }]],
                ['"Status" = \'reviewed\'', []],
                ['IS NOT NULL ORDER BY', [calibrationRow(60), calibrationRow(61)]]
            ]);
            client.messages.create
                .mockResolvedValueOnce({
                    stop_reason: 'end_turn',
                    content: [{ type: 'text', text: 'not json at all' }]
                })
                .mockRejectedValueOnce(new Error('rate limited'));

            const outcome = await service().reviewPending();

            expect(outcome).toMatchObject({ failed: 1, reviewed: 0 });

            const settles = queriesMatching('SET "Status"');

            // Only the unusable one was settled (as failed); the rate-limited
            // one keeps its turn for a later run.
            expect(settles).toHaveLength(1);
            expect(settles[0][1][0]).toBe(60);
            expect(settles[0][1][1]).toBe('failed');
        });

        it('a refusal is an unusable answer, not an outage', async function () {
            answer([
                ['"ReviewedAt" >=', [{ Count: 0 }]],
                ['"Status" = \'reviewed\'', []],
                ['IS NOT NULL ORDER BY', [calibrationRow(70)]]
            ]);
            client.messages.create.mockResolvedValue({
                stop_reason: 'refusal',
                stop_details: { type: 'refusal', category: null },
                content: []
            });

            const outcome = await service().reviewPending();

            expect(outcome).toMatchObject({ failed: 1 });
            expect(queriesMatching('SET "Status"')[0][1][1]).toBe('failed');
        });
    });

    describe('vitals', function () {
        it('reports the licence and the budgets', async function () {
            const exams = Array.from({ length: 12 }, (unused, i) => ({
                Review: { topMatch: i < 9 }
            }));

            answer([
                ['"Status" = \'reviewed\'', exams],
                ['FILTER (WHERE "Status"', [{ Pending: 4 }]],
                ['"ReviewedAt" >=', [{ Count: 7 }]]
            ]);

            const vitals = await service().vitals();

            expect(vitals).toMatchObject({
                enabled: true,
                pending: 4,
                reviewsThisWeek: 7,
                calibrationReviews: 12,
                teaching: true
            });
            expect(vitals.agreement).toBeCloseTo(0.75, 10);
        });
    });
});
