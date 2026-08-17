/**
 * ARCHON: what a bot may do right now, enumerated once for every bot.
 *
 * Both drivers ask this question and their answers must agree exactly:
 *
 *  - The Champion's Challenge lab (N21) enumerates candidates, scores them
 *    with the learned model, and - in a deep game - forks the game to try
 *    them. A fork must enumerate the same list in the same order, or
 *    "candidate 3" means different moves in different worlds.
 *  - The practice bots (F9) enumerate the same list on a live table and
 *    score it with the same model, so the opponent a player meets in the
 *    lobby plays the play the lab learned.
 *
 * Keeping it in one module is what makes those two the same bot. The list
 * is every move the engine would offer a human from the main window and
 * nothing else: play a card, bin a card, use what is in play, activate a
 * prophecy. Moves are not left out for being usually wrong - binning a
 * card and firing a board wipe over your own creatures are both real
 * moves, occasionally right, and a move that is not enumerated is one no
 * policy can ever learn to make.
 *
 * What decides between them is the ORDER, which lives here too, along with
 * the combat arithmetic and the reading of the amber race behind it. That
 * order is what plays when a site has no trained champion - which is every
 * site until the Challenge has run - so it has to be sound on its own. It
 * is still only a floor: ordering in this game turns on the whole position,
 * and the order below covers the handful of cases it can justify out loud
 * and leaves the rest to be learned (see labFeatures for the crosses that
 * make learning it possible).
 */

// ARCHON (F3/F9): what a card DOES, from the canonical card data. The
// misplay review's classifier, reused rather than reinvented, so "this card
// steals" has one answer on this platform.
const { ROLES, rolesFor } = require('../membership/cardKnowledge');

/** The engine's own title for the base "throw this away" action. */
const DISCARD_TITLE = 'discard this card';

/**
 * Menu buttons that express each action kind, once a card is clicked.
 *
 * Every kind is here, hand cards included, because a hand card's menu can
 * offer both a play and a discard and the bot has to press the one it chose
 * - it decided between them already, and answering by a fixed preference
 * order would quietly overrule that.
 */
const INTENT_BUTTONS = {
    reap: ['reap with this creature'],
    fight: ['fight with this creature'],
    useAbility: [
        "use this card's action ability",
        "use this card's omni ability",
        "remove this creature's stun"
    ],
    playCreature: ['play this creature'],
    playArtifact: ['play this artifact'],
    playAction: ['play this action'],
    playUpgrade: ['play this upgrade'],
    discard: [DISCARD_TITLE],
    // Clicking a prophecy asks "Activate prophecy?" - and the bot clicked it
    // because it decided to.
    activateProphecy: ['yes']
};

/** Hand card type -> the action kind playing it represents. */
const PLAY_KIND_BY_TYPE = {
    creature: 'playCreature',
    artifact: 'playArtifact',
    action: 'playAction',
    upgrade: 'playUpgrade'
};

/** menuTitle / button.text can be a string or { text, values }. */
function textOf(value) {
    if (!value) {
        return '';
    }

    return String(typeof value === 'object' ? value.text || '' : value).toLowerCase();
}

/** Hand cards the engine says may act right now. */
function playableFromHand(player) {
    return player.hand.filter((card) => card.getLegalActions(player).length > 0);
}

/** In-play cards the engine says may act right now. */
function usableInPlay(player) {
    return player.cardsInPlay.filter((card) => card.getLegalActions(player).length > 0);
}

/**
 * ARCHON (F9): prophecies this seat may activate right now.
 *
 * Prophetic Visions puts two pairs of prophecy cards beside the board
 * rather than in the deck. Activating one costs a card from hand, placed
 * face down beneath it; when its condition comes true the prophecy pays
 * out and the buried card's Fate ability fires back at you. The engine
 * owns every rule about which may be activated (one per phase, your turn,
 * not the flip side of an active one, hand not empty), so this asks it
 * rather than restating any of that.
 */
function activatableProphecies(player) {
    if (!player.prophecyCards || typeof player.canActivateProphecy !== 'function') {
        return [];
    }

    return player.prophecyCards.filter((card) => player.canActivateProphecy(card));
}

/** Does this card punish its owner when the prophecy above it comes true? */
function hasFate(card) {
    return !!card && rolesFor(card.id).has(ROLES.HAS_FATE);
}

/** Could this card be PLAYED right now, as opposed to merely discarded? */
function canBePlayed(player, card) {
    return card
        .getLegalActions(player)
        .some((action) => textOf(action.title).startsWith('play this'));
}

/**
 * Which card to bury under a prophecy.
 *
 * Cheapest first, and "cheap" means three things in order: it carries no
 * Fate ability to fire back at us, we cannot play it this turn anyway, and
 * it belongs to the house we are already spending - a card of another
 * house is a card for another turn. A dead card of the active house is the
 * ideal fate card: it was going in the bin regardless, and this way it
 * buys a prophecy on the way.
 *
 * @param {object} player
 * @param {object[]} cards the prompt's own selectable list
 * @returns {object|null}
 */
function fateCost(player, card) {
    return (
        (hasFate(card) ? 4 : 0) +
        (canBePlayed(player, card) ? 2 : 0) +
        (player.activeHouse && card.hasHouse && card.hasHouse(player.activeHouse) ? 0 : 1)
    );
}

function bestFateCard(player, cards) {
    let best = null;

    for (const card of cards) {
        if (!best || fateCost(player, card) < fateCost(player, best)) {
            best = card;
        }
    }

    return best;
}

/**
 * Every move available from the main window: each playable hand card, and
 * each usable board card once per distinct action kind it offers.
 *
 * @returns {{hand: object[], inPlay: object[], candidates: object[]}}
 */
function mainWindowCandidates(player) {
    const hand = playableFromHand(player);
    const inPlay = usableInPlay(player);
    const prophecies = activatableProphecies(player);
    const candidates = [];

    for (let index = 0; index < hand.length; index++) {
        const card = hand[index];
        /**
         * ARCHON: playing a card and binning it are two different moves,
         * and the bot has to be able to choose between them.
         *
         * Discarding is a base action on EVERY card in hand, so a card the
         * engine will only let you throw away still reports a legal action.
         * Labelling that candidate "play an upgrade" was a lie the bot then
         * acted on - it is how an upgrade drawn before any creature got
         * binned by accident. But binning it ON PURPOSE is often right, and
         * the fix is to enumerate both honestly rather than to pretend the
         * bin is not there:
         *
         *  - You draw back up to your hand size at the end of the turn
         *    either way, so a discard converts a card you cannot use into a
         *    fresh one at no cost in cards.
         *  - Nothing is destroyed. Your discard pile becomes your deck again
         *    when the deck runs out, so a card binned now is a card drawn
         *    later, by which time the board may suit it.
         *  - A card held in hand that you can never play is a permanently
         *    smaller hand.
         *
         * Which of the two to take is the ORDER's business (candidateRank),
         * and the learned model's - not the enumeration's.
         */
        const titles = card.getLegalActions(player).map((action) => textOf(action.title));
        const playKind = titles.some((title) => title.startsWith('play this'))
            ? PLAY_KIND_BY_TYPE[card.type] || 'playAction'
            : null;

        if (playKind) {
            candidates.push({ list: 'hand', index, card, kind: playKind });
        }

        if (titles.includes(DISCARD_TITLE)) {
            // `playKind` rides along so the order can ask what binning this
            // card would be giving up, without re-querying the engine.
            candidates.push({ list: 'hand', index, card, kind: 'discard', playKind });
        }
    }

    for (let index = 0; index < prophecies.length; index++) {
        candidates.push({
            list: 'prophecy',
            index,
            card: prophecies[index],
            kind: 'activateProphecy'
        });
    }

    for (let index = 0; index < inPlay.length; index++) {
        const card = inPlay[index];
        const kinds = new Set();

        for (const action of card.getLegalActions(player)) {
            const text = textOf(action.title);

            if (INTENT_BUTTONS.reap.includes(text)) {
                kinds.add('reap');
            } else if (INTENT_BUTTONS.fight.includes(text)) {
                kinds.add('fight');
            } else {
                kinds.add('useAbility');
            }
        }

        for (const kind of kinds) {
            candidates.push({ list: 'play', index, card, kind });
        }
    }

    return { hand, inPlay, prophecies, candidates };
}

/* ------------------------------------------------------------------ *
 * Combat arithmetic
 *
 * What a fight costs and what it buys, worked out from the same numbers
 * the engine resolves it with. It is an ESTIMATE - card abilities can
 * change any of it, and only the deep planner (which executes the fight
 * in a fork) knows for sure - but it is the difference between a bot
 * that trades a giant for a token and one that does not.
 * ------------------------------------------------------------------ */

/** A keyword's value, on a real card or on a stand-in that has none. */
function keyword(card, name) {
    return (card.getKeywordValue && card.getKeywordValue(name)) || 0;
}

/** Armour still able to soak damage this turn. */
function armorLeft(card) {
    return Math.max(0, (card.armorTotal || 0) - (card.armorUsed || 0));
}

/** Damage still needed to destroy this creature. */
function healthLeft(card) {
    return Math.max(0, (card.power || 0) - (card.damage || 0));
}

/** Creatures a seat controls, however the stand-in spells it. */
function creaturesOf(player) {
    if (!player) {
        return [];
    }

    return (
        player.creaturesInPlay ||
        (player.cardsInPlay || []).filter((card) => card.type === 'creature')
    );
}

/**
 * How an attack would go: does it kill, and does the attacker survive?
 *
 * Covers the keywords that decide most exchanges - elusive stops the
 * attack outright, skirmish spares the attacker the counter-punch,
 * assault and hazardous land before it, poison turns any damage into a
 * kill, ward eats the first destruction. Anything subtler is left to the
 * planner.
 */
function fightOutcome(attacker, defender) {
    if (keyword(defender, 'elusive') && !defender.elusiveUsed) {
        return { kills: false, dies: false };
    }

    const toDefender = Math.max(
        0,
        keyword(attacker, 'assault') + (attacker.power || 0) - armorLeft(defender)
    );
    const counter = keyword(attacker, 'skirmish') ? 0 : defender.power || 0;
    const toAttacker = Math.max(0, keyword(defender, 'hazardous') + counter - armorLeft(attacker));
    const warded = (card) => !!(card.hasToken && card.hasToken('ward'));
    const lethal = (source, target, damage) =>
        damage > 0 &&
        !warded(target) &&
        (keyword(source, 'poison') > 0 || damage >= healthLeft(target));

    return {
        kills: lethal(attacker, defender, toDefender),
        dies: lethal(defender, attacker, toAttacker)
    };
}

/**
 * What this fight is worth, on one scale so it can be compared with the
 * alternative - reaping for an amber.
 *
 * Higher is better; anything at or above WORTH_FIGHTING beats a reap.
 */
function fightScore(attacker, defender) {
    const { kills, dies } = fightOutcome(attacker, defender);

    if (kills && !dies) {
        // A body removed for free. Bigger bodies are worth more.
        return 3 + Math.min(1, (defender.power || 0) / 12);
    }

    if (kills) {
        // A trade: good when what dies is at least what we spent.
        return (defender.power || 0) >= (attacker.power || 0) ? 2 : 0.5;
    }

    // Chip damage costs a reap and gains no amber; suicide costs a creature.
    return dies ? -1 : 0.25;
}

/** A fight the bot would rather make than reap. */
const WORTH_FIGHTING = 2;

/**
 * The best creature to attack out of the ones the prompt will accept.
 *
 * Only ever called with the prompt's own selectable list, so taunt and
 * every other targeting restriction is already applied - the bot chooses
 * among legal attacks, it does not invent one.
 *
 * @returns {object|null} null when this is not a fight prompt at all
 */
function bestFightTarget(attacker, targets) {
    if (!attacker || !targets.length) {
        return null;
    }

    const enemies = targets.filter(
        (card) => card.type === 'creature' && card.controller !== attacker.controller
    );

    if (enemies.length !== targets.length) {
        return null;
    }

    let best = null;
    let bestScore = -Infinity;

    for (const enemy of enemies) {
        const score = fightScore(attacker, enemy);

        if (score > bestScore) {
            bestScore = score;
            best = enemy;
        }
    }

    return best;
}

/* ------------------------------------------------------------------ *
 * Reading the race
 *
 * Everything below is public information: both amber pools, both key
 * counts, both boards, and the bot's own cards. Never the opponent's hand
 * and never either deck's order - the bot has to stay a player anyone
 * would agree was playing fair, because it is also what the lab trains
 * against.
 * ------------------------------------------------------------------ */

/**
 * Will the opponent forge at the start of their next turn?
 *
 * The single most important fact on the board, and the one a new player
 * learns last: amber in THEIR pool at or above their current key cost is a
 * key already, unless it leaves before their turn begins.
 */
function opponentAtCheck(player) {
    const opponent = player && player.opponent;

    if (!opponent) {
        return false;
    }

    return opponent.amber >= opponent.getCurrentKeyCost();
}

/**
 * Could this seat forge this turn if it kept reaping?
 *
 * One creature that can act is one amber, so the arithmetic is honest
 * without simulating anything - and it is what decides whether a good fight
 * is worth more than a reap right now. A key beats a dead creature.
 *
 * A creature that entered play this turn is not counted: it cannot be used
 * yet, and counting it would promise an amber that is not coming.
 */
function keyWithinReach(player) {
    if (!player) {
        return false;
    }

    const cost = player.getCurrentKeyCost();

    if (player.amber >= cost) {
        return false;
    }

    const ready = creaturesOf(player).filter((card) => !card.exhausted && !card.new).length;

    return player.amber + ready >= cost;
}

/**
 * Does this card take amber off the opponent - a steal or a capture?
 *
 * Read from the canonical card data by the classifier the misplay review
 * already uses (F3's cardKnowledge), so there is one answer to "what does
 * this card do" on the platform rather than a second parser here. It is
 * coarse on purpose: a conditional steal counts, because ordering a
 * conditional steal first costs nothing when the condition fails.
 */
function takesAmber(card) {
    return !!card && rolesFor(card.id).has(ROLES.AMBER_CONTROL);
}

/** Does this card destroy or damage creatures wholesale - both sides'? */
function wipesBoard(card) {
    return !!card && rolesFor(card.id).has(ROLES.BOARD_WIPE);
}

/**
 * Is a board wipe worth playing right now?
 *
 * It answers a board rather than builds one, so it is worth it when they
 * have creatures and the exchange is not in our favour. Out-bodied, a wipe
 * is a reset; ahead on board, it throws away the lead.
 */
function wipeIsWorthIt(player) {
    const theirs = creaturesOf(player.opponent).length;

    return theirs > 0 && theirs >= creaturesOf(player).length;
}

/**
 * ARCHON: the plain player's move order.
 *
 * Board first, then the cards that need a board, then the board's own
 * moves. Creatures lead because everything else is worth more once they
 * are down: upgrades find a creature to sit on, actions find something to
 * point at. Playing a targetless action into an empty board - the blunder
 * that prompted this order - is now the last play the bot considers
 * rather than one it can draw at random.
 *
 * Things that jump the queue, and why:
 *
 *  - **Taking their amber comes first, always.** A steal is worth two of a
 *    reap - one on, one off - and when the opponent is sitting at their key
 *    cost it is the only move on the board that changes the outcome of
 *    their next turn.
 *  - **A board wipe goes before the creatures.** Its effect does not care
 *    whose creatures they are, so playing it after committing a board
 *    destroys the board you just built. Worth playing at all only when
 *    they have creatures and we are not ahead on them.
 *  - **Reaping outranks even a won fight when the key is in reach.** With
 *    enough ready creatures to forge this turn, a dead enemy creature is
 *    worth less than the key, and the moment the amber is there the order
 *    reverts by itself.
 *
 * And things that sink to the bottom. `discard` sits below every move that
 * accomplishes something and above the ones that cost something, because
 * binning a card the bot cannot use is close to free - the end-of-turn
 * refill replaces it, and the discard pile becomes the deck again - while
 * `poorWipe` and `poorDiscard` are the moves a plain player would never
 * make: wiping a board we are winning, or throwing away a card that would
 * have done something. They stay in the list rather than being deleted
 * from it, because the LEARNED policy is allowed to disagree; it is the
 * plain order that will not do them.
 */
const MOVE_ORDER = [
    'takeAmber',
    'boardWipe',
    'playCreature',
    'playUpgrade',
    'playArtifact',
    'playAction',
    'useAbility',
    'keyReap',
    'goodFight',
    'reap',
    'activateProphecy',
    'discard',
    'fight',
    'poorWipe',
    'poorDiscard',
    'poorProphecy'
];

const DISCARD_RANK = MOVE_ORDER.indexOf('discard');

/** Where a candidate that is not a discard sits; lower goes first. */
function moveRank(player, kind, card) {
    // Prophecies are judged on what activating one COSTS, not on what the
    // prophecy card says - so this comes before the card-text shortcuts
    // below, which would otherwise read a prophecy's own text and skip the
    // question of what the bot has to spend.
    if (kind === 'activateProphecy') {
        /**
         * A prophecy costs a card out of hand, and it is worth that when
         * the card was not going to be used anyway. Sitting immediately
         * above `discard` is the whole idea: the card the bot was about to
         * bin buys a prophecy on its way out instead. Spending a card it
         * could have played is a judgement this plain order will not make -
         * that one is for the model.
         */
        const spare = player.hand.find(
            (candidate) => !hasFate(candidate) && !canBePlayed(player, candidate)
        );

        return MOVE_ORDER.indexOf(spare ? 'activateProphecy' : 'poorProphecy');
    }

    if (takesAmber(card)) {
        // Playing it, reaping with it, using its ability - whichever of
        // those this candidate is, it is the move that moves their amber.
        return 0;
    }

    if (kind.startsWith('play') && wipesBoard(card)) {
        kind = wipeIsWorthIt(player) ? 'boardWipe' : 'poorWipe';
    } else if (kind === 'fight') {
        const enemies = creaturesOf(player.opponent);
        const best = enemies.reduce(
            (highest, enemy) => Math.max(highest, fightScore(card, enemy)),
            -Infinity
        );

        kind = best >= WORTH_FIGHTING ? 'goodFight' : 'fight';
    } else if (kind === 'reap' && keyWithinReach(player)) {
        kind = 'keyReap';
    }

    const rank = MOVE_ORDER.indexOf(kind);

    return rank === -1 ? MOVE_ORDER.length : rank;
}

/** Where this candidate sits in the order above; lower goes first. */
function candidateRank(player, candidate) {
    if (candidate.kind !== 'discard') {
        return moveRank(player, candidate.kind, candidate.card);
    }

    /**
     * Bin it, or keep it?
     *
     * The question is only ever "what would playing this card instead be
     * worth", because the discard itself costs nothing the refill does not
     * give back. So: a card with no play at all, or one whose play the
     * order has already judged not worth making - a wipe into a board we
     * are winning - is worth more as a fresh draw. A card that would
     * actually do something is not.
     */
    const playRank = candidate.playKind
        ? moveRank(player, candidate.playKind, candidate.card)
        : Infinity;

    return playRank < DISCARD_RANK ? MOVE_ORDER.indexOf('poorDiscard') : DISCARD_RANK;
}

/**
 * What calling this house is worth this turn.
 *
 * One point per card of it in hand and per ready card of it in play - the
 * plain "what can I actually do" count the bot has always used - plus the
 * one piece of judgement that changes a game: when the opponent forges at
 * the start of their next turn, a house that can take that amber off them
 * is worth far more than a house with one more card in it.
 *
 * Shared so the lab and the lobby call houses the same way.
 */
function houseScore(player, house) {
    const inHand = player.hand.filter((card) => card.hasHouse(house));
    const ready = player.cardsInPlay.filter((card) => card.hasHouse(house) && !card.exhausted);
    const score = inHand.length + ready.length;

    if (!opponentAtCheck(player)) {
        return score;
    }

    const answers = inHand.filter(takesAmber).length + ready.filter(takesAmber).length;

    return score + answers * 3;
}

/**
 * The moves a plain player would consider first - one rank of them, not
 * one move.
 *
 * Returning the whole rank rather than a single winner is deliberate: the
 * caller picks among them at random, so two games from the same hand do
 * not play out identically. That variety is what the lab trains on, and
 * what stops a practice opponent feeling like a recording.
 *
 * @returns {object[]} never empty when `candidates` is not
 */
function bestCandidates(player, candidates) {
    const ranks = candidates.map((candidate) => candidateRank(player, candidate));
    const best = Math.min(...ranks);

    return candidates.filter((candidate, index) => ranks[index] === best);
}

module.exports = {
    DISCARD_TITLE,
    INTENT_BUTTONS,
    PLAY_KIND_BY_TYPE,
    MOVE_ORDER,
    WORTH_FIGHTING,
    wipesBoard,
    wipeIsWorthIt,
    textOf,
    playableFromHand,
    usableInPlay,
    activatableProphecies,
    hasFate,
    canBePlayed,
    bestFateCard,
    mainWindowCandidates,
    creaturesOf,
    fightOutcome,
    fightScore,
    bestFightTarget,
    bestCandidates,
    opponentAtCheck,
    keyWithinReach,
    takesAmber,
    houseScore
};
