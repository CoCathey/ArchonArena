import { create } from 'zustand';
import type { GameSummary } from '../api/types';

export type LobbyStatus = 'disconnected' | 'connecting' | 'connected';

interface LobbyState {
    status: LobbyStatus;
    games: GameSummary[];
    /** The pending (not yet started) game this user sits in, if any. */
    currentGame?: GameSummary;
    users: { name: string; avatar?: string }[];
    motd?: { message?: string; [key: string]: unknown };
    banner?: string;
    passwordError?: string;
    gameError?: string;
    setStatus: (status: LobbyStatus) => void;
    setGames: (games: GameSummary[]) => void;
    addGames: (games: GameSummary[]) => void;
    updateGames: (games: GameSummary[]) => void;
    removeGames: (games: GameSummary[]) => void;
    setCurrentGame: (game?: GameSummary) => void;
    setUsers: (users: { name: string; avatar?: string }[]) => void;
    setMotd: (motd?: LobbyState['motd']) => void;
    setBanner: (banner?: string) => void;
    setPasswordError: (error?: string) => void;
    setGameError: (error?: string) => void;
    reset: () => void;
}

export const useLobbyStore = create<LobbyState>((set, get) => ({
    status: 'disconnected',
    games: [],
    currentGame: undefined,
    users: [],
    setStatus: (status) => set({ status }),
    setGames: (games) => {
        const { currentGame } = get();
        // If our pending game vanished from the authoritative list, drop it.
        if (currentGame && !games.some((game) => game.id === currentGame.id)) {
            set({ games, currentGame: undefined });
        } else {
            set({ games });
        }
    },
    addGames: (games) => set({ games: [...games, ...get().games] }),
    updateGames: (games) =>
        set({
            games: get().games.map((existing) => {
                const updated = games.find((game) => game.id === existing.id);
                return updated ?? existing;
            })
        }),
    removeGames: (games) => {
        const { currentGame } = get();
        const next: Partial<LobbyState> = {
            games: get().games.filter(
                (existing) => !games.some((game) => game.id === existing.id)
            )
        };
        if (
            currentGame &&
            !currentGame.started &&
            games.some((game) => game.id === currentGame.id)
        ) {
            next.currentGame = undefined;
            next.gameError = 'The game has timed out and is no longer available.';
        }
        set(next);
    },
    setCurrentGame: (game) => set({ currentGame: game, passwordError: undefined }),
    setUsers: (users) => set({ users }),
    setMotd: (motd) => set({ motd }),
    setBanner: (banner) => set({ banner }),
    setPasswordError: (error) => set({ passwordError: error }),
    setGameError: (error) => set({ gameError: error }),
    reset: () =>
        set({
            status: 'disconnected',
            games: [],
            currentGame: undefined,
            users: [],
            passwordError: undefined,
            gameError: undefined
        })
}));
