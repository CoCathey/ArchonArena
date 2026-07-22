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
        set({
            token: token ?? get().token,
            refreshToken: refreshToken ?? get().refreshToken,
            user: user ?? get().user
        });
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
