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
});
