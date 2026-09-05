import { beforeEach, describe, expect, it } from 'vitest';
import type { GameSummary } from '../src/api/types';
import { useLobbyStore } from '../src/stores/lobbyStore';

const game = (id: string, name = id): GameSummary =>
    ({ id, name, players: {}, started: false } as unknown as GameSummary);

describe('lobbyStore.addGames', () => {
    beforeEach(() => {
        useLobbyStore.getState().setGames([]);
    });

    it('puts a new game at the top of the list', () => {
        useLobbyStore.getState().setGames([game('a')]);
        useLobbyStore.getState().addGames([game('b')]);

        expect(useLobbyStore.getState().games.map((entry) => entry.id)).toEqual(['b', 'a']);
    });

    // The lobby announces a game to everyone, its creator included, and the
    // creator's list may already hold it from the last full refresh. Listing
    // it twice put two identical rows on the Play tab and tripped React's
    // duplicate-key warning on the game id.
    it('replaces a game already in the list instead of listing it twice', () => {
        useLobbyStore.getState().setGames([game('a', 'old name'), game('c')]);
        useLobbyStore.getState().addGames([game('a', 'new name')]);

        const games = useLobbyStore.getState().games;
        expect(games.map((entry) => entry.id)).toEqual(['a', 'c']);
        expect(games[0].name).toBe('new name');
    });
});
