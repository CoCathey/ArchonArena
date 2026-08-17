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
 * itself is deliberately conservative: every move the engine would offer a
 * human from the main window, less the one no sound player makes - throwing
 * a card away - so a learned policy reorders sound play rather than
 * inventing unsound play.
 *
 * The module also holds the ORDER a plain player takes those moves in, the
 * combat arithmetic behind it, and how it reads the amber race. That order
 * is what plays when a site has no trained champion, which is every site
 * until the Challenge has run; it therefore has to be sound on its own, not
 * a placeholder.
 */

// ARCHON (F3/F9): what a card DOES, from the canonical card data. The
// misplay review's classifier, reused rather than reinvented, so "this card
// steals" has one answer on this platform.
const { ROLES, rolesFor } = require('../membership/cardKnowledge');

/** Menu buttons that express each action kind, once a card is clicked. */
const INTENT_BUTTONS = {
    reap: ['reap with this creature'],
    fight: ['fight with this creature'],
    useAbility: [
        "use this card's action ability",
        "use this card's omni ability",
        "remove this creature's stun"
    ]
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
 * Every move available from the main window: each playable hand card, and
 * each usable board card once per distinct action kind it offers.
 *
 * @returns {{hand: object[], inPlay: object[], candidates: object[]}}
 */
function mainWindowCandidates(player) {
    const hand = playableFromHand(player);
    const inPlay = usableInPlay(player);
    const candidates = [];

    for (let index = 0; index < hand.length; index++) {
        const card = hand[index];
        /**
         * ARCHON: what this card can actually DO, not what its type
         * suggests.
         *
         * Discarding is a base action on EVERY card in hand, so a card the
         * engine will only let you throw away still reports a legal action -
         * and calling that candidate "play an upgrade" was a lie the bot
         * then acted on. It is how an upgrade drawn before any creature got
         * binned instead of held: the enumeration offered a card labelled as
         * a play, the engine's menu offered only the bin, and the bot took
         * the one option in front of it.
         *
         * So a card that can only be discarded is not a move at all. Nothing
         * is lost by leaving it in hand - the turn can simply end, and the
         * card is playable again the moment a creature lands - and a move
         * list that never contains "throw a card away" is one no policy,
         * learned or plain, can pick it from.
         */
        const titles = card.getLegalActions(player).map((action) => textOf(action.title));

        if (!titles.some((title) => title.startsWith('play this'))) {
            continue;
        }

        candidates.push({
            list: 'hand',
            index,
            card,
            kind: PLAY_KIND_BY_TYPE[card.type] || 'playAction'
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

    return { hand, inPlay, candidates };
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
 * Two things jump the queue, and both are about the amber race rather than
 * the board:
 *
 *  - **Taking their amber comes first, always.** A steal is worth two of a
 *    reap - one on, one off - and when the opponent is sitting at their key
 *    cost it is the only move on the board that changes the outcome of
 *    their next turn.
 *  - **Reaping outranks even a won fight when the key is in reach.** With
 *    enough ready creatures to forge this turn, a dead enemy creature is
 *    worth less than the key, and the moment the amber is there the order
 *    reverts by itself.
 */
const MOVE_ORDER = [
    'takeAmber',
    'playCreature',
    'playUpgrade',
    'playArtifact',
    'playAction',
    'useAbility',
    'keyReap',
    'goodFight',
    'reap',
    'fight'
];

/** Where this candidate sits in the order above; lower goes first. */
function candidateRank(player, candidate) {
    let kind = candidate.kind;

    if (takesAmber(candidate.card)) {
        // Playing it, reaping with it, using its ability - whichever of
        // those this candidate is, it is the move that moves their amber.
        return 0;
    }

    if (kind === 'fight') {
        const enemies = creaturesOf(player.opponent);
        const best = enemies.reduce(
            (highest, enemy) => Math.max(highest, fightScore(candidate.card, enemy)),
            -Infinity
        );

        kind = best >= WORTH_FIGHTING ? 'goodFight' : 'fight';
    } else if (kind === 'reap' && keyWithinReach(player)) {
        kind = 'keyReap';
    }

    const rank = MOVE_ORDER.indexOf(kind);

    return rank === -1 ? MOVE_ORDER.length : rank;
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
    INTENT_BUTTONS,
    PLAY_KIND_BY_TYPE,
    MOVE_ORDER,
    WORTH_FIGHTING,
    textOf,
    playableFromHand,
    usableInPlay,
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
