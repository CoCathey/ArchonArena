const { planHouse, rngFrom } = require('../../../../server/services/botplayer/turnPlanner');
const { determinize, HIDDEN_ZONES } = require('../../../../server/services/botplayer/determinize');
const { BotPolicy } = require('../../../../server/services/botplayer/BotPolicy');
const { fork, refusalReason } = require('../../../../server/game/positionSnapshot');
const { textOf } = require('../../../../server/services/botplayer/decisions');
const { SimulatedGame } = require('../../../../server/services/championschallenge/SimulatedGame');
const {
    getCardIndex,
    cloneCard
} = require('../../../../server/services/championschallenge/packCards');
const { REGISTRY } = require('../../../../server/services/settings/registry');

/**
 * ARCHON (N52): planning the house call.
 *
 * The house call is the one decision the bot could never model - N46: "its
 * consequence is the whole rest of the turn" - and since a position can be
 * copied (N51) it can be answered by finding out instead of guessing.
 *
 * Three properties carry the idea, and each is a way this could look like it
 * works while being wrong or unfair:
 *
 *  - it must not CHEAT. A fork is exact, so it holds the real deck in its real
 *    order, and a planner handed one unmodified calls the house whose cards it
 *    is about to draw - and looks brilliant doing it.
 *  - it must judge every house on the SAME worlds, or a house wins for having
 *    been dealt a better shuffle and the planner measures the deal.
 *  - it must DECLINE rather than half-answer: on a position that cannot be
 *    forked, with no champion to score with, and whenever it could not afford
 *    one world for every house.
 */

function buildDeck(name, houses, offset) {
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
            const card = pool[(i * 7 + offset) % pool.length];

            cards.push({ id: card.id, count: 1, card: cloneCard(card.id) });
        }
    }

    return { name, uuid: `plan-${name}`, expansion: 341, houses, cards };
}

/**
 * A stand-in champion. No trained model exists in a test environment, so this
 * is a value function nobody could call wrong - keys win, amber buys keys,
 * board presence helps a little - plus the two features a house call actually
 * gets, weighted the way `houseScore` weights them.
 *
 * Those last two matter more than they look: without them the model scores
 * every house identically, because state features cancel across candidates at
 * one decision (labFeatures says so), and any comparison against it is a
 * comparison against "always the first house".
 */
const MODEL = {
    version: 1,
    weights: {
        's:keyDiff': 4.0,
        's:myKeys': 3.0,
        's:oppKeys': -3.0,
        's:amberDiff': 1.2,
        's:myAmber': 0.8,
        's:myAmberToKey': -1.5,
        's:powerDiff': 0.5,
        's:myCreatures': 0.4,
        'a:house:inHand': 1.5,
        'a:house:ready': 1.0
    },
    cardWeights: {},
    cardCounts: {},
    promptWeights: {},
    promptCounts: {},
    trainedGames: 1000
};

const alphaDeck = buildDeck('alpha', ['brobnar', 'dis', 'logos'], 0);
const omegaDeck = buildDeck('omega', ['sanctum', 'shadows', 'untamed'], 3);

/** Run a seeded game, handing every forkable house call to `atHouseCall`. */
async function atHouseCalls(atHouseCall, { seed = 8100, maxTurns = 18 } = {}) {
    const sim = new SimulatedGame(alphaDeck, omegaDeck, {
        seed,
        maxTurns,
        analyzer: async ({ game, kind, player }) => {
            if (kind !== 'house' || refusalReason(game)) {
                return null;
            }

            const buttons = (player.promptState.buttons || []).filter((button) => !button.disabled);

            if (buttons.length > 1) {
                await atHouseCall(game, player, buttons);
            }

            return null;
        }
    });

    return sim.run();
}

describe('planning the house call', function () {
    describe('it does not cheat', function () {
        it('shuffles the deciding seat’s own deck, whose order it cannot know', async function () {
            let checked = false;

            await atHouseCalls(async (game, player) => {
                if (checked) {
                    return;
                }

                const copy = fork(game);

                if (!copy.ok) {
                    return;
                }

                const seat = copy.game.getPlayerByName(player.name);

                if (seat.deck.length < 8) {
                    return;
                }

                checked = true;

                const before = seat.deck.map((card) => card.id);

                determinize(copy.game, seat, rngFrom(7));

                const after = seat.deck.map((card) => card.id);

                // The same cards - a seat built its deck and has watched its
                // own cards leave it - in a different order, which is the part
                // it does not know and the part an exact fork would hand it.
                expect([...after].sort()).toEqual([...before].sort());
                expect(after).not.toEqual(before);
            });

            expect(checked).toBe(true);
        }, 120000);

        it('re-deals the opponent’s hidden zones and keeps their sizes', async function () {
            let checked = false;

            await atHouseCalls(async (game, player) => {
                if (checked) {
                    return;
                }

                const copy = fork(game);

                if (!copy.ok) {
                    return;
                }

                const seat = copy.game.getPlayerByName(player.name);
                const enemy = seat.opponent;
                const sizes = HIDDEN_ZONES.map((zone) => enemy[zone].length);
                const pooled = HIDDEN_ZONES.flatMap((zone) =>
                    enemy[zone].map((card) => card.id)
                ).sort();

                if (pooled.length < 8) {
                    return;
                }

                checked = true;

                determinize(copy.game, seat, rngFrom(11));

                // Sizes are public - a hand is a number of cards held, an
                // archive pile has a size - so they survive exactly. WHICH card
                // is where is the hidden part, so that is what is re-rolled.
                expect(HIDDEN_ZONES.map((zone) => enemy[zone].length)).toEqual(sizes);
                expect(
                    HIDDEN_ZONES.flatMap((zone) => enemy[zone].map((card) => card.id)).sort()
                ).toEqual(pooled);

                // And every card listens the way a card in its new zone
                // listens, or the world plays by rules the real game does not.
                for (const zone of HIDDEN_ZONES) {
                    for (const card of enemy[zone]) {
                        expect(card.location).toBe(zone);
                    }
                }
            });

            expect(checked).toBe(true);
        }, 120000);

        it('leaves everything the seat can see exactly as it was', async function () {
            let checked = false;

            await atHouseCalls(async (game, player) => {
                if (checked) {
                    return;
                }

                const copy = fork(game);

                if (!copy.ok) {
                    return;
                }

                checked = true;

                const seat = copy.game.getPlayerByName(player.name);
                const enemy = seat.opponent;
                const visible = () => ({
                    myHand: seat.hand.map((card) => card.id),
                    myPlay: seat.cardsInPlay.map((card) => card.id),
                    theirPlay: enemy.cardsInPlay.map((card) => card.id),
                    theirDiscard: enemy.discard.map((card) => card.id),
                    theirPurged: enemy.purged.map((card) => card.id)
                });
                const before = visible();

                determinize(copy.game, seat, rngFrom(3));

                // A world has to be consistent with everything the seat can
                // see, or it is not a world it could be in.
                expect(visible()).toEqual(before);
            });

            expect(checked).toBe(true);
        }, 120000);
    });

    describe('it judges every house on the same worlds', function () {
        it('gives the same answer twice from the same seed', async function () {
            let checked = false;

            await atHouseCalls(async (game, player, buttons) => {
                if (checked) {
                    return;
                }

                checked = true;

                const options = { policy: MODEL, samples: 2, budgetMs: 5000, seed: 4 };
                const first = planHouse(game, player, buttons, options);
                const second = planHouse(game, player, buttons, options);

                expect(first).not.toBe(null);
                // A planner whose answer moves between two identical calls is
                // measuring its own dice.
                expect(second).toEqual(first);
            });

            expect(checked).toBe(true);
        }, 120000);

        it('scores every house on offer, and picks the best of them', async function () {
            let seen = 0;

            await atHouseCalls(async (game, player, buttons) => {
                if (seen >= 3) {
                    return;
                }

                const plan = planHouse(game, player, buttons, {
                    policy: MODEL,
                    samples: 2,
                    budgetMs: 5000,
                    seed: 6
                });

                if (!plan) {
                    return;
                }

                seen++;

                // Every house or none: preferring the best of whichever
                // happened to fit the budget would quietly favour the ones
                // rolled first.
                expect(plan.values.length).toBe(buttons.length);
                expect(plan.values.map((entry) => entry.house).sort()).toEqual(
                    buttons.map((button) => textOf(button.text)).sort()
                );

                const best = plan.values.reduce((left, right) =>
                    right.value > left.value ? right : left
                );

                expect(plan.house).toBe(best.house);
            });

            expect(seen).toBeGreaterThan(0);
        }, 120000);
    });

    describe('it declines rather than half-answering', function () {
        it('declines without a champion to score with', async function () {
            let checked = false;

            await atHouseCalls(async (game, player, buttons) => {
                if (checked) {
                    return;
                }

                checked = true;

                // Scoring a rolled-out turn needs a value model. Falling back
                // to the plain heuristic would be an expensive way to
                // reproduce the heuristic's own answer.
                expect(planHouse(game, player, buttons, { policy: null })).toBe(null);
            });

            expect(checked).toBe(true);
        }, 120000);

        it('declines when there is nothing to choose between', function () {
            expect(planHouse({}, {}, [{ text: 'logos' }], { policy: MODEL })).toBe(null);
            expect(planHouse({}, {}, [], { policy: MODEL })).toBe(null);
        });

        it('declines on a position that cannot be forked', function () {
            // N51 refuses a position holding an effect it cannot rebuild.
            // Declining is the whole point of that refusal existing.
            const game = {
                started: true,
                winner: null,
                getPlayers: () => [],
                effectEngine: {
                    effects: [{ duration: 'untilPlayerTurnEnd', source: { name: 'something' } }],
                    delayedEffects: [],
                    duringOpponentNextTurnEffects: []
                }
            };

            expect(
                planHouse(game, { name: 'x' }, [{ text: 'logos' }, { text: 'dis' }], {
                    policy: MODEL,
                    samples: 1
                })
            ).toBe(null);
        });
    });

    describe('a rollout’s pilot never plans', function () {
        it('leaves the planner off unless one is asked for', function () {
            // A plan that planned would start a second planner at the first
            // house call inside the first rollout, and a third inside that.
            expect(new BotPolicy({}).planner).toBe(null);
            expect(new BotPolicy({ policy: MODEL }).planner).toBe(null);
        });

        it('is off in the shipped settings', function () {
            // Measured, not merely cautious: against a stand-in value model
            // the planner changed the house call on 41% of turns - so the
            // search works - and won 51% of paired games, which is no
            // improvement. A bot must never quietly get worse.
            expect(REGISTRY.bots.fields.planHouseCall.default).toBe(false);
            expect(REGISTRY.bots.fields.planSamples.default).toBeGreaterThan(1);
            expect(REGISTRY.bots.fields.planBudgetMs.default).toBeGreaterThan(0);
        });
    });
});
