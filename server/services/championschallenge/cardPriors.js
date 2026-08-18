const fs = require('fs');
const path = require('path');

const logger = require('../../log');

/**
 * ARCHON (N38): the card priors - what the bot knows before its first game.
 *
 * The learned model's stated blind spot is that it cannot read a card's text:
 * every one of thousands of per-card weights starts at zero and stays shrunk
 * toward zero until the card has been seen ~20 times (labPolicy.SHRINK_PRIOR),
 * so rare cards are played blind for a long time. The priors close that gap
 * from the other end. A one-time job (scripts/generate-card-priors.js) has a
 * language model read every card's actual text and score its competitive
 * impact 0-10; this module turns those scores into logit priors that
 * shrinkage shrinks TOWARD instead of toward zero.
 *
 * Two properties are load-bearing:
 *
 *  - **The file is the deployment.** Scores live in data/cardPriors.json,
 *    generated once, reviewed like code, committed like code. The runtime
 *    never calls an external API, needs no key, and a server without the file
 *    simply plays as it always has - the same posture deckProfile takes
 *    toward DoK.
 *  - **Priors are attached at load, never stored.** Models in BotPolicies
 *    stay lean, and regenerating the file (a new set releases, a better
 *    rubric) takes effect on the next champion load rather than requiring a
 *    retrain. The evidence still wins: a prior's contribution fades with
 *    every observed game, on the same schedule zero used to.
 *
 * The scale: a score of 5 is "average filler" and maps to a prior of exactly
 * 0 - no opinion, the pre-N38 behaviour. The admin's `cardPriorWeight` knob
 * is the logit value of a 10 (and the negated value of a 0); at its default
 * 0.25 a bomb's prior moves a decision's win estimate by about six points,
 * which is a nudge for an unseen card and a rounding error next to twenty
 * games of evidence. Zero switches the priors off without touching the file.
 */

const PRIORS_FILE = path.join(__dirname, 'data', 'cardPriors.json');

/** Raw file cache: { file, scores|null }. Absence is cached too. */
let loaded = null;

/** Mapped cache, keyed by (file, weight) - the knob changes rarely. */
let mapped = null;

/**
 * The raw 0-10 scores from the generated file, or null when the file is
 * absent or unreadable. Never throws: no priors is a supported state.
 */
function priorScores(file = PRIORS_FILE) {
    if (!loaded || loaded.file !== file) {
        let scores = null;

        try {
            if (fs.existsSync(file)) {
                const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));

                if (parsed && parsed.scores && typeof parsed.scores === 'object') {
                    scores = parsed.scores;
                }
            }
        } catch (err) {
            logger.error('Card priors: could not read the priors file', err);
        }

        loaded = { file, scores };
    }

    return loaded.scores;
}

/**
 * The logit priors at a given weight: score 0-10 -> [-weight, +weight],
 * 5 -> 0. Null when priors are off (weight <= 0) or the file is absent.
 */
function cardPriorsAt(weight, file = PRIORS_FILE) {
    const scale = Number(weight);

    if (!Number.isFinite(scale) || scale <= 0) {
        return null;
    }

    if (mapped && mapped.file === file && mapped.weight === scale) {
        return mapped.priors;
    }

    const scores = priorScores(file);

    if (!scores) {
        return null;
    }

    const priors = {};

    for (const [id, score] of Object.entries(scores)) {
        const value = Number(score);

        if (!Number.isFinite(value)) {
            continue;
        }

        priors[id] = ((Math.max(0, Math.min(10, value)) - 5) / 5) * scale;
    }

    mapped = { file, weight: scale, priors };

    return priors;
}

/**
 * A copy of `model` carrying the current priors, shared by reference across
 * every model loaded at this weight. With priors off (or no model) the model
 * comes back without a `cardPriors` key at all - absence, not an empty map,
 * is what "no priors" looks like to labPolicy.
 */
function withCardPriors(model, weight, file = PRIORS_FILE) {
    if (!model) {
        return model;
    }

    const priors = cardPriorsAt(weight, file);

    if (!priors) {
        return stripCardPriors(model);
    }

    return { ...model, cardPriors: priors };
}

/**
 * A copy without priors, for storage: the file is the source of truth, and a
 * stored copy would go stale in the row while looking authoritative.
 */
function stripCardPriors(model) {
    if (!model || !model.cardPriors) {
        return model;
    }

    const rest = { ...model };

    delete rest.cardPriors;

    return rest;
}

/** For tests: drop both caches so a spec can point at its own file. */
function resetCache() {
    loaded = null;
    mapped = null;
}

module.exports = {
    PRIORS_FILE,
    priorScores,
    cardPriorsAt,
    withCardPriors,
    stripCardPriors,
    resetCache
};
