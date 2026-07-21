import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

const SERVER_URL_KEY = 'aa.serverUrl';
export const DEFAULT_SERVER_URL = 'https://archonarena.com';

/** Normalize whatever the user typed into an origin like https://host[:port]. */
export function normalizeServerUrl(input: string): string {
    let url = (input || '').trim();
    if (!url) {
        return DEFAULT_SERVER_URL;
    }
    if (!/^https?:\/\//i.test(url)) {
        url = `https://${url}`;
    }
    return url.replace(/\/+$/, '');
}

interface SettingsState {
    serverUrl: string;
    hydrated: boolean;
    hydrate: () => Promise<void>;
    setServerUrl: (url: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
    serverUrl: DEFAULT_SERVER_URL,
    hydrated: false,
    hydrate: async () => {
        try {
            const stored = await SecureStore.getItemAsync(SERVER_URL_KEY);
            set({ serverUrl: stored ? normalizeServerUrl(stored) : DEFAULT_SERVER_URL });
        } catch {
            set({ serverUrl: DEFAULT_SERVER_URL });
        } finally {
            set({ hydrated: true });
        }
    },
    setServerUrl: async (url: string) => {
        const normalized = normalizeServerUrl(url);
        set({ serverUrl: normalized });
        try {
            await SecureStore.setItemAsync(SERVER_URL_KEY, normalized);
        } catch {
            // non-fatal: the URL still applies for this session
        }
    }
}));
