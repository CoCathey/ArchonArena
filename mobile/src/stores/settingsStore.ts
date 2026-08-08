import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

const LEGACY_SERVER_URL_KEY = 'aa.serverUrl';
const GROUP_HAND_KEY = 'aa.groupHandByHouse';

/**
 * The one server this app talks to. It used to be user-editable; nobody but a
 * self-hoster wanted that and it was an easy way to lock yourself out of the
 * app, so the app is pinned here and the old stored value is cleared on
 * startup.
 */
export const SERVER_URL = 'https://archonarena.com';

interface SettingsState {
    serverUrl: string;
    /** Sort the in-game hand into house groups instead of draw order. */
    groupHandByHouse: boolean;
    hydrated: boolean;
    hydrate: () => Promise<void>;
    setGroupHandByHouse: (value: boolean) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
    serverUrl: SERVER_URL,
    groupHandByHouse: true,
    hydrated: false,
    hydrate: async () => {
        try {
            const stored = await SecureStore.getItemAsync(GROUP_HAND_KEY);
            if (stored !== null) {
                set({ groupHandByHouse: stored === '1' });
            }
        } catch {
            // non-fatal: the default applies
        }
        try {
            // Drop any custom server a previous version saved, so an
            // unreachable host cannot strand the app offline forever.
            await SecureStore.deleteItemAsync(LEGACY_SERVER_URL_KEY);
        } catch {
            // non-fatal
        }
        set({ hydrated: true });
    },
    setGroupHandByHouse: async (value: boolean) => {
        set({ groupHandByHouse: value });
        try {
            await SecureStore.setItemAsync(GROUP_HAND_KEY, value ? '1' : '0');
        } catch {
            // non-fatal: the choice still applies for this session
        }
    }
}));
