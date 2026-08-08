import { create } from 'zustand';
import { fetchFriends } from '../api/client';
import type { Friend } from '../api/types';

interface FriendsState {
    friends: Friend[];
    /** Requests waiting on this user to accept or decline. */
    incoming: Friend[];
    /** Requests this user has sent and is waiting on. */
    outgoing: Friend[];
    loading: boolean;
    error?: string;
    /** True once a load has completed, so an empty list reads as empty. */
    loaded: boolean;
    load: (options?: { quiet?: boolean }) => Promise<void>;
    reset: () => void;
}

/**
 * Only the newest request may write. Loads overlap in normal use — accepting a
 * request refreshes the lists while the background poll may already be in
 * flight — and an in-flight guard would turn that refresh into a silent no-op,
 * leaving the accepted request sitting in the incoming list.
 */
let sequence = 0;

export const useFriendsStore = create<FriendsState>((set) => ({
    friends: [],
    incoming: [],
    outgoing: [],
    loading: false,
    loaded: false,
    /**
     * `quiet` is for the background poll: it refreshes the lists without
     * clobbering a visible error with a transient one.
     */
    load: async ({ quiet } = {}) => {
        const id = ++sequence;
        set(quiet ? { loading: true } : { loading: true, error: undefined });
        try {
            const result = await fetchFriends();
            if (id !== sequence) {
                return;
            }
            set({
                friends: result.friends ?? [],
                incoming: result.incoming ?? [],
                outgoing: result.outgoing ?? [],
                error: undefined,
                loaded: true
            });
        } catch (err) {
            if (id === sequence && !quiet) {
                set({ error: err instanceof Error ? err.message : 'Could not load your friends' });
            }
        } finally {
            if (id === sequence) {
                set({ loading: false });
            }
        }
    },
    reset: () => {
        // Retire any in-flight load so a response for the previous account
        // cannot land after the reset.
        sequence++;
        set({
            friends: [],
            incoming: [],
            outgoing: [],
            loading: false,
            loaded: false,
            error: undefined
        });
    }
}));
