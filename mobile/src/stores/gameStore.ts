import { create } from 'zustand';
import type { HandoffMessage } from '../api/types';
import type { GameState } from '../game/types';

export type GameSocketStatus =
    | 'idle'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'failed'
    | 'closed';

interface GameStoreState {
    status: GameSocketStatus;
    handoff?: HandoffMessage;
    /** Live board state; full state on connect, then patched deltas. */
    rootState?: GameState;
    /**
     * Monotonic counter bumped only when the game node tears the game down
     * (game over / rematch / a player leaves — i.e. a `cleargamestate` event).
     * Screens use a change in this value as the signal to leave the board.
     * It is deliberately distinct from `rootState` becoming undefined, which
     * also happens transiently on every (re)connect while the full state is
     * in flight — that must NOT navigate the user away.
     */
    cleared: number;
    setStatus: (status: GameSocketStatus) => void;
    setHandoff: (handoff?: HandoffMessage) => void;
    setRootState: (state?: GameState) => void;
    markCleared: () => void;
    reset: () => void;
}

export const useGameStore = create<GameStoreState>((set) => ({
    status: 'idle',
    handoff: undefined,
    rootState: undefined,
    cleared: 0,
    setStatus: (status) => set({ status }),
    setHandoff: (handoff) => set({ handoff }),
    setRootState: (rootState) => set({ rootState }),
    markCleared: () => set((state) => ({ cleared: state.cleared + 1, rootState: undefined })),
    // reset() intentionally leaves `cleared` untouched so it stays monotonic
    // across games; screens capture its value on mount and react to increases.
    reset: () => set({ status: 'idle', handoff: undefined, rootState: undefined })
}));
