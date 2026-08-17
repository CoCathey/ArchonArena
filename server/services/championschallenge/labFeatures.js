/**
 * ARCHON (N21): what the learning bot can see, written down as numbers.
 *
 * A situation never repeats exactly, so the bot cannot look answers up - it
 * has to generalize, and generalization needs features: the handful of
 * quantities that make two different board states "alike". These are the
 * classic KeyForge ones - the amber race, the key race, board presence,
 * hand resources - each scaled to roughly [0, 1] so one learned weight
 * means about as much as another.
 *
 * Everything here reads only what a seated player could see: own hand, both
 * boards, both amber pools, key states, pile SIZES. Never the opponent's
 * hand or either deck's order - the learned bot must stay a fair player,
 * because it is also the future practice opponent.
 *
 * Kept pure and dependency-free: features go into training rows as plain
 * objects, and a model trained yesterday must read today's features, so
 * KEYS ARE A CONTRACT - rename one and yesterday's model goes quietly
 * blind. Add, don't rename.
 */

/** Feature keys for a game state, from one player's seat. */
function stateFeatures(game, player) {
    const opponent = player.opponent;
    const myCreatures = player.creaturesInPlay || [];
    const oppCreatures = (opponent && opponent.creaturesInPlay) || [];
    const myPower = myCreatures.reduce((sum, c) => sum + (c.power || 0), 0);
    const oppPower = oppCreatures.reduce((sum, c) => sum + (c.power || 0), 0);
    const myKeys = player.getForgedKeys();
    const oppKeys = opponent ? opponent.getForgedKeys() : 0;
    const myCost = player.getCurrentKeyCost();
    const oppCost = opponent ? opponent.getCurrentKeyCost() : 6;

    return {
        bias: 1,
        turn: Math.min(1, (game.round || 0) / 25),
        myAmber: Math.min(1, player.amber / 12),
        oppAmber: opponent ? Math.min(1, opponent.amber / 12) : 0,
        amberDiff: clamp11((player.amber - (opponent ? opponent.amber : 0)) / 8),
        myKeys: myKeys / 3,
        oppKeys: oppKeys / 3,
        keyDiff: clamp11((myKeys - oppKeys) / 2),
        // How close each side is to forging, at their CURRENT cost - the
        // number that decides most endgames.
        myAmberToKey: Math.min(1, Math.max(0, myCost - player.amber) / 8),
        oppAmberToKey: opponent ? Math.min(1, Math.max(0, oppCost - opponent.amber) / 8) : 1,
        myCreatures: Math.min(1, myCreatures.length / 8),
        oppCreatures: Math.min(1, oppCreatures.length / 8),
        myReady: Math.min(1, myCreatures.filter((c) => !c.exhausted).length / 8),
        myPower: Math.min(1, myPower / 30),
        oppPower: Math.min(1, oppPower / 30),
        powerDiff: clamp11((myPower - oppPower) / 20),
        myArtifacts: Math.min(
            1,
            (player.cardsInPlay || []).filter((c) => c.type === 'artifact').length / 5
        ),
        myHand: Math.min(1, player.hand.length / 10),
        oppHand: opponent ? Math.min(1, opponent.hand.length / 10) : 0,
        myArchives: Math.min(1, (player.archives || []).length / 6),
        myDeck: Math.min(1, (player.deck || []).length / 36)
    };
}

function clamp11(value) {
    return Math.max(-1, Math.min(1, value));
}

/** Action kinds the model learns weights for, one-hot. */
const ACTION_KINDS = [
    'playCreature',
    'playArtifact',
    'playAction',
    'playUpgrade',
    'reap',
    'fight',
    'useAbility',
    'discard',
    'endTurn',
    'houseCall',
    // ARCHON (N25): a target for a prompt that is asking for one - destroy
    // this, steal from that, damage the other. These used to be answered by
    // picking a selectable card at random, which is to say the bot played the
    // whole of KeyForge's interaction layer by coin flip.
    'select'
];

/**
 * Features for one candidate action on top of a state.
 *
 * @param {object} params
 * @param {string} params.kind one of ACTION_KINDS
 * @param {object} [params.card] the engine card involved, if any
 * @param {string} [params.house] for house calls
 * @param {object} [params.player] for house calls: counts of that house
 * @returns {{features: Object<string, number>, cardId: string|null}}
 */
function actionFeatures({ kind, card, house, player }) {
    const features = {};

    for (const candidate of ACTION_KINDS) {
        features[`act:${candidate}`] = candidate === kind ? 1 : 0;
    }

    if (card) {
        features['card:amber'] = Math.min(1, (card.cardData ? card.cardData.amber || 0 : 0) / 3);
        features['card:power'] = Math.min(1, (card.power || 0) / 10);
    }

    if (kind === 'houseCall' && house && player) {
        features['house:inHand'] = Math.min(
            1,
            player.hand.filter((c) => c.hasHouse(house)).length / 8
        );
        features['house:ready'] = Math.min(
            1,
            player.cardsInPlay.filter((c) => c.hasHouse(house) && !c.exhausted).length / 8
        );
    }

    // ARCHON (N25): what makes one target better than another.
    //
    // Magnitudes are OWNERSHIP-GATED - `sel:theirPower` and `sel:myPower` are
    // separate keys rather than one power feature plus a "mine" flag - because a
    // linear model cannot otherwise learn that a big creature is a good thing to
    // destroy and a bad thing to sacrifice. Splitting the key gives each side of
    // that its own weight, which is the cheapest possible way to express the
    // interaction that matters most here.
    if (kind === 'select' && card) {
        const mine = !!(player && card.controller && card.controller.name === player.name);
        const side = mine ? 'my' : 'their';
        const power = Math.min(1, (card.power || 0) / 12);
        const amberOn = Math.min(1, ((card.tokens && card.tokens.amber) || 0) / 4);

        features[`sel:${side}Card`] = 1;
        features[`sel:${side}Power`] = power;
        features[`sel:${side}Armor`] = Math.min(1, (card.armor || 0) / 4);
        // Amber sitting on a creature decides who reaps and who steals; it is
        // the single most target-relevant quantity on a KeyForge board.
        features[`sel:${side}AmberOn`] = amberOn;
        features[`sel:${side}Ready`] = card.exhausted ? 0 : 1;
        features[`sel:${side}Stunned`] = card.stunned ? 1 : 0;
        features[`sel:${side}Creature`] = card.type === 'creature' ? 1 : 0;
        features[`sel:${side}Artifact`] = card.type === 'artifact' ? 1 : 0;
        // Where the card is standing changes what selecting it can mean: a hand
        // card is being discarded or played, a discard-pile card returned.
        features[`sel:in:${normalizeLocation(card.location)}`] = 1;
    }

    return {
        features,
        // The per-card learned weight is keyed separately so 2,700 cards do
        // not become 2,700 dense dimensions.
        cardId: card ? card.id || null : null
    };
}

/** Card locations, collapsed to the handful the model can learn from. */
function normalizeLocation(location) {
    const known = ['play area', 'hand', 'discard', 'archives', 'deck', 'purged'];

    return known.includes(location) ? String(location).replace(' ', '-') : 'other';
}

/**
 * The prompt a selection is answering, normalized into a learnable key.
 *
 * Ownership features alone cannot tell "choose a creature to destroy" from
 * "choose a creature to heal" - the board looks identical, and the right target
 * is the opposite one. The prompt's own title is the missing signal, so it gets
 * two weights per prompt (one for picking your own card, one for the
 * opponent's), which is bounded, cheap, and exactly the distinction needed.
 */
function promptKey(title, mine) {
    const normalized = String(title || 'unknown')
        .toLowerCase()
        .replace(/[^a-z ]/g, '')
        .trim()
        .slice(0, 60);

    return `${normalized}|${mine ? 'mine' : 'theirs'}`;
}

/** One decision record, as stored for training and consumed by the model. */
function decisionRecord(game, player, action) {
    const { features, cardId } = actionFeatures({ ...action, player: action.player || player });
    const record = {
        state: stateFeatures(game, player),
        action: features,
        cardId,
        side: player.name,
        turn: game.round || 0
    };

    // Only selections carry a prompt: it is what tells "destroy" from "heal".
    if (action.kind === 'select') {
        const mine = !!(
            action.card &&
            action.card.controller &&
            action.card.controller.name === player.name
        );

        record.promptKey = promptKey(action.prompt, mine);
    }

    return record;
}

module.exports = {
    stateFeatures,
    actionFeatures,
    decisionRecord,
    promptKey,
    ACTION_KINDS
};
