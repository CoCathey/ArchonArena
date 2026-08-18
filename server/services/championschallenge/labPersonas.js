/**
 * ARCHON (N28): three sparring partners instead of one.
 *
 * The problem this solves is a bias, not a bug. Every sparring game the lab has
 * ever played was piloted by ONE policy, so a deck's win rate has always meant
 * "how this deck does against this bot" - and a deck built to punish that bot's
 * particular habits carried a rating that said it was strong. Nothing in the
 * output could show it. A tidy 62% is a tidy 62% whether it was earned against a
 * varied field or against one opponent's blind spot.
 *
 * So the lab now rotates three pilots, and each of them plays every deck. The
 * rating a deck ends up with is an average over three styles of play rather than
 * a measurement against one, and the SPREAD across the three is a new fact
 * worth having: a deck that wins under the Racer and loses under the Bruiser is
 * a deck whose result depends on the opponent's plan, which is exactly what a
 * single number hides.
 *
 * What a persona IS, precisely
 * ----------------------------
 * One learned brain, three styles. A persona is a small fixed BIAS added to the
 * champion model's weights - nothing is trained separately, nothing forks the
 * learning loop. Three independently trained models would need three diaries,
 * three arenas and three times the games, and would still converge toward the
 * same play, because they would all be trained to win.
 *
 * Two consequences of that, both deliberate:
 *
 *  - **Personas bias ACTION features only.** State features are identical
 *    across every candidate at one decision point, so a state weight cannot
 *    change which move ranks first - a persona built out of state biases would
 *    look meaningful and do nothing.
 *  - **A persona plays slightly worse than the champion**, by construction: it
 *    is pulled away from the policy trained to win. That is the price of
 *    decorrelating the errors of a single pilot, and it is why `personaStrength`
 *    is a dial and why the personas duel each other for calibration - a bias
 *    strong enough to make a persona a bad player measures which decks punish
 *    bad play, which is noise dressed as insight.
 *
 * Keys are a contract - they are stored on every game row. Add, don't rename.
 */

/**
 * The bias keys are the model's own weight keys: `a:` + a feature name that
 * `labFeatures.actionFeatures` actually emits. A typo here is silently inert -
 * the weight applies to a feature that never appears - so the spec checks every
 * key against the extractor's real output rather than trusting this list.
 */
const PERSONAS = [
    {
        key: 'racer',
        label: 'The Racer',
        description:
            'Runs the amber race: reaps at every chance, plays for amber, and takes what is sitting on their creatures',
        bias: {
            'a:act:reap': 0.6,
            'a:act:fight': -0.4,
            'a:act:playCreature': 0.1,
            // Prefer the card that brings amber with it.
            'a:card:amber': 0.5,
            // Given a target, the one carrying amber.
            'a:sel:theirAmberOn': 0.4
        }
    },
    {
        key: 'bruiser',
        label: 'The Bruiser',
        description:
            'Fights for the board: trades creatures, answers the biggest threat, and reaps with whatever survives',
        bias: {
            'a:act:fight': 0.6,
            'a:act:playCreature': 0.4,
            'a:act:reap': -0.3,
            'a:sel:theirPower': 0.4,
            'a:sel:theirCreature': 0.2
        }
    },
    {
        key: 'schemer',
        label: 'The Schemer',
        description: 'Plays the long game: artifacts, abilities and disruption before damage',
        bias: {
            'a:act:useAbility': 0.5,
            'a:act:playArtifact': 0.5,
            'a:act:playAction': 0.3,
            'a:act:reap': -0.1,
            'a:sel:theirArtifact': 0.3
        }
    }
];

const PERSONA_KEYS = PERSONAS.map((persona) => persona.key);

/** The persona with this key, or null - a stored key from a future version. */
function personaByKey(key) {
    return PERSONAS.find((persona) => persona.key === key) || null;
}

/**
 * The champion model, played in one persona's style.
 *
 * Returns a COPY - the champion is shared across every game in a sweep, and a
 * persona that mutated it would quietly restyle the whole lab. Returns null for
 * a null model: with no trained brain the bot plays its heuristics, and a
 * bias-only model would be a third kind of player nobody asked for.
 *
 * @param {object|null} model a labPolicy model
 * @param {object|null} persona from PERSONAS
 * @param {number} [strength] multiplier on the bias; 0 is the champion itself
 * @returns {object|null}
 */
function personaModel(model, persona, strength = 1) {
    if (!model || !persona || !strength) {
        return model || null;
    }

    const weights = { ...(model.weights || {}) };

    for (const [key, bias] of Object.entries(persona.bias)) {
        weights[key] = (weights[key] || 0) + bias * strength;
    }

    return { ...model, weights, persona: persona.key };
}

/**
 * The pilot for game N of a rotation.
 *
 * Round-robin rather than random: with three personas and a few dozen games a
 * day per deck, a coin would leave one persona with half the games of another
 * often enough to matter, and the per-persona records are the point.
 */
function personaFor(index) {
    return PERSONAS[Math.abs(Math.trunc(index || 0)) % PERSONAS.length];
}

/**
 * Every unordered pair of personas, in a fixed order, for the duels that
 * calibrate them against each other.
 */
function personaPairs() {
    const pairs = [];

    for (let i = 0; i < PERSONAS.length; i++) {
        for (let j = i + 1; j < PERSONAS.length; j++) {
            pairs.push([PERSONAS[i], PERSONAS[j]]);
        }
    }

    return pairs;
}

/** The pair for duel N of a rotation, so every pair is measured alike. */
function personaPairFor(index) {
    const pairs = personaPairs();

    return pairs[Math.abs(Math.trunc(index || 0)) % pairs.length];
}

/**
 * The two keys of a duel in a stable order, so one pair is one row rather than
 * two halves of the same record filed under different names.
 */
function duelPairKey(left, right) {
    return [left, right].sort();
}

module.exports = {
    PERSONAS,
    PERSONA_KEYS,
    personaByKey,
    personaModel,
    personaFor,
    personaPairs,
    personaPairFor,
    duelPairKey
};
