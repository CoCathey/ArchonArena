import type { PlayerState } from './types';

/**
 * ARCHON: hide your own hand while the opponent is taking their turn.
 *
 * A port of the web client's `client/Components/GameBoard/handVisibility.js`,
 * deliberately kept rule-for-rule identical so a player who turns the setting
 * on sees the same behaviour on both. Nothing about the game changes — the
 * cards are still there and the server neither knows nor cares. This is a
 * decision about what to draw.
 *
 * On a phone it earns its keep twice over: the hand strip is the tallest thing
 * on the screen, so standing it down while the opponent plays is what makes
 * room to actually watch the board and the log.
 *
 * The whole difficulty is WHEN NOT to hide it, because getting that wrong
 * means a player cannot answer a prompt they can no longer see. So the rule is
 * written to fail towards showing: it hides only when the player is plainly a
 * spectator to their own board, and any sign that the game wants something
 * from them puts the hand straight back.
 */

/**
 * Is the game asking this player for something right now?
 *
 * A player waiting on their opponent gets `{ menuTitle: 'Waiting for
 * opponent' }` and nothing else (see server/game/gamesteps/uiprompt.js), so
 * buttons, controls or a card selection all mean the turn has stopped for
 * them — and every one of those can be about a card in hand.
 */
export function playerNeedsInput(player?: PlayerState): boolean {
    if (!player) {
        return false;
    }

    if (player.selectCard || player.selectOrder) {
        return true;
    }

    if ((player.buttons ?? []).length > 0 || (player.controls ?? []).length > 0) {
        return true;
    }

    // Belt and braces: a card in hand the player is being asked to pick.
    return (player.cardPiles?.hand ?? []).some((card) => card.selectable || card.selected);
}

export interface HandVisibilityOptions {
    /** The player turned the setting on (here or on the website). */
    enabled?: boolean;
    /** This player is the active player. */
    isMyTurn?: boolean;
    /** They asked to see it anyway. */
    isPeeking?: boolean;
    /** The game is asking them something. */
    needsInput?: boolean;
    /** Spectators have no hand of their own to stand down. */
    isSpectator?: boolean;
}

export function shouldHideHand(options: HandVisibilityOptions = {}): boolean {
    const { enabled, isMyTurn, isPeeking, needsInput, isSpectator } = options;
    return !!enabled && !isSpectator && !isMyTurn && !isPeeking && !needsInput;
}

/**
 * Whether the hand should be standing down right now, worked out from the
 * board state itself rather than from separately-threaded flags.
 *
 * `enabled` is the union of the phone's own setting and the account setting
 * the game node sends in `optionSettings` — so turning it on from the website
 * carries over to the app, and the in-game toggle (which writes both) can
 * still turn it off.
 */
export function isHandHidden(options: {
    me?: PlayerState;
    localSetting?: boolean;
    isPeeking?: boolean;
    isSpectator?: boolean;
}): boolean {
    const { me, localSetting, isPeeking, isSpectator } = options;
    const accountSetting = !!me?.optionSettings?.hideHandOnOpponentTurn;

    return shouldHideHand({
        enabled: !!localSetting || accountSetting,
        isMyTurn: !!me?.activePlayer,
        isPeeking,
        needsInput: playerNeedsInput(me),
        isSpectator
    });
}
