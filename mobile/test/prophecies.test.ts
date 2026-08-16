import { describe, expect, it } from 'vitest';
import {
    hasProphecies,
    prophecyAction,
    prophecyPairs,
    prophecyStatus,
    shownProphecy
} from '../src/game/prophecies';
import type { CardSummary } from '../src/game/types';

const card = (uuid: string, overrides: Partial<CardSummary> = {}): CardSummary => ({
    uuid,
    type: 'prophecy',
    ...overrides
});

describe('prophecyPairs', () => {
    it('splits the flat list back into front/back pairs', () => {
        const pairs = prophecyPairs([card('a'), card('b'), card('c'), card('d')]);

        expect(pairs.map((pair) => pair.map((entry) => entry.uuid))).toEqual([
            ['a', 'b'],
            ['c', 'd']
        ]);
    });

    it('keeps a trailing odd card rather than dropping it', () => {
        const pairs = prophecyPairs([card('a'), card('b'), card('c')]);

        expect(pairs.map((pair) => pair.map((entry) => entry.uuid))).toEqual([['a', 'b'], ['c']]);
    });

    it('handles a deck with no prophecies', () => {
        expect(prophecyPairs(undefined)).toEqual([]);
        expect(prophecyPairs([])).toEqual([]);
    });
});

describe('shownProphecy', () => {
    it('shows the active side of a pair', () => {
        const pair = [card('a'), card('b', { activeProphecy: true })];
        expect(shownProphecy(pair)?.uuid).toBe('b');
    });

    it('falls back to the front when neither side is active', () => {
        expect(shownProphecy([card('a'), card('b')])?.uuid).toBe('a');
    });
});

describe('prophecyAction', () => {
    it('answers a prompt before anything else', () => {
        // Selectable wins even for the opponent's prophecy: the engine only
        // marks a card selectable when it is a legal answer.
        expect(prophecyAction(card('a', { selectable: true }), { isMine: false })).toBe('select');
        expect(
            prophecyAction(card('a', { selectable: true, canActivateProphecy: true }), {
                isMine: true
            })
        ).toBe('select');
    });

    it('offers activation on my own prophecy when the engine allows it', () => {
        expect(prophecyAction(card('a', { canActivateProphecy: true }), { isMine: true })).toBe(
            'activate'
        );
    });

    it('offers nothing on a prophecy the engine will not activate', () => {
        expect(prophecyAction(card('a', { canActivateProphecy: false }), { isMine: true })).toBe(
            'none'
        );
    });

    it("never offers an action on the opponent's prophecy", () => {
        expect(
            prophecyAction(card('a', { canActivateProphecy: true }), { isMine: false })
        ).toBe('none');
    });

    it('prefers the manual-mode menu when the card carries one', () => {
        const withMenu = card('a', {
            activeProphecy: true,
            menu: [
                { command: 'click', text: 'Select Card' },
                { command: 'deactivateProphecy', text: 'Deactivate' }
            ]
        });

        expect(prophecyAction(withMenu, { isMine: true, manualMode: true })).toBe('menu');
        // Outside manual mode the same card has nothing to offer.
        expect(prophecyAction(withMenu, { isMine: true, manualMode: false })).toBe('none');
    });

    it('ignores a menu that is only the implicit click entry', () => {
        const clickOnly = card('a', {
            canActivateProphecy: true,
            menu: [{ command: 'click', text: 'Select Card' }]
        });

        expect(prophecyAction(clickOnly, { isMine: true, manualMode: true })).toBe('activate');
    });
});

describe('prophecyStatus', () => {
    it('reads active, ready and idle', () => {
        expect(prophecyStatus(card('a', { activeProphecy: true }), { isMine: true })).toBe('active');
        expect(prophecyStatus(card('a', { canActivateProphecy: true }), { isMine: true })).toBe(
            'ready'
        );
        expect(prophecyStatus(card('a', { canActivateProphecy: true }), { isMine: false })).toBe(
            'idle'
        );
        expect(prophecyStatus(card('a'), { isMine: true })).toBe('idle');
    });
});

describe('hasProphecies', () => {
    it('is false for a board without them, which is every set but PV', () => {
        expect(hasProphecies({ prophecyCards: [] }, undefined)).toBe(false);
        expect(hasProphecies(undefined, undefined)).toBe(false);
    });

    it('is true when either player brought them', () => {
        expect(hasProphecies({ prophecyCards: [] }, { prophecyCards: [card('a')] })).toBe(true);
    });
});
