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
    setStatus: (status: GameSocketStatus) => void;
    setHandoff: (handoff?: HandoffMessage) => void;
    setRootState: (state?: GameState) => void;
    reset: () => void;
}

export const useGameStore = create<GameStoreState>((set) => ({
    status: 'idle',
    handoff: undefined,
    rootState: undefined,
    setStatus: (status) => set({ status }),
    setHandoff: (handoff) => set({ handoff }),
    setRootState: (rootState) => set({ rootState }),
    reset: () => set({ status: 'idle', handoff: undefined, rootState: undefined })
}));
