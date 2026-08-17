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
    return {
        version: 0,
        weights: {},
        cardWeights: {},
        // ARCHON (N25): two weights per distinct prompt (pick mine / pick
        // theirs), which is what separates "choose a creature to destroy" from
        // "choose a creature to heal" - see labFeatures.promptKey.
        promptWeights: {},
        // How many examples each sparse weight has actually seen. A weight
        // trained on two observations is noise, and there are ~2,700 card ids;
        // counts are what let scoring shrink the unproven ones toward zero
        // instead of trusting them equally (see shrink).
        cardCounts: {},
        promptCounts: {},
        trainedGames: 0
    };
}

/**
 * Empirical-Bayes shrinkage: a sparse weight counts for how much evidence
 * stands behind it.
 *
 * A card seen twice contributes about a tenth of its learned weight, one seen a
 * hundred times contributes nearly all of it. Without this, a card that
 * happened to appear in three winning games outranks one measured over
 * thousands - which is the same mistake the hidden-gem badge refuses to make
 * with decks, applied to the model's own parameters.
 */
const SHRINK_PRIOR = 20;

function shrink(weight, count) {
    if (!weight) {
        return 0;
    }

    const seen = count || 0;

    return weight * (seen / (seen + SHRINK_PRIOR));
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
        z += shrink(model.cardWeights[decision.cardId], (model.cardCounts || {})[decision.cardId]);
    }

    if (decision.promptKey) {
        z += shrink(
            (model.promptWeights || {})[decision.promptKey],
            (model.promptCounts || {})[decision.promptKey]
        );
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
 * ARCHON (N25): what a decision is trained toward.
 *
 * Three sources of truth, in order of how much they know:
 *
 *  1. **A search target.** The deep bot forked this decision, played the move,
 *     rolled the future forward and measured where it led. That number is worth
 *     more than any label derived from the final score, and training the fast
 *     policy toward it is how a minute of thinking becomes permanent knowledge
 *     (see DeepGame's lessons).
 *  2. **The outcome, blended with what came next.** Labelling every decision
 *     with the final result is Monte Carlo credit assignment at its bluntest: a
 *     good play on turn 3 of a game thrown away on turn 20 trains the model
 *     AGAINST itself. So the label leans partly on the value of the position
 *     the same seat found itself in at its next decision - a TD-style target,
 *     which keeps the outcome as the anchor while letting a strong position
 *     defend a move the game later wasted.
 *  3. **The outcome alone**, for the last decision of a game (nothing came
 *     next) and whenever bootstrapping is switched off.
 *
 * `valueOf` is evaluated with the PRE-TRAINING model, frozen for the batch, so
 * targets do not chase the weights they are updating.
 */
function decisionTarget(decision, nextDecision, outcome, lambda, valueOf) {
    if (typeof decision.target === 'number') {
        return Math.max(0, Math.min(1, decision.target));
    }

    if (!lambda || !nextDecision) {
        return outcome;
    }

    const bootstrapped = valueOf(nextDecision.state);

    return (1 - lambda) * outcome + lambda * bootstrapped;
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
 * @param {number} [options.lambda] how far to lean on the next state's value
 *        (0 = pure outcome, the pre-N25 behaviour)
 * @param {number} [options.targetWeight] how much harder a search-measured
 *        decision pulls than an outcome-labelled one
 * @returns {object} the trained model
 */
function trainModel(
    model,
    games,
    { learningRate = 0.05, epochs = 2, l2 = 1e-4, lambda = 0.5, targetWeight = 8 } = {}
) {
    const next = {
        version: (model.version || 0) + 1,
        weights: { ...model.weights },
        cardWeights: { ...model.cardWeights },
        promptWeights: { ...(model.promptWeights || {}) },
        cardCounts: { ...(model.cardCounts || {}) },
        promptCounts: { ...(model.promptCounts || {}) },
        trainedGames: (model.trainedGames || 0) + games.length
    };
    // Frozen for the whole batch: a bootstrapped target computed from the
    // weights currently being updated would chase its own tail.
    const frozen = {
        weights: { ...model.weights },
        cardWeights: { ...model.cardWeights },
        promptWeights: { ...(model.promptWeights || {}) },
        cardCounts: { ...(model.cardCounts || {}) },
        promptCounts: { ...(model.promptCounts || {}) }
    };
    const valueOf = (state) => scoreState(frozen, state);

    // Counts are evidence, not iterations: one pass over the batch, however
    // many epochs the gradient takes.
    for (const game of games) {
        for (const decision of game.decisions || []) {
            if (decision.cardId) {
                next.cardCounts[decision.cardId] = (next.cardCounts[decision.cardId] || 0) + 1;
            }

            if (decision.promptKey) {
                next.promptCounts[decision.promptKey] =
                    (next.promptCounts[decision.promptKey] || 0) + 1;
            }
        }
    }

    for (let epoch = 0; epoch < epochs; epoch++) {
        for (const game of games) {
            const decisions = game.decisions || [];

            for (let i = 0; i < decisions.length; i++) {
                const decision = decisions[i];
                const outcome = decision.side === game.winnerSide ? 1 : 0;
                // The same seat's NEXT decision - not simply the next record,
                // which usually belongs to the opponent and whose value is
                // therefore the wrong way up.
                const nextForSide = decisions
                    .slice(i + 1)
                    .find((entry) => entry.side === decision.side);
                const label = decisionTarget(decision, nextForSide, outcome, lambda, valueOf);
                const predicted = scoreDecision(next, decision);
                /**
                 * ARCHON: a measured decision counts for more than a guessed
                 * one.
                 *
                 * Two kinds of row arrive here. One carries a number the deep
                 * bot established by forking the position, playing the move
                 * and rolling the future forward. The other carries "this
                 * appeared in a game somebody won" - which for a play on turn
                 * 3 of a game thrown away on turn 20 is noise pointing the
                 * wrong way. They used to push the weights equally hard, and
                 * since the fast bot outproduces the deep bot by orders of
                 * magnitude, the signal was drowned by the noise no matter
                 * how much search was bought.
                 *
                 * The weight goes on the GRADIENT, not on the decay: L2 is a
                 * property of the weights, not of the evidence. Counts stay
                 * unweighted too - one observation is one observation, and
                 * inflating them would under-shrink a card seen once.
                 */
                const measured = typeof decision.target === 'number';
                // Logistic loss gradient: (p - y) times each feature.
                const gradient = (predicted - label) * (measured ? targetWeight : 1);

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

                if (decision.promptKey) {
                    next.promptWeights[decision.promptKey] =
                        (next.promptWeights[decision.promptKey] || 0) * (1 - learningRate * l2) -
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

module.exports = {
    emptyModel,
    scoreDecision,
    scoreState,
    trainModel,
    chooseDecision,
    shrink,
    sigmoid,
    SHRINK_PRIOR
};
