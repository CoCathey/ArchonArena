import { create } from 'zustand';
import type { GameSummary, LobbyMessage } from '../api/types';

export type LobbyStatus = 'disconnected' | 'connecting' | 'connected';

/**
 * ARCHON: Quick Match, as the lobby reports it.
 *
 * 'searching' is the server's own word and carries the live queue size, which
 * is the only honest thing to show somebody waiting — "3 players looking" is
 * information, a spinner is not.
 */
export interface MatchmakingState {
    status: 'idle' | 'searching' | 'matched' | 'error';
    format?: string;
    queued?: number;
    message?: string;
}

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
    /** Quick Match: the state of this account's place in the queue. */
    matchmaking: MatchmakingState;
    /** Site-wide lobby chat, oldest first. */
    chat: LobbyMessage[];
    /**
     * Why the server refused a chat message (too new an account, or a mute).
     * Held rather than shown as an error banner because it is an explanation,
     * not a failure of the app.
     */
    chatRefusal?: string;
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
    setMatchmaking: (state: MatchmakingState) => void;
    setChat: (messages: LobbyMessage[]) => void;
    addChatMessage: (message: LobbyMessage) => void;
    setChatRefusal: (message?: string) => void;
    reset: () => void;
}

export const useLobbyStore = create<LobbyState>((set, get) => ({
    status: 'disconnected',
    games: [],
    currentGame: undefined,
    users: [],
    matchmaking: { status: 'idle' },
    chat: [],
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
    // The lobby announces a game to everyone, its creator included, and the
    // creator's list may already hold it from the last full refresh - so an
    // arriving game replaces its own earlier entry rather than joining it.
    addGames: (games) => {
        const arriving = new Set(games.map((game) => game.id));
        set({ games: [...games, ...get().games.filter((game) => !arriving.has(game.id))] });
    },
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
    setMatchmaking: (matchmaking) => set({ matchmaking }),
    setChat: (chat) => set({ chat }),
    // Capped: the lobby has been talking since long before this session, and a
    // phone has no use for more scrollback than a person will read.
    addChatMessage: (message) => set({ chat: [...get().chat, message].slice(-200) }),
    setChatRefusal: (chatRefusal) => set({ chatRefusal }),
    reset: () =>
        set({
            status: 'disconnected',
            games: [],
            currentGame: undefined,
            users: [],
            passwordError: undefined,
            gameError: undefined,
            matchmaking: { status: 'idle' },
            chat: [],
            chatRefusal: undefined
        })
}));
