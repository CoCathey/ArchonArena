import type { CardSummary } from './types';

/**
 * ARCHON: prophecies on the phone.
 *
 * Prophecy cards (Prophetic Visions) never sit in a pile — they live beside
 * the board for the whole game, two-sided, and a player activates one from
 * there. The web client draws them in a reference pane down the right-hand
 * side (client/Components/GameBoard/ReferenceCardPane.jsx); the app had no
 * equivalent at all, so a Prophetic Visions deck was playable except for the
 * one mechanic the set is named after.
 *
 * The rules that decide what a tap means live here rather than in the view, so
 * they can be tested as cases and stay in step with the web client's.
 */

/**
 * Prophecy cards arrive as a flat list, paired front-then-back
 * (server/game/player.js prophecyFlipSide). Split them back into their pairs
 * so a pair can be drawn as the one two-sided card it is.
 *
 * A trailing odd card is kept in a pair of its own rather than dropped — a
 * malformed list should still show every card it has.
 */
export function prophecyPairs(cards?: CardSummary[]): CardSummary[][] {
    const pairs: CardSummary[][] = [];
    for (let index = 0; index < (cards?.length ?? 0); index += 2) {
        pairs.push(cards!.slice(index, index + 2).filter(Boolean));
    }
    return pairs.filter((pair) => pair.length > 0);
}

/** The side of a pair that is face up on the table right now. */
export function shownProphecy(pair: CardSummary[]): CardSummary | undefined {
    return pair.find((card) => card.activeProphecy) ?? pair[0];
}

export type ProphecyAction =
    /** The game is asking for a card and this one is a legal answer. */
    | 'select'
    /** Activate it — the ordinary "use my prophecy" move. */
    | 'activate'
    /** Manual mode: the card carries its own menu (activate/deactivate/trigger). */
    | 'menu'
    /** Nothing to do but look at it. */
    | 'none';

/**
 * What tapping a prophecy should do, mirroring the web client's click handler.
 *
 * Selection wins over everything: when an effect is asking for a card, that is
 * what the tap is for. Otherwise only the controller can act, and only on a
 * prophecy the engine says can be activated — `canActivateProphecy` already
 * encodes "your turn, none activated this phase, the flip side is not active,
 * and you hold at least one card" (server/game/player.js).
 */
export function prophecyAction(
    card: CardSummary,
    options: { isMine: boolean; manualMode?: boolean }
): ProphecyAction {
    if (card.selectable) {
        return 'select';
    }

    if (!options.isMine) {
        return 'none';
    }

    const menu = (card.menu ?? []).filter((item) => item.command !== 'click');

    // Manual mode hands out activate/deactivate/trigger as a menu; outside it
    // the only move is the ordinary activation.
    if (options.manualMode && menu.length > 0) {
        return 'menu';
    }

    return card.canActivateProphecy ? 'activate' : 'none';
}

/** A short word for the state a prophecy is in, for the label under it. */
export function prophecyStatus(
    card: CardSummary,
    options: { isMine: boolean }
): 'active' | 'ready' | 'idle' {
    if (card.activeProphecy) {
        return 'active';
    }
    if (options.isMine && card.canActivateProphecy) {
        return 'ready';
    }
    return 'idle';
}

/** Does this board have prophecies at all? Only Prophetic Visions games do. */
export function hasProphecies(...players: ({ prophecyCards?: CardSummary[] } | undefined)[]) {
    return players.some((player) => (player?.prophecyCards?.length ?? 0) > 0);
}
