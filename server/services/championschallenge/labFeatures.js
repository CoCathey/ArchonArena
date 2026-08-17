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
 * boards, both amber pools, key states, pile SIZES, and the COMPOSITION of
 * its own remaining deck - which a player knows, having built it and
 * watched it. Never the opponent's hand and never either deck's ORDER: the
 * learned bot must stay a player anyone would agree was playing fair,
 * because it is also the practice opponent.
 *
 * Kept pure and dependency-free: features go into training rows as plain
 * objects, and a model trained yesterday must read today's features, so
 * KEYS ARE A CONTRACT - rename one and yesterday's model goes quietly
 * blind. Add, don't rename.
 */

// ARCHON (F3): what a card does, from the canonical card data - the misplay
// review's classifier, so "this card steals" has one answer platform-wide.
const { ROLES, rolesFor } = require('../membership/cardKnowledge');

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
        myDeck: Math.min(1, (player.deck || []).length / 36),
        // The discard pile is not a bin: it becomes the deck again when the
        // deck runs out, and plenty of cards read from it. How full it is
        // says how far through the deck this seat is, which is most of what
        // "late game" means here.
        myDiscard: Math.min(1, (player.discard || []).length / 36),
        /**
         * ARCHON: the opponent forges at the start of their next turn.
         *
         * `oppAmberToKey` already says how far away they are, but "at or
         * past the cost" is a different fact from "two short": it is the
         * one board state where taking a single amber changes what happens
         * next. Worth its own weight, and worth crossing every action with
         * (see ACTION_CONTEXTS) so the model can learn what to do about it
         * rather than only that it is bad.
         */
        oppAtCheck: opponent && opponent.amber >= opponent.getCurrentKeyCost() ? 1 : 0,
        // What is still to come, from a seat that is allowed to know it.
        ...deckFeatures(player)
    };
}

/**
 * ARCHON: what this seat can still DRAW - the deck it built, minus what it
 * has already seen.
 *
 * A player knows their own decklist and has watched their own cards leave
 * it, so the composition of what remains is theirs to reason about; the
 * ORDER of it is not, and nothing here touches that. "Half my deck is
 * creatures and there is a lot of bonus amber left in it" is exactly the
 * kind of thing a person plays around, and it is the difference between a
 * bot that evaluates the board and one that evaluates the game.
 *
 * Fractions of the remaining deck rather than counts, so an early-game
 * reading and a late-game one mean the same thing.
 */
function deckFeatures(player) {
    const deck = player.deck || [];

    if (!deck.length) {
        return { deckCreatures: 0, deckAmber: 0, deckControl: 0 };
    }

    let creatures = 0;
    let amber = 0;
    let control = 0;

    for (const card of deck) {
        if (card.type === 'creature') {
            creatures++;
        }

        amber += (card.cardData && card.cardData.amber) || 0;

        if (rolesFor(card.id).has(ROLES.AMBER_CONTROL)) {
            control++;
        }
    }

    return {
        deckCreatures: creatures / deck.length,
        // Bonus amber per card left; two on one card is already unusual.
        deckAmber: Math.min(1, amber / deck.length / 0.5),
        deckControl: Math.min(1, control / deck.length / 0.25)
    };
}

function clamp11(value) {
    return Math.max(-1, Math.min(1, value));
}

/**
 * Action kinds the model learns weights for, one-hot.
 *
 * `discard` no longer occurs: the shared move list stopped offering "throw
 * a card away" once a bot was seen doing it. It stays in the contract
 * because models trained before that carry a weight under this key.
 */
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
    // ARCHON (F9): activating a prophecy - a card out of hand now for a
    // standing effect that pays later.
    'activateProphecy'
];

/**
 * ARCHON: the board facts that change what a move is WORTH.
 *
 * Why these exist at all: every candidate at one decision shares the same
 * state, so the state's contribution to Q is identical across them and
 * cancels out of the ranking entirely. A model built from state features
 * plus a per-kind weight can therefore learn "playing creatures tends to
 * win games" but never "playing THIS action, HERE, is a waste" - the
 * mistake that had a bot fire a targeted action into an empty board.
 *
 * Crossing the kind with a handful of coarse contexts is what makes that
 * expressible: `x:playAction:noBoard` is a weight the model can push
 * negative without touching `act:playAction`. Coarse and few on purpose -
 * each one is a whole extra column per kind, and a column the Challenge
 * has to fill with games before it means anything.
 *
 * Add contexts, never rename them: a model trained yesterday reads these
 * keys today.
 */
const ACTION_CONTEXTS = {
    /** No creatures of our own - most cards that need a target have none. */
    noBoard: (player) => (player.creaturesInPlay || []).length === 0,
    /** Nothing of theirs to point at either. */
    noEnemy: (player) => !player.opponent || (player.opponent.creaturesInPlay || []).length === 0,
    /** Out-bodied: the board is losing, and trades are worth more. */
    behind: (player) =>
        !!player.opponent &&
        (player.opponent.creaturesInPlay || []).length > (player.creaturesInPlay || []).length,
    /** Enough amber to forge now - one more is worth much less than a key. */
    keyReady: (player) => player.amber >= player.getCurrentKeyCost(),
    /**
     * They forge at the start of their next turn. The context that decides
     * whether a move is worth making at all: crossed with the kind, it is
     * how the model can learn "when they are at check, THIS is what you
     * do" - which is a thing about the position, not about the move.
     */
    oppAtCheck: (player) =>
        !!player.opponent && player.opponent.amber >= player.opponent.getCurrentKeyCost(),
    /**
     * A creature of the active house is still in hand - so the board this
     * turn is not finished yet.
     *
     * This is the ORDER context. Whether a card should be played before or
     * after the creatures is the question every KeyForge turn asks, and
     * "are the creatures still to come" is precisely what separates the two
     * halves of a turn. A board wipe with this true is a wipe played first;
     * the same card with it false is a wipe played over your own board.
     */
    creatureInHand: (player) =>
        player.hand.some(
            (card) =>
                card.type === 'creature' &&
                (!player.activeHouse || card.hasHouse(player.activeHouse))
        ),
    /** Late enough that the discard pile is a resource, not a bin. */
    deepDiscard: (player) => (player.discard || []).length >= 12
};

/** Which of them hold right now. */
function liveContexts(player) {
    return Object.keys(ACTION_CONTEXTS).filter((context) => ACTION_CONTEXTS[context](player));
}

/**
 * ARCHON: the card-knowledge roles, as feature keys.
 *
 * Short, stable names - these become weight keys, and a weight key is a
 * contract with every model trained under it.
 */
const ROLE_KEYS = {
    [ROLES.AMBER_CONTROL]: 'takesAmber',
    [ROLES.BOARD_WIPE]: 'boardWipe',
    [ROLES.KEY_CHEAT]: 'keyCheat',
    [ROLES.CANNOT_REAP]: 'cannotReap',
    // Carries a Fate ability, so burying it under a prophecy buys the
    // prophecy AND a penalty when it comes true.
    [ROLES.HAS_FATE]: 'hasFate'
};

/**
 * Features for one candidate action on top of a state.
 *
 * @param {object} params
 * @param {string} params.kind one of ACTION_KINDS
 * @param {object} [params.card] the engine card involved, if any
 * @param {string} [params.house] for house calls
 * @param {object} [params.player] the deciding seat: house counts, and the
 *        contexts each action kind is crossed with
 * @returns {{features: Object<string, number>, cardId: string|null}}
 */
function actionFeatures({ kind, card, house, player }) {
    const features = {};

    for (const candidate of ACTION_KINDS) {
        features[`act:${candidate}`] = candidate === kind ? 1 : 0;
    }

    if (player) {
        // Only the live crosses are emitted. The rest are absent rather than
        // zero, which reads the same to the model and keeps a record small.
        for (const context of liveContexts(player)) {
            features[`x:${kind}:${context}`] = 1;
        }
    }

    if (card) {
        features['card:amber'] = Math.min(1, (card.cardData ? card.cardData.amber || 0 : 0) / 3);
        features['card:power'] = Math.min(1, (card.power || 0) / 10);

        /**
         * ARCHON: what this card DOES, and when doing it is worth it.
         *
         * The kind ("play an action") is far too coarse to order cards
         * against each other - some actions want to be played before any
         * creature, because their effect would kill the creatures. The
         * roles from the platform's card-knowledge index name that
         * difference, and crossing each with the board contexts is what
         * lets the model learn "a wipe, with a board of my own, is a
         * mistake" as a weight rather than as a rule somebody wrote.
         */
        const live = player ? liveContexts(player) : [];

        for (const role of rolesFor(card.id)) {
            const key = ROLE_KEYS[role];

            if (!key) {
                continue;
            }

            features[`card:${key}`] = 1;

            for (const context of live) {
                features[`x:${key}:${context}`] = 1;
            }
        }

        /**
         * And the same question for THIS card specifically. The per-card
         * weight (cardWeights) says what having played a card is worth on
         * average; these say what it is worth with a board and without
         * one, which is the axis card order actually turns on. Two keys
         * per card at most - the model travels to the game node with every
         * table, so its size is a running cost.
         */
        if (card.id && player) {
            for (const context of ['noBoard', 'noEnemy']) {
                if (ACTION_CONTEXTS[context](player)) {
                    features[`c:${card.id}:${context}`] = 1;
                }
            }
        }
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

    return {
        features,
        // The per-card learned weight is keyed separately so 2,700 cards do
        // not become 2,700 dense dimensions.
        cardId: card ? card.id || null : null
    };
}

/** One decision record, as stored for training and consumed by the model. */
function decisionRecord(game, player, action) {
    // The deciding seat is always the context for the crosses; house calls
    // pass it themselves, and passing it here means every other kind gets
    // it too.
    const { features, cardId } = actionFeatures({ player, ...action });

    return {
        state: stateFeatures(game, player),
        action: features,
        cardId,
        side: player.name,
        turn: game.round || 0
    };
}

module.exports = {
    stateFeatures,
    actionFeatures,
    decisionRecord,
    ACTION_KINDS,
    ACTION_CONTEXTS
};
