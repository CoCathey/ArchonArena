import type { GamePlayerSummary, GameSummary, TournamentSeat } from '../api/types';

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
 *
 * A third such mode has joined them: a tournament seat the event pinned a deck
 * to. The table loads that deck itself, and the lobby refuses any other choice
 * (server/lobby.js onSelectDeck) and every random one (onSelectRandomDeck's
 * `|| game.tournament`). The app knew nothing of tournament tables, so it
 * offered a picker and a Lucky Dice roll on a locked seat — two buttons that
 * could only fail — and said nothing about which game of the match this was.
 */

type PendingPlayer = { name?: string; deck?: { name?: string; selected?: boolean } };

function playersOf(game?: GameSummary): PendingPlayer[] {
    return Object.values(game?.players ?? {}) as PendingPlayer[];
}

export function isSealedGame(game?: GameSummary): boolean {
    return game?.gameFormat === 'sealed';
}

export function isLuckyDiceGame(game?: GameSummary): boolean {
    return !!game?.luckyDice;
}

/** A table the tournament engine built for a pairing, not a table someone hosted. */
export function isTournamentGame(game?: GameSummary): boolean {
    return !!game?.tournament;
}

/**
 * What the event pinned one seat to. Older servers send no `seats` map, so
 * everything built on this degrades to an unlocked seat rather than breaking.
 */
export function tournamentSeat(game?: GameSummary, username?: string): TournamentSeat | undefined {
    if (!username) {
        return undefined;
    }

    return game?.tournament?.seats?.[username];
}

/**
 * This seat plays the deck the event registered for it.
 *
 * Read from the seats map for anybody, and from `deckLocked` for the viewer:
 * the server computes that one for the account asking, and it is the only
 * answer available at all when the seats map is missing.
 */
export function seatIsLocked(game?: GameSummary, username?: string, viewer?: string): boolean {
    if (username && viewer === username && game?.tournament?.deckLocked) {
        return true;
    }

    return !!tournamentSeat(game, username)?.locked;
}

/**
 * Modes where this player picks a deck from their collection themselves.
 *
 * A pinned tournament seat is a third mode where they do not: the table loads
 * the registered deck and the lobby refuses any other (server/lobby.js
 * onSelectDeck), so a picker here is a picker that can only fail.
 */
export function choosesOwnDeck(game?: GameSummary, viewer?: string): boolean {
    // `deckLocked` is already the answer for whoever the server built this
    // summary for, so it holds even where the caller has no username to hand.
    const pinned = !!game?.tournament?.deckLocked || seatIsLocked(game, viewer, viewer);

    return !isSealedGame(game) && !isLuckyDiceGame(game) && !pinned;
}

/**
 * Whether to offer a Lucky Dice roll on this seat. Never at a tournament
 * table, pinned or not: onSelectRandomDeck refuses every `game.tournament`
 * outright, because a random deck is not the deck the event registered.
 */
export function offersLuckyDice(game?: GameSummary, viewer?: string): boolean {
    return choosesOwnDeck(game, viewer) && !isTournamentGame(game);
}

/**
 * The line that says which game of which match this table is.
 *
 * Between one game of a series ending and the next beginning the players are
 * moved from one table to another. Without this the new table read as a game
 * somebody else had opened — which is exactly how a player comes to believe a
 * result was awarded in a game they never played.
 */
export function tournamentHeadline(game?: GameSummary): string | undefined {
    const tournament = game?.tournament;

    if (!tournament) {
        return undefined;
    }

    const bestOf = tournament.bestOf ?? 1;

    return bestOf > 1
        ? `Game ${tournament.gameNumber ?? 1} of ${bestOf} — tournament match`
        : 'Tournament match';
}

/** Where the pairing sits in the event, when the event says. */
export function tournamentPlacement(game?: GameSummary): string | undefined {
    const tournament = game?.tournament;
    const parts: string[] = [];

    if (tournament?.round != null) {
        parts.push(`Round ${tournament.round}`);
    }

    if (tournament?.table != null) {
        parts.push(`Table ${tournament.table}`);
    }

    return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Why this seat cannot change its deck. The two policies need different
 * wording: under 'locked' there is nothing the player can do about it at all,
 * under 'between-rounds' there is — and it is on the event page, not here.
 */
export function pinnedDeckHint(game?: GameSummary): string {
    return game?.tournament?.deckSwapPolicy === 'between-rounds'
        ? 'This event runs on the deck you registered for this round. Change it on the event page before your match starts.'
        : 'This event locks you to one deck for the whole run.';
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
export function startHint(
    game?: GameSummary,
    options: {
        /**
         * The sealed deal has taken longer than it ever should. The lobby
         * deals in the background and, when it cannot (no sealed pool, an
         * error on its side), says nothing - so the only signal is time.
         */
        sealedStalled?: boolean;
    } = {}
): string {
    const players = playersOf(game);

    if (players.length < 2) {
        return 'Waiting for an opponent to join…';
    }

    if (isLuckyDiceGame(game)) {
        return 'The dice roll both decks when the game starts.';
    }

    const missing = players.filter((player) => !player.deck?.selected).length;
    if (missing > 0) {
        if (isSealedGame(game)) {
            return options.sealedStalled
                ? 'The server could not deal the sealed decks. Leave the game and try again, or pick another format.'
                : 'Dealing sealed decks…';
        }

        // A pinned tournament seat is not being waited ON — the table loads
        // the registered deck itself. Counting it as a player who has not
        // chosen sent people looking for a picker that is not there. A
        // tournament player the event registered no deck for still picks one,
        // so only the locked seats are excused.
        const choosing = players.filter(
            (player) => !player.deck?.selected && !seatIsLocked(game, player.name)
        ).length;

        if (isTournamentGame(game) && choosing === 0) {
            return 'Loading the decks this event registered…';
        }

        const waitingOn = isTournamentGame(game) ? choosing : missing;

        return `Waiting for ${waitingOn} player${waitingOn === 1 ? '' : 's'} to select a deck.`;
    }

    // A tournament table starts itself the moment both seats hold their decks
    // (server/lobby.js startTournamentGameIfReady), so nobody is waiting on
    // the host to press anything.
    if (isTournamentGame(game)) {
        return 'The table starts on its own once both players are seated.';
    }

    return 'Ready to start.';
}

/** How long a sealed deal may take before the screen stops promising it. */
export const SEALED_DEAL_TIMEOUT_MS = 20000;

/**
 * What to show against a seat that has not got a deck yet.
 *
 * @param username the seat, where it is known. A locked tournament seat is
 *   not waiting on its player at all — its deck is on its way in.
 * @param viewer who is looking, so the server's answer for their own seat
 *   (`deckLocked`) counts as well as the seats map.
 */
export function deckStatusLabel(game?: GameSummary, username?: string, viewer?: string): string {
    if (isSealedGame(game)) {
        return 'Dealing a sealed deck…';
    }
    if (isLuckyDiceGame(game)) {
        return 'Rolls a deck when the game starts';
    }
    if (seatIsLocked(game, username, viewer)) {
        return 'Loading the event deck…';
    }
    return 'Choosing a deck…';
}

/**
 * The whole deck line for one seat: what it is playing, or what it is waiting
 * for. A port of the same decision in the web client's PendingGamePlayers, so
 * the two read as one product.
 *
 * The event's name for a locked deck wins over everything, for either seat:
 * the table knows it from the moment the pairing is made, long before the deck
 * has loaded into the seat — and without it a table the event had built for
 * two registered decks opened reading "Choosing a deck…" on both sides.
 */
export function seatDeckLabel(
    game: GameSummary | undefined,
    player: GamePlayerSummary,
    viewer?: string
): string {
    const lockedName = tournamentSeat(game, player.name)?.deckName;

    if (lockedName) {
        return lockedName;
    }

    if (!player.deck?.selected) {
        return deckStatusLabel(game, player.name, viewer);
    }

    // Only your own summary carries the deck's name; the opponent's is
    // withheld unless the event pinned it above.
    return (player.name === viewer && player.deck.name) || 'Deck selected';
}
