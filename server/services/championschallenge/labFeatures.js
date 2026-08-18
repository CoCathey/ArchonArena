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
// ARCHON (N43): how MUCH of it a card does - graded AERC-style axes from the
// committed traits file, absent-tolerant like every other card data source.
const { traitsFor } = require('./cardTraits');

/**
 * ARCHON (N26): the features, computed from a plain VIEW of a position.
 *
 * There is exactly one feature computation on this site, and this is it. The
 * live engine and a recorded replay frame are two different shapes of the same
 * facts, and the temptation is to write a second extractor for the second shape
 * - which is how a model trained on one set of scalings comes to be evaluated
 * against another and produce a confident graph of nothing. So both callers
 * build a view (see `stateFeatures` for the engine, replayValue for a frame) and
 * the arithmetic happens here, once.
 *
 * A view is:
 *   { round, me: SEAT, them: SEAT|null }
 *   SEAT = { amber, keys, keyCost, creatures: [{power, exhausted, amber}],
 *            artifacts, hand, archives, deck }
 * where `artifacts`, `hand`, `archives` and `deck` are COUNTS - a replay knows
 * how many cards a deck holds but not which, and the model never needed to know.
 *
 * KEYS ARE A CONTRACT - a model trained yesterday must read today's features.
 * Add, don't rename.
 */
function stateFeaturesFrom({ round, me, them }) {
    const myCreatures = me.creatures || [];
    const oppCreatures = (them && them.creatures) || [];
    const myPower = myCreatures.reduce((sum, c) => sum + (c.power || 0), 0);
    const oppPower = oppCreatures.reduce((sum, c) => sum + (c.power || 0), 0);
    // ARCHON (N42): board sense. Quality and bounty, not just quantity -
    // computed here so both view builders (engine and replay) get them for
    // free from the creature lists they already carry.
    const maxPower = (creatures) => creatures.reduce((max, c) => Math.max(max, c.power || 0), 0);
    const captured = (creatures) => creatures.reduce((sum, c) => sum + (c.amber || 0), 0);
    const myKeys = me.keys || 0;
    const oppKeys = (them && them.keys) || 0;
    const myCost = me.keyCost;
    const oppCost = them ? them.keyCost : 6;

    return {
        bias: 1,
        turn: Math.min(1, (round || 0) / 25),
        myAmber: Math.min(1, me.amber / 12),
        oppAmber: them ? Math.min(1, them.amber / 12) : 0,
        amberDiff: clamp11((me.amber - (them ? them.amber : 0)) / 8),
        myKeys: myKeys / 3,
        oppKeys: oppKeys / 3,
        keyDiff: clamp11((myKeys - oppKeys) / 2),
        // How close each side is to forging, at their CURRENT cost - the
        // number that decides most endgames.
        myAmberToKey: Math.min(1, Math.max(0, myCost - me.amber) / 8),
        oppAmberToKey: them ? Math.min(1, Math.max(0, oppCost - them.amber) / 8) : 1,
        myCreatures: Math.min(1, myCreatures.length / 8),
        oppCreatures: Math.min(1, oppCreatures.length / 8),
        myReady: Math.min(1, myCreatures.filter((c) => !c.exhausted).length / 8),
        myPower: Math.min(1, myPower / 30),
        oppPower: Math.min(1, oppPower / 30),
        powerDiff: clamp11((myPower - oppPower) / 20),
        /**
         * ARCHON (N42): the board's QUALITY, not just its totals. Eight
         * 1-power tokens and one giant summed the same to this model, and
         * they are opposite boards: the giant is the fight that cannot be
         * won and the removal target that decides the game. The single
         * biggest body on each side is the coarsest honest measure of that.
         */
        myMaxPower: Math.min(1, maxPower(myCreatures) / 12),
        oppMaxPower: Math.min(1, maxPower(oppCreatures) / 12),
        /**
         * ARCHON (N42): amber sitting ON creatures, which the pools never
         * showed. Amber captured on an ENEMY creature is a bounty - kill the
         * body, collect the amber - and on a FRIENDLY one a liability paid
         * out to the opponent the moment it dies. Both change what a fight,
         * a removal target and a race are worth, and both were invisible.
         */
        myCapturedAmber: Math.min(1, captured(myCreatures) / 6),
        oppCapturedAmber: Math.min(1, captured(oppCreatures) / 6),
        myArtifacts: Math.min(1, (me.artifacts || 0) / 5),
        myHand: Math.min(1, (me.hand || 0) / 10),
        oppHand: them ? Math.min(1, (them.hand || 0) / 10) : 0,
        myArchives: Math.min(1, (me.archives || 0) / 6),
        myDeck: Math.min(1, (me.deck || 0) / 36),
        // The discard pile is not a bin: it becomes the deck again when the
        // deck runs out, and plenty of cards read from it. How full it is
        // says how far through the deck this seat is, which is most of what
        // "late game" means here.
        myDiscard: Math.min(1, (me.discard || 0) / 36),
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
        oppAtCheck: them && them.amber >= them.keyCost ? 1 : 0
    };
}

/** The live engine's seat, as a view. */
function seatView(player) {
    if (!player) {
        return null;
    }

    return {
        amber: player.amber,
        keys: player.getForgedKeys(),
        keyCost: player.getCurrentKeyCost(),
        creatures: (player.creaturesInPlay || []).map((card) => ({
            power: card.power,
            exhausted: !!card.exhausted,
            // ARCHON (N42): captured amber rides on the card's tokens. Public
            // information - it sits on the table for both players to count.
            amber: (card.tokens && card.tokens.amber) || 0
        })),
        artifacts: (player.cardsInPlay || []).filter((card) => card.type === 'artifact').length,
        hand: player.hand.length,
        archives: (player.archives || []).length,
        deck: (player.deck || []).length,
        discard: (player.discard || []).length
    };
}

/** Feature keys for a game state, from one player's seat. */
function stateFeatures(game, player) {
    return stateFeaturesFrom({
        round: game.round,
        me: seatView(player),
        them: seatView(player.opponent)
    });
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
    // ARCHON (N25): a target for a prompt that is asking for one - destroy
    // this, steal from that, damage the other. These used to be answered by
    // picking a selectable card at random, which is to say the bot played the
    // whole of KeyForge's interaction layer by coin flip.
    'select',
    // ARCHON (F9): activating a prophecy - a card out of hand now for a
    // standing effect that pays later.
    'activateProphecy',
    /**
     * ARCHON: pressing a button on a prompt the policy has no fixed answer
     * for - "would you like to use this?", "choose a house", the order two
     * triggers resolve in.
     *
     * These were answered by picking a button at random, which is a large
     * slice of KeyForge played by coin flip: nearly every optional ability
     * in the game arrives as one of these. Same treatment `select` got in
     * N25 - the prompt's own title is what tells one from another.
     */
    'button'
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
/**
 * A seat's key cost, from a seat that may be a stand-in.
 *
 * Contexts are computed for anything shaped like a player - the personas
 * spec enumerates every key `actionFeatures` can produce from a skeleton
 * seat - so a missing accessor means "the default cost", not a crash.
 */
function keyCostOf(player) {
    return typeof player.getCurrentKeyCost === 'function' ? player.getCurrentKeyCost() : 6;
}

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
    keyReady: (player) => player.amber >= keyCostOf(player),
    /**
     * They forge at the start of their next turn. The context that decides
     * whether a move is worth making at all: crossed with the kind, it is
     * how the model can learn "when they are at check, THIS is what you
     * do" - which is a thing about the position, not about the move.
     */
    oppAtCheck: (player) =>
        !!player.opponent && player.opponent.amber >= keyCostOf(player.opponent),
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
        (player.hand || []).some(
            (card) =>
                card.type === 'creature' &&
                (!player.activeHouse || card.hasHouse(player.activeHouse))
        ),
    /** Late enough that the discard pile is a resource, not a bin. */
    deepDiscard: (player) => (player.discard || []).length >= 12,
    /**
     * ARCHON (F9): what is still to COME, from a seat entitled to know it.
     *
     * A player built their deck and has watched their own cards leave it, so
     * the composition of what remains is theirs to reason about - the ORDER
     * of it is not, and nothing here touches that. It lives among the
     * contexts rather than among the state features on purpose: a state
     * fact is identical across every candidate at one decision and cancels
     * out of the ranking, so "there are still creatures coming" could never
     * change a move. Crossed with the kind it can, which is the difference
     * between knowing a thing and playing on it.
     *
     * (It also keeps the state features to facts a REPLAY can reconstruct,
     * which is the parity N26 exists to protect: a recording knows a deck's
     * size and not its contents.)
     */
    deckCreatures: (player) => deckShare(player, (card) => card.type === 'creature') >= 0.35,
    deckAmber: (player) =>
        deckShare(player, (card) => ((card.cardData && card.cardData.amber) || 0) > 0) >= 0.25,
    deckControl: (player) =>
        deckShare(player, (card) => rolesFor(card.id).has(ROLES.AMBER_CONTROL)) >= 0.1,
    /**
     * ARCHON (N42): a board wipe is waiting in this hand.
     *
     * The ordering question every KeyForge turn asks - creatures first or
     * the sweeper first - was invisible from the CREATURE's side. The role
     * crosses (x:boardWipe:...) already teach when playing the wipe itself
     * is right, but "dump my board now" and "hold, I am about to wipe" were
     * identical states to every OTHER candidate. Crossed with the kind,
     * this is the weight that lets x:playCreature:wipeInHand go negative
     * without touching what playing creatures is worth in general.
     *
     * Deliberately not gated on the active house: a wipe playable only next
     * turn still argues against overextending into it this turn.
     */
    wipeInHand: (player) =>
        (player.hand || []).some((card) => rolesFor(card.id).has(ROLES.BOARD_WIPE)),
    /**
     * ARCHON (N42): an enemy creature is carrying captured amber.
     *
     * A kill that also collects is a different move from a kill that only
     * trades - crossed with fight and select, this is how the model can
     * learn to send removal at the piggy bank.
     */
    bountyOnBoard: (player) =>
        !!player.opponent &&
        (player.opponent.creaturesInPlay || []).some(
            (card) => ((card.tokens && card.tokens.amber) || 0) > 0
        )
};

/** What fraction of the cards still to be drawn answer to `test`. */
function deckShare(player, test) {
    const deck = player.deck || [];

    return deck.length ? deck.filter(test).length / deck.length : 0;
}

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
function actionFeatures({ kind, card, house, player, button }) {
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
         * ARCHON (N43): the graded version of the roles above. A role says
         * "this card answers creatures"; the axis says how hard, on a shared
         * 0-1 scale borrowed from AERC's taxonomy (scores our own - see
         * cardTraits.js). One `card:ax:creatureControl` weight generalizes
         * across every card that answers creatures, learned from all of them
         * together, where per-card weights need ~20 sightings each to say
         * less. Zeros are omitted, the features' sparse convention.
         */
        const traits = traitsFor(card.id);

        if (traits) {
            for (const [axis, value] of Object.entries(traits)) {
                features[`card:ax:${axis}`] = value;
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

    /**
     * ARCHON: the button's own text, separately from the prompt it answers.
     *
     * The promptKey weight learns "on THIS prompt, that answer" - precise,
     * but it knows nothing until the loop has seen that prompt. This one
     * generalizes: `btn:yes` carries what saying yes to an optional ability
     * is worth ACROSS every prompt, which is what makes the very first
     * unfamiliar prompt better than a coin flip. The set is small and
     * closed - yes, no, done, cancel, a handful of card-specific words - so
     * it costs almost nothing to carry.
     */
    if (kind === 'button' && button) {
        features[`btn:${normalizeText(button, 24)}`] = 1;
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
 * The prompt an answer is answering, normalized into a learnable key.
 *
 * Ownership features alone cannot tell "choose a creature to destroy" from
 * "choose a creature to heal" - the board looks identical, and the right target
 * is the opposite one. The prompt's own title is the missing signal, so it gets
 * one weight per prompt and answer, which is bounded, cheap, and exactly the
 * distinction needed.
 *
 * `variant` is which answer this is: for a selection, whose card was picked
 * (a boolean, kept as 'mine'/'theirs' so every key trained before this note
 * still reads); for a button, the button's own text.
 */
function promptKey(title, variant) {
    const answer =
        typeof variant === 'string' ? normalizeText(variant, 24) : variant ? 'mine' : 'theirs';

    return `${normalizeText(title || 'unknown', 60)}|${answer}`;
}

/** Prompt and button text, reduced to something stable enough to be a key. */
function normalizeText(value, limit) {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z ]/g, '')
        .trim()
        .slice(0, limit);
}

/** One decision record, as stored for training and consumed by the model. */
function decisionRecord(game, player, action) {
    // The deciding seat is always the context for the crosses; house calls
    // and selections pass it themselves, and defaulting it here means every
    // other kind gets it too.
    const { features, cardId } = actionFeatures({ ...action, player: action.player || player });
    const record = {
        state: stateFeatures(game, player),
        action: features,
        cardId,
        side: player.name,
        turn: game.round || 0
    };

    // Selections and buttons carry a prompt: it is what tells "destroy" from
    // "heal", and one optional ability from another.
    if (action.kind === 'select') {
        const mine = !!(
            action.card &&
            action.card.controller &&
            action.card.controller.name === player.name
        );

        record.promptKey = promptKey(action.prompt, mine);
    } else if (action.kind === 'button') {
        record.promptKey = promptKey(action.prompt, action.button || '');
    }

    return record;
}

module.exports = {
    stateFeatures,
    stateFeaturesFrom,
    seatView,
    actionFeatures,
    decisionRecord,
    promptKey,
    ACTION_KINDS,
    ACTION_CONTEXTS
};
