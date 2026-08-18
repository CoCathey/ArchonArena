const {
    sanitizeModel,
    parseModelInput,
    exportChampion,
    enterChallenger
} = require('../../../../server/scripts/challenge-challenger');

// ARCHON (N38): the challenger's door. The claims that matter: nothing
// enters the arena unvalidated, nothing enters while a title fight is on
// (except by explicit concession), and nothing this script does can crown a
// model - entry is always as a candidate, and the SPRT arena stands between
// every upload and the title.

describe('the challenger door', function () {
    let db;

    const answer = (handlers) =>
        db.query.mockImplementation(async (sql) => {
            for (const [fragment, rows] of handlers) {
                if (sql.includes(fragment)) {
                    return rows;
                }
            }

            return [];
        });

    const queriesMatching = (fragment) =>
        db.query.mock.calls.filter(([sql]) => sql.includes(fragment));

    beforeEach(function () {
        db = { query: vi.fn().mockResolvedValue([]) };
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    describe('sanitizeModel', function () {
        it('keeps the known fields and strips everything else', function () {
            const { model, problems, warnings } = sanitizeModel({
                trainedGames: 900,
                weights: { 's:myAmber': 0.4 },
                cardWeights: { krump: 0.6 },
                cardCounts: { krump: 200.4 },
                cardPriors: { krump: 0.25 },
                surprise: 'field'
            });

            expect(problems).toEqual([]);
            expect(model.trainedGames).toBe(900);
            expect(model.weights['s:myAmber']).toBe(0.4);
            expect(model.cardCounts.krump).toBe(200);
            expect(model.cardPriors).toBeUndefined();
            expect(model.surprise).toBeUndefined();
            expect(warnings.some((warning) => warning.includes('cardPriors'))).toBe(true);
        });

        it('refuses what cannot be scored: non-finite weights, negative counts', function () {
            const { model, problems } = sanitizeModel({
                weights: { bad: 'NaN-ish' },
                cardCounts: { krump: -3 }
            });

            expect(model).toBeNull();
            expect(problems.some((problem) => problem.includes('finite'))).toBe(true);
            expect(problems.some((problem) => problem.includes('negative'))).toBe(true);
        });

        it('clamps absurd magnitudes instead of trusting them', function () {
            const { model, warnings } = sanitizeModel({ cardWeights: { krump: 1000 } });

            expect(model.cardWeights.krump).toBe(50);
            expect(warnings.some((warning) => warning.includes('clamped'))).toBe(true);
        });

        it('a non-object is a refusal, not a crash', function () {
            expect(sanitizeModel('brain').model).toBeNull();
            expect(sanitizeModel([1, 2]).model).toBeNull();
            expect(sanitizeModel(null).model).toBeNull();
        });
    });

    describe('parseModelInput', function () {
        it('tolerates the npm banner an un-silenced export captures', function () {
            const polluted =
                '\n> archon-arena@2.0.0 challenger:export\n' +
                '> node server/scripts/challenge-challenger.js export\n\n' +
                '{ "weights": { "s:myAmber": 0.4 } }\n';

            expect(parseModelInput(polluted).weights['s:myAmber']).toBe(0.4);
        });

        it('input with no JSON object at all is a clear refusal', function () {
            expect(() => parseModelInput('nothing here')).toThrow('no JSON object');
        });
    });

    describe('exportChampion', function () {
        it('returns the stored model untouched, or a labelled blank slate', async function () {
            answer([['FROM "BotPolicies"', [{ Version: 4, Model: { weights: { a: 1 } } }]]]);
            expect(await exportChampion(db)).toEqual({ weights: { a: 1 } });

            answer([['FROM "BotPolicies"', []]]);

            const blank = await exportChampion(db);

            expect(blank.trainedGames).toBe(0);
            expect(blank.note).toContain('blank slate');
        });
    });

    describe('enterChallenger', function () {
        it('seats the model as a CANDIDATE at the next version, with provenance', async function () {
            answer([
                ['MAX("Version")', [{ Version: 7 }]],
                ['INSERT INTO "BotPolicies"', [{ Id: 12 }]]
            ]);

            const version = await enterChallenger(db, { trainedGames: 0, weights: {} });

            expect(version).toBe(8);

            const [insert] = queriesMatching('INSERT INTO "BotPolicies"');

            // Guarded insert: only while no candidate exists; always status
            // candidate - there is no path to 'champion' from here.
            expect(insert[0]).toContain("SELECT $1, 'candidate'");
            expect(insert[0]).toContain('WHERE NOT EXISTS');

            const stored = JSON.parse(insert[1][1]);

            expect(stored.version).toBe(8);
            expect(stored.origin).toBe('uploaded');
        });

        it('is refused while a title fight is on', async function () {
            answer([
                ['MAX("Version")', [{ Version: 7 }]],
                ['INSERT INTO "BotPolicies"', []]
            ]);

            expect(await enterChallenger(db, { weights: {} })).toBeNull();
            expect(queriesMatching('SET "Status" = \'retired\'')).toHaveLength(0);
        });

        it('concedes the sitting candidate only when told to, explicitly', async function () {
            answer([
                ['MAX("Version")', [{ Version: 7 }]],
                ['INSERT INTO "BotPolicies"', [{ Id: 13 }]]
            ]);

            await enterChallenger(db, { weights: {} }, { retireCurrent: true, note: 'advisor' });

            expect(queriesMatching('SET "Status" = \'retired\'')).toHaveLength(1);

            const [insert] = queriesMatching('INSERT INTO "BotPolicies"');

            expect(JSON.parse(insert[1][1]).note).toBe('advisor');
        });
    });
});
