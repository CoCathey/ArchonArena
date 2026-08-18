const { buildPacket } = require('../../../../server/scripts/challenge-advisor-packet');

// ARCHON (N38): the advisor packet - the one-paste telemetry export. What
// matters: it assembles every section from the services without touching
// anything, ranks the champion's brain by what actually scores (evidence-
// shrunk values), and surfaces the teacher's disagreements with the deep bot
// rather than its agreements.

describe('the advisor packet', function () {
    const db = { query: vi.fn() };
    const settingsService = {
        getSectionWithDefaults: () => ({ cardPriorWeight: 0, llmTeacherEnabled: true })
    };
    const policyService = {
        vitals: async () => ({ championVersion: 4, championTrainedGames: 900, candidate: null }),
        strengthCurve: async () => [{ version: 4, status: 'champion' }],
        personaLadder: async () => [{ persona: 'racer', wins: 6, losses: 4 }]
    };
    const teacherService = {
        vitals: async () => ({ enabled: true, agreement: 0.6, teaching: true })
    };

    const answer = (handlers) =>
        db.query.mockImplementation(async (sql) => {
            for (const [fragment, rows] of handlers) {
                if (sql.includes(fragment)) {
                    return rows;
                }
            }

            return [];
        });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    it('assembles the loop, the brain, and the arguments worth having', async function () {
        answer([
            ['FROM "BotTrainingGames"', [{ Count: 812 }]],
            ['FROM "ProvingGroundsGames"', [{ Games: 140, Deep: 21 }]],
            [
                'FROM "BotPolicies"',
                [
                    {
                        Version: 4,
                        Model: {
                            weights: { 's:myAmber': 0.4, 'a:act:reap': 0.9, 's:turn': -0.1 },
                            cardWeights: { krump: 0.6, toad: -0.5, 'barely-seen': 2 },
                            cardCounts: { krump: 200, toad: 80, 'barely-seen': 2 },
                            promptWeights: { 'destroy|mine': -0.4 },
                            promptCounts: { 'destroy|mine': 60 }
                        }
                    }
                ]
            ],
            [
                'FROM "ChallengeLlmPositions"',
                [
                    {
                        Summary: { round: 3, side: 'challenger-alpha', kind: 'action' },
                        Candidates: [{ label: 'reap with Krump' }, { label: 'fight with Krump' }],
                        DeepTargets: [0.7, 0.4],
                        Review: { topMatch: false, scores: [0.3, 0.8] }
                    },
                    {
                        Summary: { round: 5, side: 'challenger-omega', kind: 'house' },
                        Candidates: [{ label: 'call dis' }, { label: 'call logos' }],
                        DeepTargets: [0.6, 0.5],
                        Review: { topMatch: true, scores: [0.65, 0.5] }
                    }
                ]
            ]
        ]);

        const packet = await buildPacket({
            db,
            settingsService,
            policyService,
            teacherService,
            cardIndex: { krump: { name: 'Krump' }, toad: { name: 'Toad' } }
        });

        expect(packet.loop).toMatchObject({
            championVersion: 4,
            diaryGames: 812,
            gamesLast7Days: 140,
            deepGamesLast7Days: 21
        });
        expect(packet.settings.llmTeacherEnabled).toBe(true);
        expect(packet.strengthCurve).toHaveLength(1);
        expect(packet.personaLadder[0].persona).toBe('racer');

        // Only the argument is included, not the agreement.
        expect(packet.teacher.disagreements).toHaveLength(1);
        expect(packet.teacher.disagreements[0]).toMatchObject({
            round: 3,
            candidates: ['reap with Krump', 'fight with Krump'],
            teacherScores: [0.3, 0.8],
            deepTargets: [0.7, 0.4]
        });

        // Dense weights ranked by influence; card names joined in.
        expect(packet.model.stateAndActionWeights[0]).toEqual(['a:act:reap', 0.9]);
        expect(packet.model.cards.strongest[0]).toMatchObject({ name: 'Krump', games: 200 });
        expect(packet.model.cards.weakest[0]).toMatchObject({ name: 'Toad' });
        // A weight on two games is noise, however large, and stays out of the
        // rankings.
        expect(
            packet.model.cards.strongest.find((entry) => entry.id === 'barely-seen')
        ).toBeUndefined();
        expect(packet.model.prompts.weakest[0].prompt).toBe('destroy|mine');
    });

    it('a title still held by the heuristics is a packet, not a crash', async function () {
        answer([
            ['FROM "BotTrainingGames"', [{ Count: 0 }]],
            ['FROM "ProvingGroundsGames"', [{ Games: 0, Deep: 0 }]],
            ['FROM "BotPolicies"', []],
            ['FROM "ChallengeLlmPositions"', []]
        ]);

        const packet = await buildPacket({
            db,
            settingsService,
            policyService,
            teacherService,
            cardIndex: {}
        });

        expect(packet.model.note).toContain('heuristics');
        expect(packet.teacher.disagreements).toEqual([]);
    });
});
