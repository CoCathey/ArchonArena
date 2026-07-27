import { describe, expect, it } from 'vitest';
import { canDragCard, canDropCard } from '../src/game/dragRules';
import type { CardSummary } from '../src/game/types';

const playable: CardSummary = { uuid: 'c1', canPlay: true };
const unplayable: CardSummary = { uuid: 'c2' };

describe('canDragCard', () => {
    it('allows any card in manual mode', () => {
        expect(canDragCard(unplayable, 'discard', true)).toBe(true);
        expect(canDragCard(unplayable, 'play area', true)).toBe(true);
    });

    it('in normal play allows only playable hand cards', () => {
        expect(canDragCard(playable, 'hand', false)).toBe(true);
        expect(canDragCard(unplayable, 'hand', false)).toBe(false);
        expect(canDragCard(playable, 'play area', false)).toBe(false);
        expect(canDragCard({ ...playable, unselectable: true }, 'hand', false)).toBe(false);
    });
});

describe('canDropCard', () => {
    it('never allows dropping back onto the source', () => {
        expect(canDropCard(playable, 'hand', 'hand', true)).toBe(false);
    });

    it('normal play: hand → play area / discard for playable cards only', () => {
        expect(canDropCard(playable, 'hand', 'play area', false)).toBe(true);
        expect(canDropCard(playable, 'hand', 'discard', false)).toBe(true);
        expect(canDropCard(playable, 'hand', 'archives', false)).toBe(false);
        expect(canDropCard(unplayable, 'hand', 'play area', false)).toBe(false);
        expect(canDropCard(playable, 'play area', 'discard', false)).toBe(false);
    });

    it('manual mode: mirrors the web valid-target matrix', () => {
        // Every zone pair from client/Components/GameBoard/Droppable.jsx.
        const zones = ['hand', 'play area', 'discard', 'archives', 'deck', 'purged'] as const;
        for (const source of zones) {
            for (const target of zones) {
                expect(canDropCard(unplayable, source, target, true)).toBe(source !== target);
            }
        }
    });
});
