import type { GameSummary } from '../api/types';

/**
 * ARCHON: when a pending game is ready to start, and what to tell the players
 * while it is not.
 *
 * A port of the readiness rules the web client's PendingGame already applies
 * (client/Components/Games/PendingGame.jsx). The app had its own, simpler
 * version — "every player has a deck selected" — which is right for every mode
 * except the two where the players never select one:
 *
 *   - Sealed deals a deck when each player arrives, so it resolves on its own.
 *   - Lucky Dice deliberately does NOT. The roll happens on the lobby server
 *     when the owner presses Start (server/lobby.js onStartGame), precisely so
 *     it cannot be rerolled by leaving and rejoining until a favourite comes
 *     up. Until then nobody holds a deck.
 *
 * So the app's Start button sat disabled forever in a Lucky Dice game and the
 * mode could not be played from a phone at all.
 */

type PendingPlayer = { deck?: { selected?: boolean } };

function playersOf(game?: GameSummary): PendingPlayer[] {
    return Object.values(game?.players ?? {}) as PendingPlayer[];
}

export function isSealedGame(game?: GameSummary): boolean {
    return game?.gameFormat === 'sealed';
}

export function isLuckyDiceGame(game?: GameSummary): boolean {
    return !!game?.luckyDice;
}

/** Modes where this player picks a deck from their collection themselves. */
export function choosesOwnDeck(game?: GameSummary): boolean {
    return !isSealedGame(game) && !isLuckyDiceGame(game);
}

/**
 * Everyone the game is waiting on has what they need.
 *
 * Lucky Dice needs only the seats filled: the decks are rolled at start, so
 * requiring them beforehand is requiring something that cannot happen yet.
 */
export function allPlayersReady(game?: GameSummary): boolean {
    const players = playersOf(game);

    if (players.length < 2) {
        return false;
    }

    if (isLuckyDiceGame(game)) {
        return true;
    }

    return players.every((player) => !!player.deck?.selected);
}

/** Whether the owner's Start button should be live. */
export function canStartGame(options: { game?: GameSummary; isOwner: boolean }): boolean {
    return options.isOwner && allPlayersReady(options.game);
}

/**
 * The line under the Start button. It has to explain a disabled button, and —
 * in a Lucky Dice game — an enabled one that nobody has picked a deck for.
 */
export function startHint(game?: GameSummary): string {
    const players = playersOf(game);

    if (players.length < 2) {
        return 'Waiting for an opponent to join…';
    }

    if (isLuckyDiceGame(game)) {
        return 'The dice roll both decks when the game starts.';
    }

    const missing = players.filter((player) => !player.deck?.selected).length;
    if (missing > 0) {
        return isSealedGame(game)
            ? 'Dealing sealed decks…'
            : `Waiting for ${missing} player${missing === 1 ? '' : 's'} to select a deck.`;
    }

    return 'Ready to start.';
}

/** What to show against a seat that has not got a deck yet. */
export function deckStatusLabel(game?: GameSummary): string {
    if (isSealedGame(game)) {
        return 'Dealing a sealed deck…';
    }
    if (isLuckyDiceGame(game)) {
        return 'Rolls a deck when the game starts';
    }
    return 'Choosing a deck…';
}
