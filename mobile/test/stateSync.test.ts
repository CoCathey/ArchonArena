import { describe, expect, it } from 'vitest';
import { resolveGameState } from '../src/net/stateSync';
import type { GameState } from '../src/game/types';

const board = { name: 'Test game', players: {} } as unknown as GameState;

describe('resolveGameState', () => {
    it('adopts a board the node marked complete', () => {
        const fresh = { name: 'Test game', phase: 'key' } as unknown as GameState;

        expect(resolveGameState(board, fresh, { full: true })).toEqual({
            action: 'replace',
            state: fresh
        });
    });

    it('patches a delta onto the board it holds', () => {
        const delta = { players: { alice: [{ amber: 2 }] } };

        expect(resolveGameState(board, delta, { full: false })).toEqual({
            action: 'patch',
            delta
        });
    });

    // The failure this exists to prevent. The node resets its diff baseline for
    // a player whenever a connection for them opens or closes, so a second
    // client signed in as the same user makes it send *this* client a complete
    // board while this client is still holding one. Guessing "I have a board, so
    // this is a delta" put a whole game state through a delta patcher, which
    // silently deletes every number and boolean in it — and, in the web client's
    // jsondiffpatch, never returns at all on the first string it meets.
    it('replaces rather than patches when a complete board arrives mid-game', () => {
        const fresh = { name: 'Test game', phase: 'main' } as unknown as GameState;

        expect(resolveGameState(board, fresh, { full: true }).action).toBe('replace');
    });

    it('asks for a snapshot rather than adopting a delta as a board', () => {
        expect(resolveGameState(undefined, { players: { alice: [{ amber: 2 }] } }, { full: false })).toEqual(
            { action: 'resync' }
        );
    });

    it('ignores an empty delta — the board did not change', () => {
        expect(resolveGameState(board, undefined, { full: false })).toEqual({ action: 'ignore' });
        expect(resolveGameState(board, null, { full: false })).toEqual({ action: 'ignore' });
    });

    describe('a node older than the marker', () => {
        it('treats the first state as a complete board', () => {
            expect(resolveGameState(undefined, board).action).toBe('replace');
        });

        it('treats a later state as a delta', () => {
            expect(resolveGameState(board, { players: {} }).action).toBe('patch');
        });
    });
});
