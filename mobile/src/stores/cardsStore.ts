import { create } from 'zustand';
import { fetchAllCards } from '../api/client';
import type { ShortCard } from '../api/types';

/**
 * Session cache of the /api/cards dictionary (card id → name/type/house...).
 * Deck lists from the API carry only card ids, so screens that display deck
 * contents load this once and join locally — the app itself ships no card
 * data.
 */
interface CardsStoreState {
    cards?: Record<string, ShortCard>;
    loading: boolean;
    error?: string;
    load: () => Promise<void>;
}

export const useCardsStore = create<CardsStoreState>((set, get) => ({
    cards: undefined,
    loading: false,
    error: undefined,
    load: async () => {
        if (get().cards || get().loading) {
            return;
        }
        set({ loading: true, error: undefined });
        try {
            const result = await fetchAllCards();
            set({ cards: result.cards ?? {}, loading: false });
        } catch (err) {
            set({
                error: err instanceof Error ? err.message : 'Could not load card data',
                loading: false
            });
        }
    }
}));
