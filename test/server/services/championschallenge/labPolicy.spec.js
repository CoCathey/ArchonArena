const {
    emptyModel,
    scoreDecision,
    scoreState,
    trainModel,
    chooseDecision
} = require('../../../../server/services/championschallenge/labPolicy');

// The learning loop's arithmetic, pinned with synthetic games: plant a
// signal ("reaping wins, discarding loses", "one card is great"), train
// from nothing, and prove the model finds it. If these move, the bot's
// ability to learn moved.

describe('labPolicy', function () {
    const state = { bias: 1, myAmber: 0.5, oppAmber: 0.5 };

    const decision = (kind, cardId = null, side = 'challenger-alpha') => ({
        state,
        action: { [`act:${kind}`]: 1 },
        cardId,
        side
    });

    /**
     * Synthetic diary: games where alpha reaps and wins while omega
     * discards and loses - plus a "great card" alpha always plays.
     */
    const plantedGames = (count) =>
        Array.from({ length: count }, () => ({
            winnerSide: 'challenger-alpha',
            decisions: [
                decision('reap', null, 'challenger-alpha'),
                decision('playCreature', 'great-card', 'challenger-alpha'),
                decision('discard', null, 'challenger-omega'),
                decision('playCreature', 'poor-card', 'challenger-omega')
            ]
        }));

    it('learns a planted signal: winners’ moves score above losers’ moves', function () {
        const model = trainModel(emptyModel(), plantedGames(200));

        expect(scoreDecision(model, decision('reap'))).toBeGreaterThan(0.6);
        expect(scoreDecision(model, decision('discard'))).toBeLessThan(0.4);
        expect(scoreDecision(model, decision('reap'))).toBeGreaterThan(
            scoreDecision(model, decision('discard'))
        );
    });

    it('learns per-card worth from nothing but outcomes', function () {
        const model = trainModel(emptyModel(), plantedGames(200));

        expect(model.cardWeights['great-card']).toBeGreaterThan(0);
        expect(model.cardWeights['poor-card']).toBeLessThan(0);
        expect(scoreDecision(model, decision('playCreature', 'great-card'))).toBeGreaterThan(
            scoreDecision(model, decision('playCreature', 'poor-card'))
        );
    });

    it('never mutates the model it was given', function () {
        const base = emptyModel();
        const trained = trainModel(base, plantedGames(10));

        expect(base.trainedGames).toBe(0);
        expect(Object.keys(base.weights)).toHaveLength(0);
        expect(trained.version).toBe(base.version + 1);
        expect(trained.trainedGames).toBe(10);
    });

    it('scores a bare state for the planner’s horizon', function () {
        const model = trainModel(emptyModel(), plantedGames(50));
        const value = scoreState(model, state);

        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThan(1);
    });

    describe('chooseDecision', function () {
        const model = trainModel(emptyModel(), plantedGames(200));
        const candidates = [decision('discard'), decision('reap')];

        it('is argmax when greedy', function () {
            expect(chooseDecision(model, candidates, 0, () => 0.99)).toBe(1);
        });

        it('explores at temperature: sometimes takes the worse move', function () {
            const picks = new Set();
            let roll = 0.01;

            for (let i = 0; i < 50; i++) {
                roll = (roll + 0.02) % 1;
                picks.add(chooseDecision(model, candidates, 1.5, () => roll));
            }

            expect(picks.has(0)).toBe(true);
            expect(picks.has(1)).toBe(true);
        });

        it('handles an empty candidate list', function () {
            expect(chooseDecision(model, [], 0, () => 0.5)).toBe(-1);
        });
    });

    /**
     * ARCHON: a decision the deep bot MEASURED against one merely labelled
     * by who won.
     *
     * The fast bot outproduces the deep bot by orders of magnitude, so if
     * both push the weights equally hard the measured signal is drowned by
     * the volume of the noisy one - and the measured signal is the only one
     * that can teach move ORDER, because an outcome label cannot tell a good
     * turn-3 play in a lost game from a bad one.
     */
    describe('a searched decision against a played one', function () {
        // The same move, in one game where the search measured it as losing
        // and one where the final score happened to call it winning.
        const measured = () => ({
            winnerSide: 'challenger-alpha',
            decisions: [{ ...decision('reap'), target: 0 }]
        });
        const played = () => ({
            winnerSide: 'challenger-alpha',
            decisions: [decision('reap')]
        });
        const scoreAfter = (games, options) =>
            scoreDecision(trainModel(emptyModel(), games, options), decision('reap'));

        it('pulls harder than the same evidence from an outcome', function () {
            const measuredOnly = scoreAfter([measured()], { epochs: 1 });
            const playedOnly = scoreAfter([played()], { epochs: 1 });

            // One says "this was worth nothing", the other "this was in a
            // won game"; both from a blank model, so the distance each moved
            // from 0.5 is exactly how hard it pulled.
            expect(Math.abs(measuredOnly - 0.5)).toBeGreaterThan(Math.abs(playedOnly - 0.5));
        });

        it('outweighs several games of outcome labels saying otherwise', function () {
            const games = [measured(), played(), played(), played(), played()];

            expect(scoreAfter(games, { epochs: 1 })).toBeLessThan(0.5);
        });

        it('is one-for-one again at a weight of 1', function () {
            const games = [measured(), played(), played(), played(), played()];

            // The pre-change behaviour, kept reachable: four outcome labels
            // against one measured target, and the outcomes win.
            expect(scoreAfter(games, { epochs: 1, targetWeight: 1 })).toBeGreaterThan(0.5);
        });

        // ARCHON (N38): a lesson may carry its own pull, so a provisional
        // teacher's rows can be turned down without touching the deep bot's.
        it('honors a per-decision weight over the batch targetWeight', function () {
            const weighted = (weight) => [
                {
                    winnerSide: 'challenger-alpha',
                    decisions: [{ ...decision('reap'), target: 0, weight }]
                }
            ];
            const gentle = scoreAfter(weighted(1), { epochs: 1 });
            const firm = scoreAfter(weighted(8), { epochs: 1 });

            expect(Math.abs(firm - 0.5)).toBeGreaterThan(Math.abs(gentle - 0.5));
            // Weight zero is a row that teaches nothing at all.
            expect(scoreAfter(weighted(0), { epochs: 1 })).toBeCloseTo(0.5, 5);
        });
    });

    /**
     * ARCHON (N38): the card priors - what shrinkage shrinks TOWARD.
     *
     * A model may carry `cardPriors` from the one-time card reading job. An
     * unseen card contributes its prior in full; each observed game moves the
     * contribution from what the text suggested toward what the games
     * measured; and a model with no priors behaves exactly as before.
     */
    describe('card priors', function () {
        const {
            shrink,
            SHRINK_PRIOR
        } = require('../../../../server/services/championschallenge/labPolicy');

        it('an unseen card scores its prior in full', function () {
            expect(shrink(0, 0, 0.3)).toBeCloseTo(0.3, 10);
            expect(shrink(undefined, undefined, -0.2)).toBeCloseTo(-0.2, 10);
        });

        it('evidence pulls the contribution from the prior toward the weight', function () {
            // At exactly SHRINK_PRIOR observations the answer is halfway.
            expect(shrink(0.5, SHRINK_PRIOR, 0.1)).toBeCloseTo(0.3, 10);
            // Heavily seen: nearly all learned weight, prior nearly gone.
            expect(shrink(0.5, 2000, 0.1)).toBeGreaterThan(0.49 * 0.98);
        });

        it('no prior is exactly the old shrinkage', function () {
            expect(shrink(0.5, 10, 0)).toBeCloseTo(0.5 * (10 / (10 + SHRINK_PRIOR)), 10);
            expect(shrink(0, 5, 0)).toBe(0);
        });

        it('scoreDecision reads a prior for a card the model never saw', function () {
            const blank = emptyModel();
            const primed = { ...emptyModel(), cardPriors: { 'unseen-card': 0.8 } };
            const move = decision('playCreature', 'unseen-card');

            expect(scoreDecision(primed, move)).toBeGreaterThan(scoreDecision(blank, move));
        });

        it('training carries priors forward and still learns past them', function () {
            const primed = { ...emptyModel(), cardPriors: { 'poor-card': 0.5 } };
            const trained = trainModel(primed, plantedGames(200));

            expect(trained.cardPriors).toEqual({ 'poor-card': 0.5 });
            // The games say the card loses; enough of them outvote the prior.
            expect(
                scoreDecision(trained, decision('playCreature', 'poor-card', 'challenger-omega'))
            ).toBeLessThan(0.5);
        });
    });
});
