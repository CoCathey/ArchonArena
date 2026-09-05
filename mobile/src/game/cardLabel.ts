import type { CardSummary } from './types';

/**
 * What a screen reader says for a card tile. The tile is card art with no
 * text, so without this every card in the hand and on the board read as an
 * unlabelled element and a VoiceOver player could not tell them apart.
 *
 * Kept free of React so it can be unit-tested; CardTile calls it.
 */
export function cardAccessibilityLabel(card: CardSummary): string {
    if (card.facedown) {
        return 'Face-down card';
    }

    const parts = [card.name || 'Card'];
    const tokens = card.tokens ?? {};

    if (card.exhausted) {
        parts.push('exhausted');
    }
    if (card.stunned || (tokens.stun ?? 0) > 0) {
        parts.push('stunned');
    }
    if ((tokens.ward ?? 0) > 0) {
        parts.push('warded');
    }
    const damage = (tokens.damage ?? 0) + (card.pseudoDamage ?? 0);
    if (damage > 0) {
        parts.push(`${damage} damage`);
    }

    return parts.join(', ');
}
