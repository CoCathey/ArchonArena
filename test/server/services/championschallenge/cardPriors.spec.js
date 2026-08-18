const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    priorScores,
    cardPriorsAt,
    withCardPriors,
    stripCardPriors,
    resetCache,
    PRIORS_FILE
} = require('../../../../server/services/championschallenge/cardPriors');
const BotPolicyService = require('../../../../server/services/championschallenge/BotPolicyService');

// ARCHON (N38): the card priors - the file, the mapping, and the two doors
// (champion/candidate) they attach at. The invariants that matter: a missing
// file is a supported state, score 5 is exactly "no opinion", stored models
// never carry priors, and loaded ones always do while the knob is on.

describe('cardPriors', function () {
    let dir;
    let file;

    const writeScores = (scores) =>
        fs.writeFileSync(file, JSON.stringify({ version: 1, model: 'test', scores }));

    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-priors-'));
        file = path.join(dir, 'cardPriors.json');
        resetCache();
    });

    afterEach(function () {
        resetCache();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    describe('the loader', function () {
        it('a missing file is null, not an error', function () {
            expect(priorScores(path.join(dir, 'nope.json'))).toBeNull();
            expect(cardPriorsAt(0.25, path.join(dir, 'nope.json'))).toBeNull();
        });

        it('maps scores to logits: 5 is no opinion, the knob is the value of a 10', function () {
            writeScores({ bomb: 10, filler: 5, liability: 0, odd: 7.5 });

            const priors = cardPriorsAt(0.25, file);

            expect(priors.bomb).toBeCloseTo(0.25, 10);
            expect(priors.filler).toBeCloseTo(0, 10);
            expect(priors.liability).toBeCloseTo(-0.25, 10);
            expect(priors.odd).toBeCloseTo(0.125, 10);
        });

        it('clamps out-of-range scores and drops unreadable ones', function () {
            writeScores({ over: 14, under: -3, garbage: 'ten' });

            const priors = cardPriorsAt(1, file);

            expect(priors.over).toBeCloseTo(1, 10);
            expect(priors.under).toBeCloseTo(-1, 10);
            expect(priors.garbage).toBeUndefined();
        });

        it('weight zero (or nonsense) switches priors off without touching the file', function () {
            writeScores({ bomb: 10 });

            expect(cardPriorsAt(0, file)).toBeNull();
            expect(cardPriorsAt('off', file)).toBeNull();
        });
    });

    describe('attach and strip', function () {
        it('attaches to a model and strips for storage', function () {
            writeScores({ bomb: 10 });

            const attached = withCardPriors({ weights: {}, trainedGames: 3 }, 0.25, file);

            expect(attached.cardPriors.bomb).toBeCloseTo(0.25, 10);
            expect(attached.trainedGames).toBe(3);

            const stored = stripCardPriors(attached);

            expect(stored.cardPriors).toBeUndefined();
            expect(stored.trainedGames).toBe(3);
        });

        it('with priors off, attach also REMOVES a stale map', function () {
            const model = { weights: {}, cardPriors: { stale: 1 } };

            expect(withCardPriors(model, 0, file).cardPriors).toBeUndefined();
        });

        it('passes a null model through - the heuristics have no priors', function () {
            expect(withCardPriors(null, 0.25, file)).toBeNull();
        });
    });

    /**
     * The doors: BotPolicyService loads models with priors attached and
     * stores them stripped. These write the REAL priors file location (the
     * repo ships without one), so they clean up after themselves.
     */
    describe('BotPolicyService integration', function () {
        let db;
        let hadRealFile;

        const service = (cardPriorWeight) =>
            new BotPolicyService({ getValue: () => ({}) }, db, {
                getSection: () => ({ cardPriorWeight })
            });

        beforeEach(function () {
            db = { query: vi.fn().mockResolvedValue([]) };
            hadRealFile = fs.existsSync(PRIORS_FILE);

            if (!hadRealFile) {
                fs.mkdirSync(path.dirname(PRIORS_FILE), { recursive: true });
                fs.writeFileSync(
                    PRIORS_FILE,
                    JSON.stringify({ version: 1, scores: { 'known-bomb': 10 } })
                );
            }

            resetCache();
        });

        afterEach(function () {
            if (!hadRealFile) {
                fs.rmSync(PRIORS_FILE, { force: true });
            }

            resetCache();
            vi.restoreAllMocks();
        });

        it('champion() arrives with priors attached, and without them at weight 0', async function () {
            db.query.mockResolvedValue([{ Model: { weights: {}, version: 4 } }]);

            const primed = await service(0.25).champion();

            expect(primed.cardPriors['known-bomb']).toBeCloseTo(0.25, 10);

            const plain = await service(0).champion();

            expect(plain.cardPriors).toBeUndefined();
        });

        it('trainCandidate trains WITH priors but stores WITHOUT them', async function () {
            const diary = Array.from({ length: 30 }, () => ({
                WinnerSide: 'challenger-alpha',
                Decisions: [
                    {
                        state: { bias: 1 },
                        action: { 'act:reap': 1 },
                        cardId: null,
                        side: 'challenger-alpha'
                    }
                ]
            }));

            db.query.mockImplementation(async (sql) => {
                if (sql.includes('"Status" = \'candidate\'')) {
                    return [];
                }

                if (sql.includes('"Status" = \'champion\'')) {
                    return [];
                }

                if (sql.includes('FROM "BotTrainingGames"')) {
                    return diary;
                }

                if (sql.includes('MAX("Version")')) {
                    return [{ Version: 0 }];
                }

                if (sql.includes('INSERT INTO "BotPolicies"')) {
                    return [{ Id: 11 }];
                }

                return [];
            });

            const candidate = await service(0.25).trainCandidate({ batchGames: 30 });

            // The in-memory model knows its priors...
            expect(candidate.Model.cardPriors['known-bomb']).toBeCloseTo(0.25, 10);

            // ...and the stored row does not.
            const insert = db.query.mock.calls.find(([sql]) =>
                sql.includes('INSERT INTO "BotPolicies"')
            );
            const stored = JSON.parse(insert[1][1]);

            expect(stored.cardPriors).toBeUndefined();
            expect(stored.version).toBe(1);
        });
    });
});
