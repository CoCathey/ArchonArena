/**
 * ARCHON: hide your own hand while the opponent is taking their turn.
 *
 * An opt-in comfort setting - some players find their own hand pulling their
 * eye while there is nothing they can do with it. Nothing about the game
 * changes: the cards are still there, still yours, and the server neither
 * knows nor cares. This is a decision about what to draw.
 *
 * The whole difficulty is WHEN NOT to hide it, because getting that wrong
 * means a player cannot answer a prompt they can no longer see. So the rule is
 * written to fail towards showing: it hides only when the player is plainly a
 * spectator to their own board, and any sign that the game wants something
 * from them puts the hand straight back.
 *
 * A pure function, so those cases can be tested as cases rather than clicked
 * through one at a time.
 */

/**
 * Is the game asking this player for something right now?
 *
 * A player waiting on their opponent gets `{ menuTitle: 'Waiting for
 * opponent' }` and nothing else (see server/game/gamesteps/uiprompt.js), so
 * buttons, controls or a card selection all mean the turn has stopped for
 * them - and every one of those can be about a card in hand.
 *
 * @param {object} player this player's state, as the game board has it
 * @returns {boolean}
 */
export const playerNeedsInput = (player = {}) => {
    if (player.selectCard) {
        return true;
    }

    if ((player.buttons || []).length > 0 || (player.controls || []).length > 0) {
        return true;
    }

    // Belt and braces: a card in hand the player is being asked to pick.
    return (player.cardPiles?.hand || []).some((card) => card.selectable || card.selected);
};

/**
 * @param {object} options
 * @param {boolean} options.enabled the player turned the setting on
 * @param {boolean} options.isMyTurn this player is the active player
 * @param {boolean} options.isPeeking they asked to see it anyway
 * @param {boolean} options.needsInput the game is asking them something
 * @returns {boolean} whether to hide the hand
 */
export const shouldHideHand = ({ enabled, isMyTurn, isPeeking, needsInput } = {}) =>
    !!enabled && !isMyTurn && !isPeeking && !needsInput;

export default shouldHideHand;
