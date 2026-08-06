import { TutorialCards } from './tutorialCards';
import { TutorialDecks } from './tutorialDecks';

/**
 * ARCHON (N11): the tiny game model behind the interactive tutorial at /learn.
 *
 * This is deliberately NOT the real engine. The tutorial replays one fixed,
 * fully scripted game for a reader who may never have seen a card game before,
 * and it has to run in the browser with no server, no socket and no account.
 * What it needs is a board that can be described, highlighted and stepped
 * backwards - not a rules engine.
 *
 * The important property is that the script never fabricates state: every card
 * that appears in a hand was drawn off the top of the deck defined in
 * tutorialDecks.js, damage and Aember are moved by these helpers rather than
 * assigned, and key cost is computed from the board. If a step tried to draw a
 * card the deck could not supply, buildTutorialStates throws in development
 * instead of quietly showing the wrong card.
 */

const HAND_SIZE = 6;

/** The five steps every KeyForge turn runs through, in order. */
export const TurnSteps = [
    'Forge a key',
    'Choose a house',
    'Play, discard, and use cards',
    'Ready cards',
    'Draw cards'
];

const [FORGE_STEP, HOUSE_STEP, MAIN_STEP, READY_STEP, DRAW_STEP] = TurnSteps;

const createPlayer = (deck) => ({
    key: deck.key,
    name: deck.shortName,
    deckName: deck.name,
    houses: deck.houses,
    amber: 0,
    keys: 0,
    activeHouse: null,
    deck: [],
    hand: [],
    discard: [],
    archives: [],
    creatures: [],
    artifacts: [],
    other: []
});

/** A fresh board: both decks boxed up, nothing on the table yet. */
export const createInitialState = () => ({
    turn: 0,
    activePlayer: null,
    phase: null,
    winner: null,
    log: [],
    players: {
        radiant: createPlayer(TutorialDecks.radiant),
        onyx: createPlayer(TutorialDecks.onyx)
    }
});

const other = (side) => (side === 'radiant' ? 'onyx' : 'radiant');
const cardName = (id) => TutorialCards[id]?.name || id;

/**
 * Which deck a card came from. Upgrades can be attached to an enemy creature
 * (Onyx plays Weak Link on Radiant's Commander Chan), and when they are
 * destroyed they go to their *owner's* discard pile, not the controller's.
 */
const ownerOf = (cardId) => (TutorialDecks.radiant.cards.includes(cardId) ? 'radiant' : 'onyx');

const discardTo = (state, ...cardIds) => {
    for (const cardId of cardIds) {
        state.players[ownerOf(cardId)].discard.push(cardId);
    }
};

/** Every card instance on the table, whichever row it is sitting in. */
const permanents = (player) => player.creatures.concat(player.artifacts, player.other);

const findPermanent = (player, cardId) => permanents(player).find((c) => c.id === cardId);

const makePermanent = (cardId, overrides = {}) => ({
    id: cardId,
    exhausted: true,
    damage: 0,
    amber: 0,
    ward: false,
    stun: false,
    upgrades: [],
    ...overrides
});

/** Total armor: printed armor plus anything the attached upgrades add. */
export const armorOf = (permanent) => {
    const printed = TutorialCards[permanent.id]?.armor || 0;
    const fromUpgrades = permanent.upgrades.includes('protect-the-weak') ? 1 : 0;

    return printed + fromUpgrades;
};

/** Total power: printed power plus anything the attached upgrades add. */
export const powerOf = (permanent) => {
    const printed = TutorialCards[permanent.id]?.power || 0;
    const fromUpgrades = permanent.upgrades.includes('blood-of-titans') ? 5 : 0;

    return printed + fromUpgrades;
};

/** Houses a creature belongs to, including any granted by upgrades. */
export const housesOf = (permanent) => {
    const houses = [TutorialCards[permanent.id]?.house];

    if (permanent.upgrades.includes('badge-of-unity') && !houses.includes('staralliance')) {
        houses.push('staralliance');
    }

    return houses;
};

/**
 * The current cost of a key, worked out from the board rather than stored, so
 * the number on screen is always the one the rules would produce.
 *
 * Only the two cost-changing cards in these decks are modelled: Myx, the
 * Tallminded taxes its controller's opponent for each friendly Mars creature,
 * and Weak Link taxes the upgraded creature's controller while it is exhausted.
 */
export const keyCostFor = (state, side) => {
    const me = state.players[side];
    const them = state.players[other(side)];
    let cost = 6;

    if (them.creatures.some((c) => c.id === 'myx-the-tallminded')) {
        cost += them.creatures.filter((c) => housesOf(c).includes('mars')).length;
    }

    for (const creature of me.creatures) {
        if (creature.upgrades.includes('weak-link') && creature.exhausted) {
            cost += 6;
        }
    }

    return cost;
};

// -- log -------------------------------------------------------------------

/** Adds a line to the game log, the way the real board's chat records a game. */
export const note = (state, message) => {
    state.log.push(message);
};

const logFor = (state, side, message) => note(state, `${state.players[side].name} ${message}`);

/** "Radiant's Champion Anaphiel is destroyed" - the possessive form. */
const logOwned = (state, side, message) => note(state, `${state.players[side].name}'s ${message}`);

// -- turn structure --------------------------------------------------------

export const beginTurn = (state, side, turn) => {
    state.turn = turn;
    state.activePlayer = side;
    // Clear both, not just the new active player: a house is only active during
    // the turn it was chosen, and leaving the opponent's lit reads as if two
    // houses were active at once.
    state.players.radiant.activeHouse = null;
    state.players.onyx.activeHouse = null;
    state.phase = FORGE_STEP;
    note(state, `--- Turn ${turn}: ${state.players[side].name} ---`);
};

export const setPhase = (state, phase) => {
    state.phase = phase;
};

export const chooseHouse = (state, side, house) => {
    state.players[side].activeHouse = house;
    state.phase = HOUSE_STEP;
    logFor(state, side, `chooses house ${houseLabel(house)}`);
};

export const houseLabel = (house) =>
    ({
        brobnar: 'Brobnar',
        ekwidon: 'Ekwidon',
        mars: 'Mars',
        sanctum: 'Sanctum',
        staralliance: 'Star Alliance',
        unfathomable: 'Unfathomable'
    }[house] || house);

export const readyAll = (state, side) => {
    state.phase = READY_STEP;
    for (const permanent of permanents(state.players[side])) {
        permanent.exhausted = false;
    }
    logFor(state, side, 'readies their cards');
};

export const forgeKey = (state, side) => {
    const player = state.players[side];
    const cost = keyCostFor(state, side);

    player.amber -= cost;
    player.keys += 1;
    logFor(state, side, `forges a key for ${cost} Æmber (${player.keys} of 3)`);

    if (player.keys >= 3) {
        state.winner = side;
    }
};

// -- deck, hand, piles -----------------------------------------------------

/**
 * Shuffles the discard pile back into an empty deck. `order` is the resulting
 * deck order, top card first; the tutorial states it explicitly so the replay
 * matches the walkthrough instead of depending on a random shuffle.
 */
export const reshuffle = (state, side, order) => {
    const player = state.players[side];
    const discarded = player.discard;

    if (order) {
        const missing = order.filter((id) => !discarded.includes(id));

        if (missing.length || order.length !== discarded.length) {
            throw new Error(
                `Tutorial reshuffle for ${side} does not match the discard pile: ${missing.join(
                    ', '
                )}`
            );
        }
    }

    player.deck = order ? order.slice() : discarded.slice().reverse();
    player.discard = [];
    logFor(state, side, 'shuffles their discard pile to form a new deck');
};

export const draw = (state, side, count = 1) => {
    const player = state.players[side];

    if (player.deck.length < count) {
        throw new Error(
            `Tutorial draw for ${side} wants ${count} cards, deck has ${player.deck.length}`
        );
    }

    const drawn = player.deck.splice(0, count);
    player.hand.push(...drawn);

    return drawn;
};

/** The draw step: refill to six, taking whatever the deck can still give. */
export const drawToHandSize = (state, side, size = HAND_SIZE) => {
    const player = state.players[side];
    const wanted = Math.max(0, size - player.hand.length);
    const drawn = draw(state, side, Math.min(wanted, player.deck.length));

    state.phase = DRAW_STEP;
    logFor(state, side, drawn.length ? `draws ${drawn.length} card(s)` : 'draws no cards');

    return drawn;
};

const removeFromHand = (player, cardId) => {
    const index = player.hand.indexOf(cardId);

    if (index === -1) {
        throw new Error(`Tutorial: ${cardId} is not in ${player.key}'s hand`);
    }

    player.hand.splice(index, 1);
};

export const discardFromHand = (state, side, cardId) => {
    const player = state.players[side];

    state.phase = MAIN_STEP;
    removeFromHand(player, cardId);
    player.discard.push(cardId);
    logFor(state, side, `discards ${cardName(cardId)}`);
};

export const archiveFromHand = (state, side, cardId) => {
    const player = state.players[side];

    removeFromHand(player, cardId);
    player.archives.push(cardId);
    logFor(state, side, `archives ${cardName(cardId)}`);
};

export const takeArchives = (state, side) => {
    const player = state.players[side];

    if (!player.archives.length) {
        return;
    }

    logFor(state, side, `takes ${player.archives.length} card(s) from their archives`);
    player.hand.push(...player.archives);
    player.archives = [];
};

// -- playing cards ---------------------------------------------------------

/**
 * Plays a card out of hand.
 *
 * options.flank  - 'left' | 'right' for creatures (defaults to the right flank)
 * options.index  - explicit battleline slot, for creatures with deploy
 * options.ready  - creature enters play ready (Belligerent Guard)
 * options.attachTo - { side, cardId } for upgrades
 */
export const play = (state, side, cardId, options = {}) => {
    const player = state.players[side];
    const card = TutorialCards[cardId];

    state.phase = MAIN_STEP;
    removeFromHand(player, cardId);

    if (card.type === 'creature') {
        const permanent = makePermanent(cardId, { exhausted: !options.ready });
        const index =
            options.index !== undefined
                ? options.index
                : options.flank === 'left'
                ? 0
                : player.creatures.length;

        player.creatures.splice(index, 0, permanent);
    } else if (card.type === 'artifact') {
        player.artifacts.push(makePermanent(cardId));
    } else if (card.type === 'upgrade') {
        const target = state.players[options.attachTo.side];
        const creature = findPermanent(target, options.attachTo.cardId);

        creature.upgrades.push(cardId);
        logFor(state, side, `plays ${cardName(cardId)} on ${cardName(options.attachTo.cardId)}`);

        return;
    } else {
        player.other.push(makePermanent(cardId, { exhausted: false }));
    }

    logFor(state, side, `plays ${cardName(cardId)}`);
};

/** Moves a resolved action card off the table and into the discard pile. */
export const finishAction = (state, side, cardId) => {
    const player = state.players[side];
    const index = player.other.findIndex((c) => c.id === cardId);

    if (index === -1) {
        throw new Error(`Tutorial: ${cardId} is not resolving for ${side}`);
    }

    player.other.splice(index, 1);
    discardTo(state, cardId);
};

export const exhaust = (state, side, cardId) => {
    findPermanent(state.players[side], cardId).exhausted = true;
};

export const ready = (state, side, cardId) => {
    findPermanent(state.players[side], cardId).exhausted = false;
};

// -- Aember ----------------------------------------------------------------

export const gainAmber = (state, side, amount = 1, reason) => {
    state.players[side].amber += amount;
    logFor(state, side, `gains ${amount} Æmber${reason ? ` (${reason})` : ''}`);
};

export const loseAmber = (state, side, amount = 1, reason) => {
    state.players[side].amber = Math.max(0, state.players[side].amber - amount);
    logFor(state, side, `loses ${amount} Æmber${reason ? ` (${reason})` : ''}`);
};

export const stealAmber = (state, side, amount = 1) => {
    const thief = state.players[side];
    const victim = state.players[other(side)];
    const stolen = Math.min(amount, victim.amber);

    victim.amber -= stolen;
    thief.amber += stolen;
    logFor(state, side, `steals ${stolen} Æmber`);
};

/** Capture: Aember leaves the opponent's pool and sits on one of your creatures. */
export const capture = (state, side, cardId, amount = 1) => {
    const victim = state.players[other(side)];
    const creature = findPermanent(state.players[side], cardId);
    const captured = Math.min(amount, victim.amber);

    victim.amber -= captured;
    creature.amber += captured;
    logFor(
        state,
        side,
        captured
            ? `captures ${captured} Æmber on ${cardName(cardId)}`
            : `captures no Æmber with ${cardName(cardId)} (their opponent's pool is empty)`
    );
};

/** Mother Northelle: move Aember off one of your own creatures into your pool. */
export const moveAmberToPool = (state, side, cardId, amount = 1) => {
    const player = state.players[side];
    const creature = findPermanent(player, cardId);
    const moved = Math.min(amount, creature.amber);

    creature.amber -= moved;
    player.amber += moved;
    logFor(state, side, `moves ${moved} Æmber from ${cardName(cardId)} to their pool`);
};

// -- using creatures -------------------------------------------------------

export const reap = (state, side, cardId) => {
    state.phase = MAIN_STEP;
    exhaust(state, side, cardId);
    state.players[side].amber += 1;
    logFor(state, side, `reaps with ${cardName(cardId)} and gains 1 Æmber`);
};

export const activate = (state, side, cardId, description) => {
    state.phase = MAIN_STEP;
    exhaust(state, side, cardId);
    logFor(state, side, `uses ${cardName(cardId)}${description ? ` to ${description}` : ''}`);
};

/**
 * Applies damage to a creature, letting armor soak what it can, and destroys
 * the creature if the damage on it has reached its power. Returns whether the
 * creature was destroyed so a caller can chain a Destroyed: ability.
 */
export const dealDamage = (state, side, cardId, amount, options = {}) => {
    const player = state.players[side];
    const creature = findPermanent(player, cardId);

    if (!creature) {
        // Already gone - splash damage can arrive after its target was destroyed.
        return false;
    }

    if (creature.ward && amount > 0) {
        creature.ward = false;
        logOwned(state, side, `ward on ${cardName(cardId)} is removed instead of taking damage`);

        return false;
    }

    const soaked = options.ignoreArmor ? 0 : Math.min(armorOf(creature), amount);
    const dealt = amount - soaked;

    creature.damage += dealt;
    logOwned(
        state,
        side,
        `${cardName(cardId)} takes ${dealt} damage${soaked ? ` (${soaked} soaked by armor)` : ''}`
    );

    if (creature.damage >= powerOf(creature)) {
        destroyCreature(state, side, cardId);

        return true;
    }

    return false;
};

export const heal = (state, side, cardId, amount) => {
    const creature = findPermanent(state.players[side], cardId);
    const healed = Math.min(creature.damage, amount);

    creature.damage -= healed;
    logFor(state, side, `heals ${healed} damage from ${cardName(cardId)}`);
};

export const wardCard = (state, side, cardId) => {
    findPermanent(state.players[side], cardId).ward = true;
    logFor(state, side, `wards ${cardName(cardId)}`);
};

export const stun = (state, side, cardId) => {
    findPermanent(state.players[side], cardId).stun = true;
    logOwned(state, side, `${cardName(cardId)} is stunned`);
};

/**
 * Removes a creature from the battleline: its upgrades are discarded with it
 * and any Aember captured on it goes back to the pool it was taken from.
 */
export const destroyCreature = (state, side, cardId) => {
    const player = state.players[side];
    const index = player.creatures.findIndex((c) => c.id === cardId);
    const creature = player.creatures[index];

    if (creature.amber) {
        state.players[other(side)].amber += creature.amber;
        note(
            state,
            `${creature.amber} Æmber captured on ${cardName(cardId)} returns to ${
                state.players[other(side)].name
            }'s pool`
        );
    }

    player.creatures.splice(index, 1);
    discardTo(state, cardId, ...creature.upgrades);
    logOwned(state, side, `${cardName(cardId)} is destroyed`);
};

export const destroyArtifact = (state, side, cardId) => {
    const player = state.players[side];
    const index = player.artifacts.findIndex((c) => c.id === cardId);
    const artifact = player.artifacts[index];

    player.artifacts.splice(index, 1);
    discardTo(state, cardId, ...artifact.upgrades);
    logOwned(state, side, `${cardName(cardId)} is destroyed`);
};

/** `side` is the player whose creature is wearing the upgrade. */
export const destroyUpgrade = (state, side, cardId) => {
    const creature = state.players[side].creatures.find((c) => c.upgrades.includes(cardId));

    creature.upgrades = creature.upgrades.filter((u) => u !== cardId);
    discardTo(state, cardId);
    logOwned(state, ownerOf(cardId), `${cardName(cardId)} is destroyed`);
};

/**
 * A fight between an attacking creature and an enemy creature. Both deal damage
 * equal to their power at the same time, which is why a creature can trade with
 * something bigger than itself.
 */
export const fight = (state, side, attackerId, defenderId, options = {}) => {
    const enemy = other(side);
    const attacker = findPermanent(state.players[side], attackerId);
    const defender = findPermanent(state.players[enemy], defenderId);
    const attackerPower = powerOf(attacker);
    const defenderPower = powerOf(defender);

    state.phase = MAIN_STEP;
    exhaust(state, side, attackerId);
    logFor(state, side, `uses ${cardName(attackerId)} to fight ${cardName(defenderId)}`);

    // Neighbours are read before the fight resolves: splash-attack hits whoever
    // was standing next to the defender when the attack was declared.
    const neighbours = options.splash
        ? neighboursOf(state.players[enemy], defenderId).map((c) => c.id)
        : [];

    // Both creatures deal their damage simultaneously, which is why powers were
    // captured up front - a creature that dies still hits back.
    dealDamage(state, enemy, defenderId, attackerPower);
    dealDamage(state, side, attackerId, defenderPower);

    for (const neighbourId of neighbours) {
        dealDamage(state, enemy, neighbourId, options.splash);
    }
};

/** The creatures immediately either side of a card in a battleline. */
export const neighboursOf = (player, cardId) => {
    const index = player.creatures.findIndex((c) => c.id === cardId);

    return [player.creatures[index - 1], player.creatures[index + 1]].filter(Boolean);
};

// -- building the step states ---------------------------------------------

const clone = (value) =>
    typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));

/**
 * Folds the script into one board state per step, so stepping backwards is a
 * plain array lookup rather than an undo stack.
 */
export const buildTutorialStates = (steps) => {
    const states = [];
    let current = createInitialState();

    for (const step of steps) {
        const next = clone(current);

        if (step.apply) {
            step.apply(next);
        }

        states.push(next);
        current = next;
    }

    return states;
};
