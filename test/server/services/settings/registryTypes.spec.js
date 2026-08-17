const { REGISTRY, validateSection } = require('../../../../server/services/settings/registry');

describe('settings registry: text and stringMap types', function () {
    describe('content section (text)', function () {
        it('accepts markdown strings', function () {
            expect(validateSection('content', { aboutMarkdown: '# Hello' })).toEqual([]);
        });

        it('rejects non-strings', function () {
            expect(validateSection('content', { aboutMarkdown: 42 })).not.toEqual([]);
        });

        it('rejects text beyond maxLength', function () {
            const errors = validateSection('content', { aboutMarkdown: 'x'.repeat(50001) });
            expect(errors.some((error) => error.includes('at most'))).toBe(true);
        });
    });

    describe('regions section (stringMap)', function () {
        it('accepts country codes mapped to known regions', function () {
            expect(validateSection('regions', { overrides: { US: 'EU', JP: 'NA' } })).toEqual([]);
        });

        it('rejects malformed country keys', function () {
            const errors = validateSection('regions', { overrides: { usa: 'EU' } });
            expect(errors.some((error) => error.includes('invalid key'))).toBe(true);
        });

        it('rejects unknown regions', function () {
            const errors = validateSection('regions', { overrides: { US: 'MOON' } });
            expect(errors.some((error) => error.includes('unknown value'))).toBe(true);
        });

        it('rejects non-object values', function () {
            expect(validateSection('regions', { overrides: ['US'] })).not.toEqual([]);
        });
    });
});

/**
 * ARCHON: the learning budget, guarded as a number rather than as prose.
 *
 * A decision the deep bot searched is the only kind that can teach move
 * ORDER; an outcome label says "this appeared in a game somebody won",
 * which for a turn-3 play in a game thrown away on turn 20 points the wrong
 * way. The fast bot produces thousands of the second sort for every one of
 * the first, so these three defaults and the training weight are what
 * decide whether the loop learns from the good signal or drowns it. They
 * are easy to trim back for CPU without noticing what was traded away, so
 * the trade is written down here.
 */
describe('what the learning loop is budgeted to search', function () {
    const challenge = REGISTRY.championsChallenge.fields;
    const perDay =
        challenge.deepGamesPerDay.default *
        challenge.deepMaxAnalyzedDecisions.default *
        challenge.deepCandidates.default;

    it('measures at least a thousand decisions a day', function () {
        expect(perDay).toBeGreaterThanOrEqual(1000);
    });

    it('leans on a measured decision harder than on a played one', function () {
        expect(challenge.trainingTargetWeight.default).toBeGreaterThan(1);
        // 1 is reachable on purpose: it restores the old behaviour.
        expect(challenge.trainingTargetWeight.min).toBe(1);
    });

    it('lets an operator switch the search off entirely', function () {
        // A small box has to be able to say no to hours of CPU.
        expect(challenge.deepGamesPerDay.min).toBe(0);
    });
});
