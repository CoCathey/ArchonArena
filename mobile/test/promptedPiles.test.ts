import { describe, expect, it } from 'vitest';
import { isOpponentHandPrompted, isPilePrompted } from '../src/game/promptedPiles';
import type { PlayerState, PromptedPile } from '../src/game/types';

const player = (promptedPiles?: PromptedPile[]): PlayerState =>
    ({
        name: 'me',
        numDeckCards: 20,
        stats: { amber: 0, chains: 0, keyCost: 6, keys: { red: false, blue: false, yellow: false } },
        cardPiles: { archives: [], cardsInPlay: [], discard: [], hand: [], purged: [] },
        promptedPiles
    }) as PlayerState;

describe('isPilePrompted', () => {
    it('is false when the prompt names no piles', () => {
        expect(isPilePrompted(undefined, 'hand', false)).toBe(false);
        expect(isPilePrompted([], 'hand', false)).toBe(false);
    });

    it("matches the opponent's pile for an opponent-controlled prompt", () => {
        const piles: PromptedPile[] = [{ location: 'hand', controller: 'opponent' }];
        expect(isPilePrompted(piles, 'hand', false)).toBe(true);
        expect(isPilePrompted(piles, 'hand', true)).toBe(false);
    });

    it('matches my pile for a self-controlled prompt', () => {
        const piles: PromptedPile[] = [{ location: 'discard', controller: 'self' }];
        expect(isPilePrompted(piles, 'discard', true)).toBe(true);
        expect(isPilePrompted(piles, 'discard', false)).toBe(false);
    });

    it("matches both sides for 'any'", () => {
        const piles: PromptedPile[] = [{ location: 'archives', controller: 'any' }];
        expect(isPilePrompted(piles, 'archives', true)).toBe(true);
        expect(isPilePrompted(piles, 'archives', false)).toBe(true);
    });

    it('does not match a different pile of the same controller', () => {
        const piles: PromptedPile[] = [{ location: 'discard', controller: 'opponent' }];
        expect(isPilePrompted(piles, 'hand', false)).toBe(false);
    });

    it('survives a hole in the list', () => {
        const piles = [undefined, { location: 'hand', controller: 'opponent' }] as PromptedPile[];
        expect(isPilePrompted(piles, 'hand', false)).toBe(true);
    });
});

describe('isOpponentHandPrompted', () => {
    it('is true for Abyssal Sight — pick a card out of their hand', () => {
        expect(isOpponentHandPrompted(player([{ location: 'hand', controller: 'opponent' }]))).toBe(
            true
        );
    });

    it('is false while nothing is being prompted', () => {
        expect(isOpponentHandPrompted(player())).toBe(false);
        expect(isOpponentHandPrompted(undefined)).toBe(false);
    });

    it('is false for a prompt about my own hand', () => {
        expect(isOpponentHandPrompted(player([{ location: 'hand', controller: 'self' }]))).toBe(
            false
        );
    });

    it('is false when either hand would do, so the hand strip keeps the choice', () => {
        expect(isOpponentHandPrompted(player([{ location: 'hand', controller: 'any' }]))).toBe(
            false
        );
        expect(
            isOpponentHandPrompted(
                player([
                    { location: 'hand', controller: 'self' },
                    { location: 'hand', controller: 'opponent' }
                ])
            )
        ).toBe(false);
    });

    it("is false for their discard — that pile already opens from its own chip", () => {
        expect(
            isOpponentHandPrompted(player([{ location: 'discard', controller: 'opponent' }]))
        ).toBe(false);
    });
});
