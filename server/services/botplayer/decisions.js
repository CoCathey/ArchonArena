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
 * itself is deliberately conservative: exactly the moves the original
 * hand-written heuristic could make, so a learned policy reorders sound
 * play rather than inventing unsound play.
 */

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

module.exports = {
    INTENT_BUTTONS,
    PLAY_KIND_BY_TYPE,
    textOf,
    playableFromHand,
    usableInPlay,
    mainWindowCandidates
};
