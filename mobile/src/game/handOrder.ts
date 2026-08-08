import type { CardSummary } from './types';

export interface HandGroup {
    house: string;
    cards: CardSummary[];
}

/**
 * Split a hand into house groups. The active house leads — those are the cards
 * playable this turn — then the player's remaining houses in deck order, then
 * anything else (tokens, cards that changed house). Cards keep their relative
 * order within a group, so a freshly drawn card does not jump the queue.
 */
export function groupHandByHouse(
    hand: CardSummary[],
    houses?: string[],
    activeHouse?: string
): HandGroup[] {
    const groups = new Map<string, CardSummary[]>();
    for (const card of hand) {
        const house = typeof card.printedHouse === 'string' ? card.printedHouse : 'unknown';
        const list = groups.get(house);
        if (list) {
            list.push(card);
        } else {
            groups.set(house, [card]);
        }
    }

    const order = [
        ...(activeHouse ? [activeHouse] : []),
        ...(houses ?? []),
        // Anything the deck's house list does not mention still gets shown.
        ...groups.keys()
    ];

    const seen = new Set<string>();
    const result: HandGroup[] = [];
    for (const house of order) {
        if (seen.has(house)) {
            continue;
        }
        seen.add(house);
        const cards = groups.get(house);
        if (cards && cards.length > 0) {
            result.push({ house, cards });
        }
    }
    return result;
}
