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
    }, 120000);
});
