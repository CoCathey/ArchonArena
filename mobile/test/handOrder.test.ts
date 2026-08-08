import { describe, expect, it } from 'vitest';
import { groupHandByHouse } from '../src/game/handOrder';
import type { CardSummary } from '../src/game/types';

const card = (uuid: string, printedHouse?: string): CardSummary => ({ uuid, printedHouse });

describe('groupHandByHouse', () => {
    it('groups a shuffled hand by house', () => {
        const hand = [
            card('a', 'logos'),
            card('b', 'brobnar'),
            card('c', 'logos'),
            card('d', 'untamed')
        ];

        const groups = groupHandByHouse(hand, ['brobnar', 'logos', 'untamed']);

        expect(groups.map((group) => group.house)).toEqual(['brobnar', 'logos', 'untamed']);
        expect(groups[1].cards.map((entry) => entry.uuid)).toEqual(['a', 'c']);
    });

    it('leads with the active house', () => {
        const hand = [card('a', 'logos'), card('b', 'brobnar'), card('c', 'untamed')];

        const groups = groupHandByHouse(hand, ['brobnar', 'logos', 'untamed'], 'untamed');

        expect(groups.map((group) => group.house)).toEqual(['untamed', 'brobnar', 'logos']);
    });

    it('keeps draw order inside a group', () => {
        const hand = [card('a', 'logos'), card('b', 'logos'), card('c', 'logos')];

        const groups = groupHandByHouse(hand, ['logos']);

        expect(groups[0].cards.map((entry) => entry.uuid)).toEqual(['a', 'b', 'c']);
    });

    it('still shows cards whose house is not one of the deck houses', () => {
        // Cards can change house mid-game, and token creatures carry their own.
        const hand = [card('a', 'logos'), card('b', 'shadows')];

        const groups = groupHandByHouse(hand, ['logos']);

        expect(groups.map((group) => group.house)).toEqual(['logos', 'shadows']);
    });

    it('files a card with no house under unknown rather than dropping it', () => {
        const groups = groupHandByHouse([card('a'), card('b', 'logos')], ['logos']);

        expect(groups.map((group) => group.house)).toEqual(['logos', 'unknown']);
        expect(groups.flatMap((group) => group.cards).length).toBe(2);
    });

    it('never loses or duplicates a card', () => {
        const hand = [
            card('a', 'logos'),
            card('b', 'brobnar'),
            card('c'),
            card('d', 'logos'),
            card('e', 'untamed')
        ];

        const uuids = groupHandByHouse(hand, ['brobnar', 'logos'], 'logos')
            .flatMap((group) => group.cards.map((entry) => entry.uuid))
            .sort();

        expect(uuids).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('returns nothing for an empty hand', () => {
        expect(groupHandByHouse([], ['logos'], 'logos')).toEqual([]);
    });
});
