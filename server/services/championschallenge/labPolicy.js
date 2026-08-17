/**
 * ARCHON (N21): the learned policy - a model that turns a decision into a
 * number, and the training that sharpens it.
 *
 * The model is deliberately the simplest thing that can learn: logistic
 * regression over the lab's features, plus one learned weight per card id.
 * Q(state, action) = sigmoid(w · features + cardWeight) estimates "from
 * spots like this, doing things like that, how often did we go on to win?".
 * Every finished game turns its logged decisions into labeled examples -
 * decisions from the winning seat are pulled toward 1, the losing seat
 * toward 0 - and stochastic gradient descent does the rest. Noisy per game,
 * convergent over thousands, and thousands are what the Challenge produces.
 *
 * Why not a neural network: this trains in-process, in milliseconds, with
 * no dependency, no GPU and no serialization risk - a model is a JSON row.
 * The per-card weights are where the "unique abilities" live at this stage:
 * the bot cannot read a card's text, but ten thousand games of playing it
 * teach the model precisely what having played it is worth. The deep
 * planner (SimulatedFork) is what takes abilities literally, by executing
 * them; this model is what it scores the results with.
 *
 * Pure functions over plain objects throughout, so the whole learning loop
 * is unit-testable with synthetic data - the spec plants a signal and
 * proves training finds it.
 */

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** A fresh, know-nothing model. */
function emptyModel() {
    return { version: 0, weights: {}, cardWeights: {}, trainedGames: 0 };
}

/**
 * Q(s, a): the model's estimate that the deciding seat goes on to win.
 *
 * @param {object} model
 * @param {{state: object, action: object, cardId: string|null}} decision
 * @returns {number} in (0, 1)
 */
function scoreDecision(model, decision) {
    let z = 0;

    for (const [key, value] of Object.entries(decision.state || {})) {
        z += (model.weights[`s:${key}`] || 0) * value;
    }

    for (const [key, value] of Object.entries(decision.action || {})) {
        z += (model.weights[`a:${key}`] || 0) * value;
    }

    if (decision.cardId) {
        z += model.cardWeights[decision.cardId] || 0;
    }

    return sigmoid(z);
}

/**
 * The state alone, no action - what the planner scores rollout horizons
 * with. Same weights, action features all zero.
 */
function scoreState(model, state) {
    return scoreDecision(model, { state, action: {}, cardId: null });
}

/**
 * Fold one batch of finished games into a COPY of the model.
 *
 * @param {object} model the current model (not mutated)
 * @param {{winnerSide: string, decisions: object[]}[]} games logged games
 * @param {object} [options]
 * @param {number} [options.learningRate]
 * @param {number} [options.epochs]
 * @param {number} [options.l2] weight decay, keeps card weights from memorizing
 * @returns {object} the trained model
 */
function trainModel(model, games, { learningRate = 0.05, epochs = 2, l2 = 1e-4 } = {}) {
    const next = {
        version: (model.version || 0) + 1,
        weights: { ...model.weights },
        cardWeights: { ...model.cardWeights },
        trainedGames: (model.trainedGames || 0) + games.length
    };

    for (let epoch = 0; epoch < epochs; epoch++) {
        for (const game of games) {
            for (const decision of game.decisions || []) {
                const label = decision.side === game.winnerSide ? 1 : 0;
                const predicted = scoreDecision(next, decision);
                // Logistic loss gradient: (p - y) times each feature.
                const gradient = predicted - label;

                for (const [key, value] of Object.entries(decision.state || {})) {
                    const weightKey = `s:${key}`;

                    next.weights[weightKey] =
                        (next.weights[weightKey] || 0) * (1 - learningRate * l2) -
                        learningRate * gradient * value;
                }

                for (const [key, value] of Object.entries(decision.action || {})) {
                    if (!value) {
                        continue;
                    }

                    const weightKey = `a:${key}`;

                    next.weights[weightKey] =
                        (next.weights[weightKey] || 0) * (1 - learningRate * l2) -
                        learningRate * gradient * value;
                }

                if (decision.cardId) {
                    next.cardWeights[decision.cardId] =
                        (next.cardWeights[decision.cardId] || 0) * (1 - learningRate * l2) -
                        learningRate * gradient;
                }
            }
        }
    }

    return next;
}

/**
 * Choose among candidate decisions.
 *
 * Training games explore: softmax over Q at `temperature`, so the bot
 * mostly does what looks best but keeps sampling alternatives - a policy
 * that never explores can never learn it was wrong. Arena, showcase and
 * practice play are greedy: temperature 0 means argmax, no dice.
 *
 * @param {object} model
 * @param {object[]} decisions candidate decision records
 * @param {number} temperature 0 = greedy
 * @param {function} rng () => [0,1)
 * @returns {number} index of the chosen candidate
 */
function chooseDecision(model, decisions, temperature, rng) {
    if (!decisions.length) {
        return -1;
    }

    const scores = decisions.map((decision) => scoreDecision(model, decision));

    if (!temperature || temperature <= 0) {
        let best = 0;

        for (let i = 1; i < scores.length; i++) {
            if (scores[i] > scores[best]) {
                best = i;
            }
        }

        return best;
    }

    const max = Math.max(...scores);
    const weights = scores.map((score) => Math.exp((score - max) / temperature));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let roll = rng() * total;

    for (let i = 0; i < weights.length; i++) {
        roll -= weights[i];

        if (roll <= 0) {
            return i;
        }
    }

    return weights.length - 1;
}

module.exports = { emptyModel, scoreDecision, scoreState, trainModel, chooseDecision, sigmoid };
