import { describe, expect, it } from 'vitest';
import {
    applyGameFilters,
    DEFAULT_GAME_FILTERS,
    filtersAreDefault,
    type GameFilterState
} from '../src/lobby/gameFilters';
import type { GameSummary } from '../src/api/types';

function game(overrides: Partial<GameSummary> = {}): GameSummary {
    return {
        id: overrides.id ?? 'g1',
        name: 'a game',
        owner: 'alice',
        players: { alice: { name: 'alice' } } as GameSummary['players'],
        gameFormat: 'normal',
        ...overrides
    } as GameSummary;
}

const filters = (overrides: Partial<GameFilterState> = {}): GameFilterState => ({
    ...DEFAULT_GAME_FILTERS,
    ...overrides
});

describe('lobby game filters', () => {
    it('shows everything by default', () => {
        const games = [game({ id: 'a' }), game({ id: 'b', started: true })];

        expect(applyGameFilters(games, DEFAULT_GAME_FILTERS)).toHaveLength(2);
        expect(filtersAreDefault(DEFAULT_GAME_FILTERS)).toBe(true);
    });

    it('hides a format only when it is explicitly switched off', () => {
        const games = [game({ id: 'a', gameFormat: 'normal' }), game({ id: 'b', gameFormat: 'sealed' })];

        // A format absent from the map counts as shown — a new format the
        // server adds must not vanish from an old client's list.
        expect(applyGameFilters(games, filters({ formats: { sealed: true } }))).toHaveLength(2);
        expect(
            applyGameFilters(games, filters({ formats: { sealed: false } })).map((g) => g.id)
        ).toEqual(['a']);
    });

    it('treats a game with no format as Archon', () => {
        const games = [game({ id: 'a', gameFormat: undefined })];

        expect(applyGameFilters(games, filters({ formats: { normal: false } }))).toHaveLength(0);
    });

    it('hides started games', () => {
        const games = [game({ id: 'a' }), game({ id: 'b', started: true })];

        expect(applyGameFilters(games, filters({ hideStarted: true })).map((g) => g.id)).toEqual([
            'a'
        ]);
    });

    it('hides practice tables', () => {
        const games = [game({ id: 'a' }), game({ id: 'b', botGame: true })];

        expect(applyGameFilters(games, filters({ hidePractice: true })).map((g) => g.id)).toEqual([
            'a'
        ]);
    });

    it('open-seats hides full pending tables but never started ones', () => {
        const full = { alice: { name: 'alice' }, bob: { name: 'bob' } } as GameSummary['players'];
        const games = [
            game({ id: 'open' }),
            game({ id: 'full', players: full }),
            game({ id: 'running', players: full, started: true })
        ];

        // A started game could never be joined anyway; hiding it here would
        // quietly remove every game the player could watch.
        expect(applyGameFilters(games, filters({ onlyOpenSeats: true })).map((g) => g.id)).toEqual([
            'open',
            'running'
        ]);
    });

    it('reports non-default state so the screen can offer a reset', () => {
        expect(filtersAreDefault(filters({ hideStarted: true }))).toBe(false);
        expect(filtersAreDefault(filters({ formats: { sealed: false } }))).toBe(false);
        expect(filtersAreDefault(filters({ formats: { sealed: true } }))).toBe(true);
    });
});
