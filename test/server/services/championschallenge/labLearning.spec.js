const {
    emptyModel,
    scoreDecision,
    trainModel,
    shrink,
    SHRINK_PRIOR
} = require('../../../../server/services/championschallenge/labPolicy');
const {
    actionFeatures,
    decisionRecord,
    promptKey,
    ACTION_KINDS
} = require('../../../../server/services/championschallenge/labFeatures');
const { sprt } = require('../../../../server/services/championschallenge/labMath');

/**
 * ARCHON (N25): the four things that were wrong with how the bot learned.
 *
 * Each describe block below pins one of them, and each is a claim about the
 * learning itself rather than about plumbing:
 *
 *  - **Targeting.** Selections used to be answered by picking a selectable card
 *    at random - which is to say the bot played KeyForge's whole interaction
 *    layer by coin flip. Targets are now decisions with features, and the
 *    features must be able to express "the big enemy creature is a good thing
 *    to destroy and a bad thing to sacrifice".
 *  - **Credit assignment.** Labelling every decision with the final result
 *    trains the model against good plays in games that were later thrown away.
 *  - **Evidence.** A weight learned from two observations must not count as much
 *    as one learned from two hundred - the model's own version of the
 *    small-sample rule the hidden-gem badge lives by.
 *  - **Stopping.** A fixed-N test spends the same few hundred arena games on an
 *    obvious answer as on a close one.
 */
describe('the learning loop (N25)', function () {
    // A minimal stand-in for an engine card. Only what the features read.
    const card = (overrides = {}) => ({
        id: 'a-card',
        name: 'A Card',
        power: 4,
        armor: 0,
        exhausted: false,
        stunned: false,
        type: 'creature',
        location: 'play area',
        tokens: {},
        cardData: {},
        controller: { name: 'them' },
        ...overrides
    });

    const player = (name = 'me') => ({
        name,
        hand: [],
        cardsInPlay: [],
        creaturesInPlay: [],
        archives: [],
        deck: [],
        amber: 0,
        getForgedKeys: () => 0,
        getCurrentKeyCost: () => 6,
        opponent: null
    });

    describe('targeting', function () {
        it('offers a target as an action kind the model can weigh', function () {
            expect(ACTION_KINDS).toContain('select');

            const { features } = actionFeatures({ kind: 'select', card: card() });

            expect(features['act:select']).toBe(1);
            expect(features['act:reap']).toBe(0);
        });

        // The whole point of ownership-gated magnitudes: one weight cannot serve
        // both "destroy the big one" and "do not sacrifice the big one".
        it('keeps mine and theirs on separate keys, so power can mean opposite things', function () {
            const me = player();
            const mine = actionFeatures({
                kind: 'select',
                card: card({ controller: { name: 'me' } }),
                player: me
            }).features;
            const theirs = actionFeatures({
                kind: 'select',
                card: card({ controller: { name: 'them' } }),
                player: me
            }).features;

            expect(mine['sel:myPower']).toBeGreaterThan(0);
            expect(mine['sel:theirPower']).toBeUndefined();
            expect(theirs['sel:theirPower']).toBeGreaterThan(0);
            expect(theirs['sel:myPower']).toBeUndefined();
        });

        it('sees the amber sitting on a creature', function () {
            const withAmber = actionFeatures({
                kind: 'select',
                card: card({ tokens: { amber: 3 } }),
                player: player()
            }).features;
            const without = actionFeatures({
                kind: 'select',
                card: card(),
                player: player()
            }).features;

            expect(withAmber['sel:theirAmberOn']).toBeGreaterThan(without['sel:theirAmberOn'] || 0);
        });

        it('records where the card is standing', function () {
            const inHand = actionFeatures({
                kind: 'select',
                card: card({ location: 'hand' }),
                player: player()
            }).features;

            expect(inHand['sel:in:hand']).toBe(1);
            expect(inHand['sel:in:play-area']).toBeUndefined();
        });

        // Two prompts, identical boards, opposite right answers. Without a
        // prompt key the model cannot represent the difference at all.
        it('keys the prompt so "destroy" and "heal" can be learned apart', function () {
            expect(promptKey('Choose a creature to destroy', false)).toBe(
                'choose a creature to destroy|theirs'
            );
            expect(promptKey('Choose a creature to destroy', true)).toBe(
                'choose a creature to destroy|mine'
            );
            // Punctuation and case are noise; the key must not multiply on them.
            expect(promptKey('Choose a Creature to Destroy!', false)).toBe(
                promptKey('choose a creature to destroy', false)
            );
        });

        it('attaches the prompt key to a selection record and nothing else', function () {
            const game = { round: 3 };
            const me = player();
            const selection = decisionRecord(game, me, {
                kind: 'select',
                card: card(),
                prompt: 'choose a creature to destroy'
            });
            const reap = decisionRecord(game, me, { kind: 'reap', card: card() });

            expect(selection.promptKey).toBe('choose a creature to destroy|theirs');
            expect(reap.promptKey).toBeUndefined();
        });

        it('learns which target wins, from outcomes alone', function () {
            const game = { round: 4 };
            const me = player();
            const target = (name, power, controller) =>
                decisionRecord(game, me, {
                    kind: 'select',
                    card: card({ id: name, name, power, controller: { name: controller } }),
                    prompt: 'choose a creature to destroy'
                });

            // Planted signal: destroying the opponent's big creature wins,
            // destroying your own loses. Nothing but the label says so.
            const games = [];

            for (let i = 0; i < 40; i++) {
                games.push({
                    winnerSide: 'me',
                    decisions: [target('their-big', 11, 'them')]
                });
                games.push({
                    winnerSide: 'them',
                    decisions: [target('my-big', 11, 'me')]
                });
            }

            const trained = trainModel(emptyModel(), games, { epochs: 4, lambda: 0 });
            const scoreTheirs = scoreDecision(trained, target('their-big', 11, 'them'));
            const scoreMine = scoreDecision(trained, target('my-big', 11, 'me'));

            expect(scoreTheirs).toBeGreaterThan(scoreMine);
        });
    });

    describe('credit assignment', function () {
        const state = (amber) => ({ bias: 1, myAmber: amber });

        // The failure this fixes: a strong play early in a game that was thrown
        // away later is labelled 0 and trained AGAINST.
        it('lets a strong follow-up position defend a move the game later wasted', function () {
            const model = { ...emptyModel(), weights: { 's:myAmber': 4 } };
            const lostGame = {
                winnerSide: 'them',
                decisions: [
                    { side: 'me', state: state(0), action: { 'act:reap': 1 } },
                    // The same seat, one decision later, in a much better spot.
                    { side: 'me', state: state(1), action: { 'act:reap': 1 } }
                ]
            };

            const outcomeOnly = trainModel(model, [lostGame], { lambda: 0, epochs: 1 });
            const bootstrapped = trainModel(model, [lostGame], { lambda: 0.5, epochs: 1 });

            // Pure outcome pushes the first decision's features hard toward 0;
            // bootstrapping toward the (strong) next state pushes them less.
            expect(bootstrapped.weights['a:act:reap']).toBeGreaterThan(
                outcomeOnly.weights['a:act:reap']
            );
        });

        it('bootstraps from the same seat, not from whoever moved next', function () {
            const model = { ...emptyModel(), weights: { 's:myAmber': 4 } };
            // Each decision carries its OWN action key, so the successor's
            // training cannot touch the weight under test and the only thing
            // that can move it is the label chosen for the first decision.
            const first = { side: 'me', state: state(0), action: { 'act:reap': 1 } };
            const strong = (side) => ({ side, state: state(1), action: { 'act:fight': 1 } });

            const mySuccessor = trainModel(
                model,
                [{ winnerSide: 'them', decisions: [first, strong('me')] }],
                { lambda: 0.5, epochs: 1 }
            );
            const theirSuccessor = trainModel(
                model,
                [{ winnerSide: 'them', decisions: [first, strong('them')] }],
                { lambda: 0.5, epochs: 1 }
            );
            const noSuccessor = trainModel(model, [{ winnerSide: 'them', decisions: [first] }], {
                lambda: 0.5,
                epochs: 1
            });

            // My own strong follow-up lifts the label of the first move...
            expect(mySuccessor.weights['a:act:reap']).toBeGreaterThan(
                noSuccessor.weights['a:act:reap']
            );
            // ...while a position that is strong for the OPPONENT is not my
            // position's value, so it changes nothing.
            expect(theirSuccessor.weights['a:act:reap']).toBeCloseTo(
                noSuccessor.weights['a:act:reap'],
                12
            );
        });

        // Distillation: a measured value outranks any label derived from the
        // final score, because it is about THIS decision.
        it('trains toward a search target when the deep bot supplied one', function () {
            const model = emptyModel();
            const lost = {
                winnerSide: 'them',
                decisions: [{ side: 'me', state: state(0), action: { 'act:reap': 1 } }]
            };
            const lostButMeasuredGood = {
                winnerSide: 'them',
                decisions: [{ side: 'me', state: state(0), action: { 'act:reap': 1 }, target: 0.9 }]
            };

            const labelled = trainModel(model, [lost], { epochs: 1 });
            const distilled = trainModel(model, [lostButMeasuredGood], { epochs: 1 });

            expect(distilled.weights['a:act:reap']).toBeGreaterThan(labelled.weights['a:act:reap']);
        });

        it('refuses a target outside the range a probability can take', function () {
            const model = emptyModel();
            const absurd = {
                winnerSide: 'me',
                decisions: [{ side: 'me', state: state(0), action: { 'act:reap': 1 }, target: 40 }]
            };
            const certain = {
                winnerSide: 'me',
                decisions: [{ side: 'me', state: state(0), action: { 'act:reap': 1 }, target: 1 }]
            };

            expect(trainModel(model, [absurd], { epochs: 1 }).weights['a:act:reap']).toBeCloseTo(
                trainModel(model, [certain], { epochs: 1 }).weights['a:act:reap'],
                12
            );
        });
    });

    describe('evidence', function () {
        it('shrinks a weight toward zero until it has been seen enough', function () {
            expect(shrink(1, 0)).toBe(0);
            expect(shrink(1, SHRINK_PRIOR)).toBeCloseTo(0.5, 6);
            expect(shrink(1, 2000)).toBeGreaterThan(0.98);
            // Sign is never flipped by shrinkage, only magnitude.
            expect(shrink(-1, SHRINK_PRIOR)).toBeCloseTo(-0.5, 6);
        });

        it('counts observations once per batch, not once per epoch', function () {
            const game = {
                winnerSide: 'me',
                decisions: [{ side: 'me', state: { bias: 1 }, action: {}, cardId: 'anger' }]
            };
            const trained = trainModel(emptyModel(), [game], { epochs: 5 });

            expect(trained.cardCounts.anger).toBe(1);
        });

        // The point of the whole mechanism: a card that got lucky three times
        // cannot outrank one measured over hundreds of games.
        it('will not let three lucky games outweigh three hundred', function () {
            const decisionFor = (cardId) => ({
                side: 'me',
                state: { bias: 1 },
                action: {},
                cardId
            });
            const games = [];

            for (let i = 0; i < 3; i++) {
                games.push({ winnerSide: 'me', decisions: [decisionFor('lucky')] });
            }

            for (let i = 0; i < 300; i++) {
                games.push({
                    winnerSide: i % 3 === 0 ? 'them' : 'me',
                    decisions: [decisionFor('proven')]
                });
            }

            const trained = trainModel(emptyModel(), games, { epochs: 2 });
            const effective = (id) => shrink(trained.cardWeights[id], trained.cardCounts[id]);

            // The lucky card's raw weight is the more flattering of the two...
            expect(trained.cardWeights.lucky).toBeGreaterThan(0);
            // ...and after shrinkage it counts for far less.
            expect(effective('proven')).toBeGreaterThan(effective('lucky'));
        });

        it('does not mutate the model it trains from', function () {
            const model = emptyModel();
            const before = JSON.stringify(model);

            trainModel(model, [
                {
                    winnerSide: 'me',
                    decisions: [
                        {
                            side: 'me',
                            state: { bias: 1 },
                            action: { 'act:reap': 1 },
                            cardId: 'anger',
                            promptKey: 'choose|theirs'
                        }
                    ]
                }
            ]);

            expect(JSON.stringify(model)).toBe(before);
        });
    });

    describe('stopping', function () {
        it('crowns a clearly better candidate in tens of games, not hundreds', function () {
            // 40-15 is a 73% record over 55 games: obvious to anyone reading it,
            // and the fixed-N gate this replaced would still have been waiting
            // for game 150.
            const verdict = sprt(40, 15);

            expect(verdict.verdict).toBe('better');
            expect(verdict.llr).toBeGreaterThan(verdict.upper);
        });

        it('retires a clearly worse one just as fast', function () {
            expect(sprt(15, 40).verdict).toBe('no-better');
        });

        // An even candidate is ruled out in tens of games too - which is the
        // half of early stopping that frees the CPU back up. The boundary for a
        // dead-even record sits around game 72 at these bounds.
        it('rules out a coin-flip candidate once there are enough games', function () {
            expect(sprt(20, 20).verdict).toBe('unproven');
            expect(sprt(45, 45).verdict).toBe('unproven');
            expect(sprt(80, 80).verdict).toBe('no-better');
        });

        it('has nothing to say before any games are played', function () {
            expect(sprt(0, 0).verdict).toBe('unproven');
            expect(sprt(0, 0).llr).toBe(0);
        });

        it('keeps a candidate fighting while the record could still go either way', function () {
            expect(sprt(12, 8).verdict).toBe('unproven');
            expect(sprt(30, 25).verdict).toBe('unproven');
        });

        // A 52% record over 200 games is exactly the case the old gate got
        // wrong-footed by: real-looking, but not evidence of the margin claimed.
        it('does not crown a 52% record over 200 games', function () {
            expect(sprt(104, 96).verdict).not.toBe('better');
        });

        it('accumulates - the same record reached in one step or many', function () {
            const once = sprt(30, 10).llr;
            let running = 0;

            for (let i = 0; i < 30; i++) {
                running += sprt(1, 0).llr;
            }

            for (let i = 0; i < 10; i++) {
                running += sprt(0, 1).llr;
            }

            expect(running).toBeCloseTo(once, 10);
        });

        it('reads a record as evidence for the margin it actually shows', function () {
            const modest = sprt(30, 20, { p1: 0.52 });
            const ambitious = sprt(30, 20, { p1: 0.65 });

            // A 60% record barely distinguishes "better than 52%" from an even
            // split, but it is strong evidence against an even split when the
            // alternative on offer is 65% - so the likelihood ratio is larger
            // for the bolder hypothesis, which is why a wide p1 stops early.
            expect(ambitious.llr).toBeGreaterThan(modest.llr);
        });
    });
});
