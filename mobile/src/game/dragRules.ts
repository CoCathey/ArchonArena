import type { CardSummary } from './types';

/**
 * Drag-and-drop zone rules, mirroring the web client
 * (client/Components/GameBoard/Droppable.jsx). Kept free of UI imports so the
 * rules can be unit-tested directly.
 */

export type DropZoneName = 'hand' | 'play area' | 'discard' | 'archives' | 'deck' | 'purged';

/** Manual-mode target matrix, from the web client's Droppable. */
const MANUAL_TARGETS: Record<string, DropZoneName[]> = {
    hand: ['play area', 'discard', 'deck', 'archives', 'purged'],
    'play area': ['discard', 'hand', 'deck', 'archives', 'purged'],
    discard: ['archives', 'hand', 'deck', 'play area', 'purged'],
    archives: ['hand', 'deck', 'play area', 'discard', 'purged'],
    deck: ['hand', 'discard', 'archives', 'play area', 'purged'],
    purged: ['deck', 'play area', 'discard', 'hand', 'archives']
};

export function canDragCard(
    card: CardSummary,
    source: DropZoneName,
    manualMode: boolean
): boolean {
    if (manualMode) {
        return true;
    }
    // Normal play: only hand cards with a legal play action; dropping cards
    // from other zones would be silently ignored by the server.
    return source === 'hand' && !!card.canPlay && !card.unselectable;
}

export function canDropCard(
    card: CardSummary,
    source: DropZoneName,
    target: DropZoneName,
    manualMode: boolean
): boolean {
    if (source === target) {
        return false;
    }
    if (manualMode) {
        return (MANUAL_TARGETS[source] ?? []).includes(target);
    }
    // Normal play: hand → play area plays the card, hand → discard discards
    // it for the active house; everything else is a dead gesture.
    return (
        source === 'hand' && (target === 'play area' || target === 'discard') && !!card.canPlay
    );
}
