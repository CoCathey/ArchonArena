import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import type { RefreshToken, UserDetails } from '../api/types';

const REFRESH_TOKEN_KEY = 'aa.refreshToken';
const USER_KEY = 'aa.user';

interface AuthState {
    /** Short-lived JWT used for REST calls and socket auth. */
    token?: string;
    refreshToken?: RefreshToken;
    user?: UserDetails;
    hydrated: boolean;
    hydrate: () => Promise<void>;
    setAuth: (auth: {
        token?: string;
        refreshToken?: RefreshToken;
        user?: UserDetails;
    }) => Promise<void>;
    clear: () => Promise<void>;
}

/**
 * Finishing the welcome flow is one-way, but not every copy of the user the
 * app receives knows it happened. The lobby sends one with every game
 * handoff, taken from its socket's own user object - loaded when the socket
 * connected, so a flow finished since then still reads `onboarded: false`
 * there. Adopting that copy as-is sent a player back to step one the moment
 * they joined or watched a game. So for the same account, a completion the
 * app has already seen wins over an incoming copy that has not caught up.
 */
function withCompletedOnboarding(
    previous: UserDetails | undefined,
    incoming: UserDetails
): UserDetails {
    const sameAccount =
        !!previous &&
        (previous.id !== undefined && incoming.id !== undefined
            ? String(previous.id) === String(incoming.id)
            : previous.username === incoming.username);

    if (sameAccount && previous?.onboarded === true && incoming.onboarded === false) {
        return { ...incoming, onboarded: true };
    }

    return incoming;
}

export const useAuthStore = create<AuthState>((set, get) => ({
    token: undefined,
    refreshToken: undefined,
    user: undefined,
    hydrated: false,
    hydrate: async () => {
        try {
            const [storedToken, storedUser] = await Promise.all([
                SecureStore.getItemAsync(REFRESH_TOKEN_KEY),
                SecureStore.getItemAsync(USER_KEY)
            ]);
            set({
                refreshToken: storedToken ? JSON.parse(storedToken) : undefined,
                user: storedUser ? JSON.parse(storedUser) : undefined
            });
        } catch {
            set({ refreshToken: undefined, user: undefined });
        } finally {
            set({ hydrated: true });
        }
    },
    setAuth: async ({ token, refreshToken, user }) => {
        const merged = user ? withCompletedOnboarding(get().user, user) : get().user;
        set({
            token: token ?? get().token,
            refreshToken: refreshToken ?? get().refreshToken,
            user: merged
        });
        user = merged;
        try {
            if (refreshToken) {
                await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, JSON.stringify(refreshToken));
            }
            if (user) {
                await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
            }
        } catch {
            // persistence is best-effort; in-memory auth still works
        }
    },
    clear: async () => {
        set({ token: undefined, refreshToken: undefined, user: undefined });
        try {
            await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
            await SecureStore.deleteItemAsync(USER_KEY);
        } catch {
            // ignore
        }
    }
}));
