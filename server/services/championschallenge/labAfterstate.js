/**
 * ARCHON (N46): judge a move by the position it produces.
 *
 * The fast bot scores each candidate action on its own - a weighted sum of
 * features describing the move and the board it was made on. What it never
 * had was any representation of the CONSEQUENCE. "Reap" scored the same
 * whether reaping took the seat to a key or wasted the last ready creature
 * before a swing, because the score describes the move, not where the move
 * leaves you.
 *
 * That is why the bot reads as not thinking. It is not exploring at random -
 * the live driver plays greedily - it is choosing sensibly among descriptions
 * of moves while having no model of what any of them does.
 *
 * True lookahead is not available here. The deep bot searches by replaying a
 * seeded input log from the start of a simulated game, and a live game against
 * a person has no such log; cloning an arbitrary live position is a much larger
 * piece of work than this. But most of the value of one ply does not need a
 * search at all, because the immediate effect of a KeyForge action is usually
 * known exactly: a reap is an amber and an exhausted creature, whoever is
 * playing and whatever else is happening.
 *
 * So this predicts the CHANGE each action makes to the state features, and the
 * change travels with the record as its own features. The model then learns
 * what a predicted change is worth, which is a different and far more useful
 * thing than learning what a move is called - and it does it inside the same
 * linear model, trained by the same loop, with no change to either.
 *
 * TWO HONEST LIMITS, both deliberate:
 *
 *  - The effects modelled are the mechanical ones the rules guarantee. A card's
 *    TEXT is not read here - "play an action" has no predictable delta, and
 *    inventing one would teach the model a fiction. Those kinds emit nothing
 *    and fall back to the action score they always had, which is no worse than
 *    before.
 *  - Deltas are expressed on the same scales as the state features they
 *    mirror, so a weight learned for `d:amber` is commensurate with the one
 *    learned for `s:myAmber`. Getting that wrong would not error - it would
 *    quietly make one axis dominate.
 */

// The scales `stateFeatures` normalises by. Kept beside the deltas rather than
// imported, because the two must agree and a shared constant that drifts is
// worse than a duplicated one that a spec compares.
const SCALE = {
    amber: 12,
    creatures: 8,
    ready: 8,
    power: 30,
    hand: 10
};

/** A creature's power, tolerating a card-shaped stub. */
const powerOf = (card) => (card && Number.isFinite(card.power) ? card.power : 0);

/**
 * What this action does to the state, as feature-scale deltas.
 *
 * Only the mechanically certain part. Returns an empty object for kinds whose
 * effect depends on card text, which is most of the interesting ones - and
 * saying nothing about those is the point: a guess would be trained on.
 *
 * @param {object} params
 * @param {string} params.kind one of ACTION_KINDS
 * @param {object} [params.card] the engine card involved
 * @param {object} [params.player] the deciding seat
 * @returns {Object<string, number>}
 */
function deltaFeatures({ kind, card, player }) {
    const delta = {};
    const note = (key, value) => {
        if (value) {
            delta[`d:${key}`] = value;
        }
    };

    switch (kind) {
        case 'reap':
            // An amber, and a creature that can no longer do anything this
            // turn. The second half is what makes reaping cost something,
            // and without it the model could only ever learn that amber is
            // good - which is exactly the bias that was beating it.
            note('amber', 1 / SCALE.amber);
            note('ready', -1 / SCALE.ready);
            break;

        case 'fight': {
            // Two creatures trade damage. Whether either dies depends on
            // power and armour, so the certain part is the exhaustion and
            // the power at risk on both sides - modelled as power the board
            // stands to lose rather than a death this cannot predict.
            note('ready', -1 / SCALE.ready);
            note('power', -powerOf(card) / SCALE.power / 2);
            break;
        }

        case 'useAbility':
            // The ability's effect is card text; the exhaustion is not.
            note('ready', -1 / SCALE.ready);
            break;

        case 'playCreature':
            note('creatures', 1 / SCALE.creatures);
            note('power', powerOf(card) / SCALE.power);
            note('hand', -1 / SCALE.hand);
            // Played creatures enter exhausted in KeyForge, so the board
            // grows without this turn's options growing with it.
            break;

        case 'playArtifact':
        case 'playUpgrade':
        case 'playAction':
            // A card leaves hand. Everything else these do is text.
            note('hand', -1 / SCALE.hand);
            break;

        case 'discard':
            note('hand', -1 / SCALE.hand);
            break;

        default:
            // houseCall, endTurn, select, button: no mechanical delta worth
            // claiming. The house call is the biggest decision of a turn and
            // its consequence is the whole rest of the turn, which is not a
            // one-step effect and must not be pretended into one.
            break;
    }

    // The amber a played card carries with it, which is a fact about the card
    // and not about its text - a bonus icon pays whoever plays it.
    if (card && card.cardData && card.cardData.amber && String(kind).startsWith('play')) {
        note('amber', (delta['d:amber'] || 0) + card.cardData.amber / SCALE.amber);
    }

    // How close the seat is to a key AFTER this, which is the delta that
    // matters most and the one no per-action feature could express: an amber
    // is worth much more when it is the sixth than when it is the first.
    if (player && delta['d:amber']) {
        const cost =
            typeof player.getCurrentKeyCost === 'function' ? player.getCurrentKeyCost() : 6;
        const owed = Math.max(0, cost - (player.amber || 0));
        const gained = delta['d:amber'] * SCALE.amber;

        if (gained >= owed && owed > 0) {
            // This move forges. Not a scaled quantity - a threshold crossed,
            // which is what a key is.
            note('forges', 1);
        }
    }

    return delta;
}

module.exports = { deltaFeatures, SCALE };
