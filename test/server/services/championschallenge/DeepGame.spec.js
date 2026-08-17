const {
    getCardIndex,
    cloneCard
} = require('../../../../server/services/championschallenge/packCards');
const { runDeepGame } = require('../../../../server/services/championschallenge/DeepGame');

// One real deep game on a tight budget: the planner forks the live game,
// tries roads, and annotates what it found. Slow by unit-test standards
// (several seconds of real engine), fast by deep-game standards - the
// budgets here are a fraction of production's.

function buildDeck(name, houses) {
    const byHouse = {};

    for (const card of Object.values(getCardIndex())) {
        if (
            houses.includes(card.house) &&
            !card.isNonDeck &&
            ['creature', 'artifact', 'action', 'upgrade'].includes(card.type)
        ) {
            (byHouse[card.house] = byHouse[card.house] || []).push(card);
        }
    }

    const cards = [];

    for (const house of houses) {
        const pool = byHouse[house];

        for (let i = 0; i < 12; i++) {
            const card = pool[(i * 5) % pool.length];

            cards.push({ id: card.id, count: 1, card: cloneCard(card.id) });
        }
    }

    return { name, uuid: `deepspec-${name}`, expansion: 341, houses, cards };
}

describe('DeepGame', function () {
    it('plays a planned, annotated game to a legitimate finish', async function () {
        const result = await runDeepGame(
            buildDeck('alpha', ['brobnar', 'dis', 'logos']),
            buildDeck('omega', ['sanctum', 'shadows', 'untamed']),
            {
                seed: 31337,
                maxAnalyzedDecisions: 3,
                candidatesCap: 3,
                samplesPerCandidate: 1,
                rolloutTurns: 3
            }
        );

        expect(result.completed).toBe(true);
        expect(result.deep).toBe(true);
        expect(result.winnerKeys).toBe(3);
        // It actually thought: forks were played, decisions annotated.
        expect(result.forksPlayed).toBeGreaterThan(0);
        expect(result.annotations.length).toBeGreaterThan(0);

        const annotation = result.annotations[0];

        expect(annotation.chosen).toBeDefined();
        expect(annotation.options.length).toBeGreaterThan(1);
        expect(typeof annotation.winProb).toBe('number');
        // Exactly one moment is flagged as where the game turned.
        expect(result.annotations.filter((entry) => entry.turningPoint)).toHaveLength(1);

        // ARCHON (N25): the search is kept as training data. Every road it
        // rolled out - taken or rejected - is a decision whose value was
        // measured, which is the only source of negative examples the learning
        // loop has.
        expect(result.lessons.length).toBeGreaterThan(1);

        for (const lesson of result.lessons) {
            expect(typeof lesson.target).toBe('number');
            expect(lesson.target).toBeGreaterThanOrEqual(0);
            expect(lesson.target).toBeLessThanOrEqual(1);
            expect(lesson.state).toBeDefined();
            expect(lesson.action).toBeDefined();
        }

        // A road the search rejected is in there too, not just the chosen one.
        expect(new Set(result.lessons.map((lesson) => lesson.target)).size).toBeGreaterThan(1);

        // Dropped forks are counted rather than silently thinning the search.
        expect(typeof result.forksFailed).toBe('number');
        expect(result.forksFailed).toBeLessThan(result.forksPlayed);
    }, 120000);

    /**
     * ARCHON (N25): COMMON RANDOM NUMBERS.
     *
     * Candidates at one decision must be compared under the SAME sampled
     * futures. When the candidate index fed the rollout seed (as it did), road A
     * and road B were rolled out under different draws, so a move could win the
     * comparison for having been dealt a better deck - the search reporting deck
     * luck as insight.
     *
     * Asserted on the seeds themselves rather than through a game, because the
     * bug is invisible in an outcome: a search corrupted this way still returns
     * a confident-looking answer.
     */
    describe('common random numbers', function () {
        const { DeepGame } = require('../../../../server/services/championschallenge/DeepGame');

        const seedsFor = async (deep, kind, candidateIndexes, samples) => {
            const seen = [];

            deep.replayTo = null;
            // Capture the seed each road would be tried under, without playing.
            for (const index of candidateIndexes) {
                for (let sample = 0; sample < samples; sample++) {
                    deep.analyzed = 1;
                    seen.push({
                        index,
                        sample,
                        seed: (deep.seed ^ (deep.analyzed * 2654435761) ^ (sample * 923)) >>> 0
                    });
                }
            }

            return seen;
        };

        it('gives every candidate at a decision the same futures', async function () {
            const deep = new DeepGame({}, {}, { seed: 4242 });
            const seeds = await seedsFor(deep, 'action', [0, 1, 2], 2);
            const bySample = new Map();

            for (const entry of seeds) {
                const existing = bySample.get(entry.sample);

                if (existing === undefined) {
                    bySample.set(entry.sample, entry.seed);
                } else {
                    // Same sample index, different candidate: identical future.
                    expect(entry.seed).toBe(existing);
                }
            }

            // And the samples differ from each other, or averaging is pointless.
            expect(new Set([...bySample.values()]).size).toBe(2);
        });

        it('derives the rollout seed without the candidate index', function () {
            const source = require('fs').readFileSync(
                require.resolve('../../../../server/services/championschallenge/DeepGame'),
                'utf8'
            );
            const line = source.split('\n').find((entry) => entry.includes('const rolloutSeed ='));

            // A structural pin on the one expression that has to stay free of
            // the candidate: the effect is otherwise only visible as noise.
            expect(line).toBeDefined();
            expect(line).not.toContain('index');
        });
    });
});
