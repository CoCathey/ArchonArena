const BotPolicyService = require('../../../../server/services/championschallenge/BotPolicyService');
const {
    MODES,
    humanLearningConfig,
    learnsFromTable
} = require('../../../../server/services/championschallenge/humanLearning');
const {
    trainModel,
    emptyModel
} = require('../../../../server/services/championschallenge/labPolicy');
const { REGISTRY } = require('../../../../server/services/settings/registry');

/**
 * ARCHON (N48): the diary end of learning from human games.
 *
 * The capture itself is pinned next door (test/server/gamenode). What is
 * pinned here is everything after the game ends: which tables are captured at
 * all, that a human game lands in the same diary as a sparring one with its
 * source recorded, and - the point of storing the source rather than the
 * weight - that the pull is applied when the batch is FOLDED, so an operator
 * who changes the knob re-weights the whole diary rather than only its future.
 */
describe('learning from human games', function () {
    const settings = (overrides = {}) => ({ getSection: () => overrides });

    describe('which tables are captured', function () {
        it('takes the practice tables by default, and only those', function () {
            expect(REGISTRY.championsChallenge.fields.humanLearning.default).toBe(MODES.BOT);

            expect(learnsFromTable(MODES.BOT, { botGame: true })).toBe(true);
            expect(learnsFromTable(MODES.BOT, { botGame: false })).toBe(false);
        });

        it('takes every table when asked to', function () {
            expect(learnsFromTable(MODES.ALL, { botGame: true })).toBe(true);
            expect(learnsFromTable(MODES.ALL, { botGame: false })).toBe(true);
        });

        it('takes nothing when switched off', function () {
            expect(learnsFromTable(MODES.OFF, { botGame: true })).toBe(false);
            expect(learnsFromTable(MODES.OFF, { botGame: false })).toBe(false);
        });

        it('treats an unreadable setting as the default rather than as no', function () {
            // A settings service that throws must not quietly switch a feature
            // off - that is a failure nobody would ever see.
            const broken = {
                getSection: () => {
                    throw new Error('no database');
                }
            };

            expect(humanLearningConfig(broken).mode).toBe(MODES.BOT);
            expect(humanLearningConfig(broken).weight).toBe(
                REGISTRY.championsChallenge.fields.humanGameWeight.default
            );
        });

        it('ignores a mode nobody defined', function () {
            expect(humanLearningConfig(settings({ humanLearning: 'sometimes' })).mode).toBe(
                MODES.BOT
            );
        });

        it('allows a pull of zero - parked, not lost', function () {
            expect(humanLearningConfig(settings({ humanGameWeight: 0 })).weight).toBe(0);
        });

        it('refuses a negative pull, which would train the bot to play worse', function () {
            expect(humanLearningConfig(settings({ humanGameWeight: -5 })).weight).toBe(
                REGISTRY.championsChallenge.fields.humanGameWeight.default
            );
        });
    });

    describe('filing the finished game', function () {
        let db;

        const service = (overrides = {}) =>
            new BotPolicyService(undefined, db, settings(overrides));

        const decisions = [{ state: { bias: 1 }, action: { 'act:reap': 1 }, side: 'player' }];

        beforeEach(function () {
            db = { query: vi.fn().mockResolvedValue([{ Count: 7 }]) };
        });

        const inserts = () =>
            db.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO "BotTrainingGames"'));

        it('writes the game into the diary, marked as human', function () {
            return service()
                .recordHumanGame({ winnerSide: 'player', decisions })
                .then((size) => {
                    expect(size).toBe(7);

                    const [[, params]] = inserts();

                    expect(params[1]).toBe('player');
                    expect(JSON.parse(params[2])).toEqual(decisions);
                    expect(params[4]).toBe('human');
                });
        });

        it('leaves a sparring game marked as self-play', function () {
            return service()
                .recordTrainingGame({ winnerSide: 'challenger-alpha', decisions }, 100)
                .then(() => {
                    expect(inserts()[0][1][4]).toBe('self');
                });
        });

        it('prunes to the configured diary size without being told it', function () {
            // The lobby's GAMEWIN handler has no business knowing about diary
            // pruning, so the service reads the cap itself.
            return service({ trainingGamesKept: 500 })
                .recordHumanGame({ winnerSide: 'player', decisions })
                .then(() => {
                    const [prune] = db.query.mock.calls.filter(([sql]) =>
                        sql.includes('DELETE FROM "BotTrainingGames"')
                    );

                    expect(prune[1]).toEqual([500]);
                });
        });

        it('files nothing once an admin has switched capture off', function () {
            // A game can run for half an hour. Somebody who turned this off
            // during one has said no, and the row arriving afterwards should
            // not land anyway.
            return service({ humanLearning: MODES.OFF })
                .recordHumanGame({ winnerSide: 'player', decisions })
                .then((size) => {
                    expect(size).toBe(0);
                    expect(inserts()).toHaveLength(0);
                });
        });

        it('files nothing for a game in which nobody decided anything', function () {
            return service()
                .recordHumanGame({ winnerSide: 'player', decisions: [] })
                .then((size) => {
                    expect(size).toBe(0);
                    expect(inserts()).toHaveLength(0);
                });
        });

        it('files nothing without a winner to label the rows with', function () {
            return service()
                .recordHumanGame({ decisions })
                .then((size) => {
                    expect(size).toBe(0);
                    expect(inserts()).toHaveLength(0);
                });
        });
    });

    describe('what a human’s move is worth at training time', function () {
        const { weighDecisions } = BotPolicyService;
        const decisions = () => [{ state: { bias: 1 }, action: { 'act:reap': 1 }, side: 'player' }];

        it('stamps the configured pull on a human row', function () {
            expect(weighDecisions(decisions(), 'human', 4)[0].weight).toBe(4);
        });

        it('leaves a sparring row alone, so it keeps pulling at one', function () {
            expect(weighDecisions(decisions(), 'self', 4)[0].weight).toBeUndefined();
        });

        it('parks the rows at zero rather than losing them', function () {
            expect(weighDecisions(decisions(), 'human', 0)[0].weight).toBe(0);
        });

        it('does not overrule a row that carries its own evidence', function () {
            // The AI teacher's rows set their weight from how well that teacher
            // has been agreeing with the deep bot. That is evidence about the
            // row, not about where it came from, and it wins.
            const taught = [{ ...decisions()[0], weight: 0.5 }];

            expect(weighDecisions(taught, 'human', 4)[0].weight).toBe(0.5);
        });

        it('does not mutate the stored row it was handed', function () {
            const stored = decisions();

            weighDecisions(stored, 'human', 4);

            expect(stored[0].weight).toBeUndefined();
        });
    });

    describe('folding a diary of human games', function () {
        // The knob is read when the batch is FOLDED, not when the row was
        // written - which is the whole reason the source is stored rather than
        // the weight. A diary that had baked the pull in could never be
        // re-weighted, and most of a diary is always already written.
        const fold = async (source, humanGameWeight) => {
            const rows = Array.from({ length: 25 }, () => ({
                WinnerSide: 'player',
                Source: source,
                Decisions: [{ state: { bias: 1 }, action: { 'act:reap': 1 }, side: 'player' }]
            }));
            const db = {
                query: vi.fn().mockImplementation(async (sql) => {
                    if (sql.includes('FROM "BotTrainingGames"')) {
                        return rows;
                    }

                    if (sql.includes('MAX("Version")')) {
                        return [{ Version: 3 }];
                    }

                    if (sql.includes('RETURNING "Id"')) {
                        return [{ Id: 9 }];
                    }

                    return [];
                })
            };
            const service = new BotPolicyService(undefined, db, {
                getSection: () => ({ humanGameWeight, cardPriorWeight: 0 })
            });

            service.champion = async () => emptyModel();

            const candidate = await service.trainCandidate({ batchGames: 25 });

            return candidate.Model.weights['a:act:reap'];
        };

        it('pushes a human diary further than a sparring one', async function () {
            expect(await fold('human', 3)).toBeGreaterThan(await fold('self', 3));
        });

        it('re-reads the knob every time, so changing it changes the whole diary', async function () {
            expect(await fold('human', 9)).toBeGreaterThan(await fold('human', 1));
        });

        it('trains as if the human rows were not there when the pull is zero', async function () {
            const parked = await fold('human', 0);

            // Not merely small - the gradient is multiplied by the pull, so a
            // zero pull leaves the weight exactly where it started.
            expect(parked || 0).toBe(0);
        });
    });

    describe('the pull actually reaches the gradient', function () {
        const lesson = (weight) => ({
            winnerSide: 'player',
            decisions: [
                {
                    state: { bias: 1 },
                    action: { 'act:reap': 1 },
                    side: 'player',
                    ...(weight === undefined ? {} : { weight })
                }
            ]
        });

        it('moves a human’s move further than a sparring one', function () {
            const sparring = trainModel(emptyModel(), [lesson()], { epochs: 1 });
            const human = trainModel(emptyModel(), [lesson(3)], { epochs: 1 });

            expect(human.weights['a:act:reap']).toBeGreaterThan(sparring.weights['a:act:reap']);
        });

        it('moves nothing at all when the pull is zero', function () {
            const parked = trainModel(emptyModel(), [lesson(0)], { epochs: 1 });

            expect(parked.weights['a:act:reap'] || 0).toBe(0);
        });
    });
});
