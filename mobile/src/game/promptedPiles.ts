import type { PlayerState, PromptedPile } from './types';

/**
 * ARCHON: which pile the game is currently asking a card out of.
 *
 * The game node tells the prompted player which piles the current selector is
 * drawing from — `{ location, controller }` pairs, stated from that player's
 * own point of view (server/game/gamesteps/selectcardprompt.js
 * `getPromptedPiles`). The web client uses it to light up the matching pile
 * link (client/Components/GameBoard/PlayerStats.jsx `isPilePromptTarget`).
 *
 * On a phone it has to carry more weight than a highlight. A pile here is a
 * chip with a count on it, and the opponent's hand had no way in at all, so
 * "look at your opponent's hand and choose a card" — Abyssal Sight, Brain
 * Drain, Imperial Traitor, Talent Scout, Lateral Shift — left the app with a
 * prompt on screen and nothing on the board to answer it with. This is what
 * makes those cards playable on the app.
 */
export function isPilePrompted(
    piles: PromptedPile[] | undefined,
    location: string,
    isMe: boolean
): boolean {
    const controller = isMe ? 'self' : 'opponent';
    return (piles ?? []).some(
        (pile) =>
            !!pile &&
            pile.location === location &&
            (pile.controller === controller || pile.controller === 'any')
    );
}

/**
 * Is the game asking this player to pick a card out of their opponent's hand,
 * and only out of there?
 *
 * That is the one pile with nothing on the board standing in for it, so the
 * board opens it rather than waiting to be asked. A prompt that would take a
 * card from either hand is excluded deliberately: the player's own hand is
 * already laid out along the bottom of the screen, and dropping a sheet over
 * it would narrow the choice the prompt is offering.
 */
export function isOpponentHandPrompted(me?: PlayerState): boolean {
    return (
        isPilePrompted(me?.promptedPiles, 'hand', false) &&
        !isPilePrompted(me?.promptedPiles, 'hand', true)
    );
}
