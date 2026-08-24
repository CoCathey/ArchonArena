/**
 * ARCHON (N53): a model that can learn its own crosses.
 *
 * ## The treadmill this gets off
 *
 * `labPolicy` is logistic regression: Q = sigmoid(w · features). Linear, which
 * has one consequence that has shaped every piece of learning work since N21 -
 * **every candidate at one decision shares a state, so the state's contribution
 * is identical across them and cancels out of the ranking entirely.** A linear
 * model can therefore learn "playing creatures tends to win games" and can
 * never learn "playing THIS, HERE, is a waste", unless somebody writes the
 * interaction down as its own feature.
 *
 * So somebody has, repeatedly. N42 added board-sense crosses, N43 added graded
 * card axes, N45 added a vocabulary for the race, N46 added the afterstate.
 * Each one is a real improvement and each one is another column the Challenge
 * has to fill with games before it means anything - and the list of
 * interactions in a card game with 2,700 cards does not terminate.
 *
 * A hidden layer learns them instead. It costs about two thousand numbers.
 *
 * ## Why it is a CORRECTION and not a replacement
 *
 * The net is added to the linear score, never substituted for it:
 *
 *     z = w · features + cardWeight + promptWeight + net(dense)
 *
 * Three things follow, and all three matter more than the extra accuracy:
 *
 *  - a model with no net scores EXACTLY as it did before, so every champion
 *    ever trained keeps playing the way it played,
 *  - a fresh net starts near zero, so a candidate begins life as the champion
 *    plus noise rather than as a stranger - the arena is measuring a change,
 *    not a replacement, and
 *  - the linear part goes on doing the work it is good at (per-card evidence,
 *    per-prompt evidence, shrinkage toward card-text priors) while the net only
 *    has to learn what is left over.
 *
 * ## Why it stays small
 *
 * A model is a JSON row and it rides to the game node with every table, which
 * is the stated reason `labFeatures` limits the per-card crosses to two. So the
 * input is not the sparse feature space - that is unbounded, with a key per
 * card - but a fixed DENSE vector of the things whose interactions are worth
 * learning: the position, the kind of move, the board contexts it was made in,
 * and the graded facts about the card. Seventy-seven numbers in, one hidden
 * layer, one number out: about two thousand parameters, which is smaller than
 * the per-card weight table the model already carries.
 *
 * THE LAYOUT IS A CONTRACT, exactly as the feature keys are. A net trained
 * yesterday reads today's vector by position, so appending is safe and
 * reordering silently makes a trained model read every input as some other
 * input. Add at the end, never insert.
 */

const { ACTION_KINDS, ACTION_CONTEXTS_KEYS, ROLE_KEY_LIST } = require('./labFeatures');
const { AXES } = require('./cardTraits');

/** Deltas `labAfterstate` predicts, in a fixed order. */
const DELTA_KEYS = ['amber', 'creatures', 'ready', 'power', 'hand', 'forges'];

/** Graded card facts that are not axes. */
const CARD_SCALARS = ['card:amber', 'card:power'];

/** Whether the card's combo partners are on the board or still in hand. */
const SYNERGY_KEYS = ['card:syn:board', 'card:syn:hand'];

/**
 * The dense input, by position. APPEND ONLY - a trained net reads this vector
 * positionally, so inserting anywhere shifts every weight after it onto the
 * wrong input and the model goes quietly, confidently wrong.
 */
function denseLayout(stateKeys) {
    return [
        ...stateKeys.map((key) => `s:${key}`),
        ...ACTION_KINDS.map((kind) => `a:act:${kind}`),
        ...ACTION_CONTEXTS_KEYS.map((context) => `x:${context}`),
        ...AXES.map((axis) => `card:ax:${axis}`),
        ...DELTA_KEYS.map((key) => `d:${key}`),
        ...ROLE_KEY_LIST.map((role) => `card:${role}`),
        ...SYNERGY_KEYS,
        ...CARD_SCALARS
    ];
}

/**
 * Turn one decision record into the dense vector.
 *
 * The contexts are read back out of the crossed action keys (`x:<kind>:<ctx>`)
 * rather than recomputed from the player: a training row is a stored record and
 * the player it came from is long gone, so the only honest source is the row
 * itself - and it means a row and a live decision produce the same vector by
 * construction rather than by two functions agreeing.
 *
 * @param {object} decision a record from `labFeatures.decisionRecord`
 * @param {string[]} layout from `denseLayout`
 * @returns {number[]}
 */
function denseInput(decision, layout) {
    const state = decision.state || {};
    const action = decision.action || {};
    const vector = new Array(layout.length).fill(0);

    // Which contexts were live, whatever kind they were crossed with.
    const contexts = new Set();

    for (const key of Object.keys(action)) {
        if (key.startsWith('x:')) {
            const parts = key.split(':');

            if (parts.length === 3) {
                contexts.add(parts[2]);
            }
        }
    }

    for (let i = 0; i < layout.length; i++) {
        const key = layout[i];

        if (key.startsWith('s:')) {
            vector[i] = state[key.slice(2)] || 0;
        } else if (key.startsWith('x:')) {
            vector[i] = contexts.has(key.slice(2)) ? 1 : 0;
        } else {
            vector[i] = action[key] || 0;
        }
    }

    return vector;
}

/** A tiny deterministic generator, so an init can be reproduced. */
function seededRandom(seed) {
    let state = seed >>> 0;

    return () => {
        state = (state + 0x6d2b79f5) >>> 0;

        let t = state;

        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * A fresh net: small random first layer, small random second.
 *
 * The second layer is deliberately NOT zero, tempting as that is - it would
 * make a new candidate score identically to its champion, and it would also
 * make the first layer's gradient identically zero, so the hidden units would
 * never learn anything at all. Small instead of zero: a candidate starts as the
 * champion plus a whisper, and the arena decides whether the whisper was worth
 * listening to.
 *
 * @param {number} inputs
 * @param {number} [hidden]
 * @param {number} [seed]
 */
function emptyNet(inputs, hidden = 24, seed = 20260824) {
    const random = seededRandom(seed);
    // He-ish scaling for ReLU: keeps the first layer's output variance close to
    // its input's, which is what stops a deeper net from starting saturated.
    const scale = Math.sqrt(2 / Math.max(1, inputs));
    const w1 = [];

    for (let j = 0; j < hidden; j++) {
        const row = new Array(inputs);

        for (let i = 0; i < inputs; i++) {
            row[i] = (random() * 2 - 1) * scale;
        }

        w1.push(row);
    }

    return {
        hidden,
        inputs,
        w1,
        b1: new Array(hidden).fill(0),
        w2: Array.from({ length: hidden }, () => (random() * 2 - 1) * 0.01),
        b2: 0
    };
}

/**
 * The net's contribution to the logit, and the hidden activations it used.
 *
 * Returns both because training needs the activations and scoring does not -
 * and recomputing them in a backward pass is the classic way for a forward and
 * a backward pass to quietly disagree.
 */
function forward(net, vector) {
    const hidden = new Array(net.hidden);
    let z = net.b2;

    for (let j = 0; j < net.hidden; j++) {
        const row = net.w1[j];
        let sum = net.b1[j];

        for (let i = 0; i < row.length && i < vector.length; i++) {
            sum += row[i] * vector[i];
        }

        // ReLU: cheap, and a dead unit is recoverable here because the linear
        // part is carrying the model regardless.
        const activated = sum > 0 ? sum : 0;

        hidden[j] = activated;
        z += net.w2[j] * activated;
    }

    return { z, hidden };
}

/** Just the logit contribution. */
function netScore(net, vector) {
    return forward(net, vector).z;
}

/**
 * One gradient step, in place.
 *
 * `gradient` is dL/dz for the whole model - the same (predicted - label) * pull
 * the linear part uses - because the net is ADDED to that logit, so it shares
 * the derivative exactly. That is the whole reason this composes with the
 * existing trainer without changing it.
 */
function netBackprop(net, vector, hidden, gradient, learningRate, l2) {
    const decay = 1 - learningRate * l2;

    for (let j = 0; j < net.hidden; j++) {
        const activation = hidden[j];
        const dW2 = gradient * activation;
        // Through the ReLU: a unit that was off contributes nothing and learns
        // nothing from this example.
        const dHidden = activation > 0 ? gradient * net.w2[j] : 0;

        net.w2[j] = net.w2[j] * decay - learningRate * dW2;

        if (dHidden !== 0) {
            const row = net.w1[j];

            net.b1[j] = net.b1[j] * decay - learningRate * dHidden;

            for (let i = 0; i < row.length && i < vector.length; i++) {
                if (vector[i] !== 0) {
                    row[i] = row[i] * decay - learningRate * dHidden * vector[i];
                }
            }
        }
    }

    net.b2 -= learningRate * gradient;
}

/** A deep copy, so training a candidate never touches the champion's net. */
function cloneNet(net) {
    if (!net) {
        return null;
    }

    return {
        hidden: net.hidden,
        inputs: net.inputs,
        w1: net.w1.map((row) => [...row]),
        b1: [...net.b1],
        w2: [...net.w2],
        b2: net.b2
    };
}

module.exports = {
    CARD_SCALARS,
    DELTA_KEYS,
    SYNERGY_KEYS,
    cloneNet,
    denseInput,
    denseLayout,
    emptyNet,
    forward,
    netBackprop,
    netScore,
    seededRandom
};
