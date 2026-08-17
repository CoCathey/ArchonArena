const {
    getCardIndex,
    cloneCard
} = require('../../../../server/services/championschallenge/packCards');
const {
    runSimulatedGame,
    PLAYER_ONE,
    PLAYER_TWO
} = require('../../../../server/services/championschallenge/SimulatedGame');

// The one property the whole Champion’s Challenge stands on: a simulated game,
// played by the computer through the real engine, always reaches a legitimate
// conclusion. Everything else the lab reports is arithmetic over what these
// games record.
//
// These are real full games (about a second each), so there are deliberately
// few of them - the termination guards themselves are exercised with a tiny
// interaction budget instead of a wedged game.

/**
 * A legal-shaped 36-card deck: 12 cards from each of three houses, drawn from
 * the same pack data production uses. Spread with a stride so the decks hold
 * a mix of creatures, actions and artifacts rather than an alphabetic slab.
 */
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

    return { name, uuid: `spec-${name}`, expansion: 341, houses, cards };
}

describe('SimulatedGame', function () {
    const alphaDeck = buildDeck('alpha', ['brobnar', 'dis', 'logos']);
    const omegaDeck = buildDeck('omega', ['sanctum', 'shadows', 'untamed']);

    it('plays a full game to a legitimate three-key win', async function () {
        const result = await runSimulatedGame(alphaDeck, omegaDeck);

        expect(result.completed).toBe(true);
        expect(result.winReason).toBe('keys');
        expect([PLAYER_ONE, PLAYER_TWO]).toContain(result.winner);
        expect(result.winnerKeys).toBe(3);
        expect(result.loserKeys).toBeGreaterThanOrEqual(0);
        expect(result.loserKeys).toBeLessThan(3);
        expect(result.turns).toBeGreaterThan(4);
        expect(result.turns).toBeLessThanOrEqual(80);
        expect(result.interactions).toBeGreaterThan(50);
        expect(typeof result.winnerWentFirst).toBe('boolean');
    }, 30000);

    it('records how each side played: first house and every house call', async function () {
        const result = await runSimulatedGame(alphaDeck, omegaDeck);

        expect(result.completed).toBe(true);

        const winnerHouses = result.winnerDeck === alphaDeck ? alphaDeck.houses : omegaDeck.houses;
        const calls = Object.entries(result.winnerHouseCalls);

        expect(winnerHouses).toContain(result.winnerFirstHouse);
        expect(calls.length).toBeGreaterThan(0);

        for (const [house, count] of calls) {
            expect(winnerHouses).toContain(house);
            expect(count).toBeGreaterThan(0);
        }

        // The winner and loser decks are the two that were put in.
        expect([alphaDeck, omegaDeck]).toContain(result.winnerDeck);
        expect([alphaDeck, omegaDeck]).toContain(result.loserDeck);
        expect(result.winnerDeck).not.toBe(result.loserDeck);
    }, 30000);

    it('abandons rather than hangs when a game will not finish in budget', async function () {
        const result = await runSimulatedGame(alphaDeck, omegaDeck, { maxInteractions: 30 });

        expect(result.completed).toBe(false);
        expect(result.reason).toBe('interaction-cap');
    }, 30000);
});
