const {
    getCardIndex,
    cloneCard
} = require('../../../../server/services/championschallenge/packCards');
const {
    SimulatedGame,
    runSimulatedGame,
    replayTo,
    PLAYER_ONE,
    PLAYER_TWO
} = require('../../../../server/services/championschallenge/SimulatedGame');
const {
    emptyModel,
    trainModel
} = require('../../../../server/services/championschallenge/labPolicy');

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

    // ARCHON (N21): the properties the deep planner stands on. Determinism
    // is not a nicety here - a fork that reconstructs a subtly different
    // game would "learn" from moves that were never made.
    describe('seeded determinism and forking', function () {
        it('plays the identical game twice from one seed', async function () {
            const first = await runSimulatedGame(alphaDeck, omegaDeck, {
                seed: 20260817,
                fingerprints: true
            });
            const second = await runSimulatedGame(alphaDeck, omegaDeck, {
                seed: 20260817,
                fingerprints: true
            });

            expect(first.completed).toBe(true);
            expect(second.winner).toBe(first.winner);
            expect(second.inputLog.length).toBe(first.inputLog.length);
            expect(second.fingerprints).toEqual(first.fingerprints);
        }, 30000);

        it('forks mid-game to the exact recorded state, then diverges honestly', async function () {
            const original = await runSimulatedGame(alphaDeck, omegaDeck, {
                seed: 424242,
                fingerprints: true
            });

            expect(original.completed).toBe(true);

            const mid = Math.floor(original.inputLog.length / 2);
            const { sim } = await replayTo(alphaDeck, omegaDeck, {
                seed: 424242,
                inputLog: original.inputLog,
                upTo: mid,
                rolloutSeed: 777
            });

            // The fork IS the original game at that moment...
            expect(SimulatedGame.fingerprint(sim.game)).toBe(original.fingerprints[mid - 1]);

            // ...and lives its own life from there.
            const continuation = await sim.run();

            expect(continuation.completed).toBe(true);
            expect(continuation.winReason).toBe('keys');
        }, 60000);

        it('plays a learned policy to a legitimate finish', async function () {
            const trained = trainModel(emptyModel(), [
                {
                    winnerSide: PLAYER_ONE,
                    decisions: [
                        {
                            state: { bias: 1 },
                            action: { 'act:reap': 1 },
                            cardId: null,
                            side: PLAYER_ONE
                        }
                    ]
                }
            ]);

            const result = await runSimulatedGame(alphaDeck, omegaDeck, {
                seed: 99,
                policy: trained,
                temperature: 0.7,
                recordDecisions: true
            });

            expect(result.completed).toBe(true);
            expect(result.winnerKeys).toBe(3);
            // The diary: every logged decision carries features, a side and
            // the chosen action - the shape training reads.
            expect(result.decisions.length).toBeGreaterThan(10);
            expect(result.decisions[0].state.bias).toBe(1);
            expect(result.decisions[0].side).toBeDefined();
        }, 30000);
    });

    /**
     * ARCHON (N25): targeting.
     *
     * "Choose a creature to destroy", "steal from whom", "return which card" -
     * most of what one KeyForge player does to another arrives as a selection
     * prompt, and every one of them used to be answered by picking a selectable
     * card at random. They are decisions now.
     */
    describe('targeting', function () {
        it('logs targets as decisions, with the prompt that asked for one', async function () {
            const result = await runSimulatedGame(alphaDeck, omegaDeck, {
                seed: 2468,
                recordDecisions: true
            });

            expect(result.completed).toBe(true);

            const targets = result.decisions.filter(
                (decision) => decision.action['act:select'] === 1
            );

            // A real game asks for targets - if this is ever zero the feature is
            // wired to a prompt that no longer happens.
            expect(targets.length).toBeGreaterThan(0);

            for (const target of targets) {
                // The prompt is what separates "destroy" from "heal", so a
                // target without one is a target the model cannot learn from.
                expect(typeof target.promptKey).toBe('string');
                expect(target.promptKey).toMatch(/\|(mine|theirs)$/);
                // And it knows whose card it is.
                const ownership =
                    target.action['sel:myCard'] === 1 || target.action['sel:theirCard'] === 1;

                expect(ownership).toBe(true);
            }
        }, 60000);

        // Driven directly rather than through a game: what must be proved is
        // that the MODEL decides, and in a real game any given target choice is
        // buried under two hundred others.
        it('takes the target the model rates highest', async function () {
            const sim = new SimulatedGame(alphaDeck, omegaDeck, { seed: 1 });
            const game = { round: 5 };
            const me = {
                name: PLAYER_ONE,
                hand: [],
                cardsInPlay: [],
                creaturesInPlay: [],
                archives: [],
                deck: [],
                amber: 0,
                getForgedKeys: () => 0,
                getCurrentKeyCost: () => 6,
                opponent: null
            };
            const target = (id, power) => ({
                id,
                name: id,
                power,
                armor: 0,
                exhausted: false,
                stunned: false,
                type: 'creature',
                location: 'play area',
                tokens: {},
                cardData: {},
                controller: { name: 'them' }
            });
            const cards = [target('small', 1), target('big', 11)];

            // A model that likes power in an opponent's card: the big one wins.
            sim.policy = { ...emptyModel(), weights: { 'a:sel:theirPower': 6 } };
            sim.temperature = 0;

            expect(await sim.chooseSelection(game, me, cards, 'choose a creature to destroy')).toBe(
                1
            );

            // Flip the weight and the same board yields the other answer, which
            // is what proves the choice is the model's and not the list order.
            sim.policy = { ...emptyModel(), weights: { 'a:sel:theirPower': -6 } };

            expect(await sim.chooseSelection(game, me, cards, 'choose a creature to destroy')).toBe(
                0
            );
        });

        it('is a roll when there is no model, as it always was', async function () {
            const sim = new SimulatedGame(alphaDeck, omegaDeck, { seed: 7 });
            const game = { round: 1 };
            const me = {
                name: PLAYER_ONE,
                hand: [],
                cardsInPlay: [],
                creaturesInPlay: [],
                archives: [],
                deck: [],
                amber: 0,
                getForgedKeys: () => 0,
                getCurrentKeyCost: () => 6,
                opponent: null
            };
            const cards = [1, 2, 3, 4].map((n) => ({
                id: `c${n}`,
                power: n,
                type: 'creature',
                location: 'play area',
                tokens: {},
                cardData: {},
                controller: { name: 'them' }
            }));

            const picked = await sim.chooseSelection(game, me, cards, 'choose a card');

            expect(picked).toBeGreaterThanOrEqual(0);
            expect(picked).toBeLessThan(cards.length);
        });
    });
});
