import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

const LEGACY_SERVER_URL_KEY = 'aa.serverUrl';
const GROUP_HAND_KEY = 'aa.groupHandByHouse';
const HIDE_HAND_KEY = 'aa.hideHandOnOpponentTurn';

/**
 * The one server this app talks to. It used to be user-editable; nobody but a
 * self-hoster wanted that and it was an easy way to lock yourself out of the
 * app, so the app is pinned here and the old stored value is cleared on
 * startup.
 *
 * A developer running the backend locally sets `EXPO_PUBLIC_SERVER_URL` in
 * the environment of `expo start` instead (Expo inlines `EXPO_PUBLIC_*` at
 * bundle time, so a shipped build without it keeps the pinned host). The
 * game node must be reachable from the device on its own port as well.
 */
export const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL || 'https://archonarena.com';

interface SettingsState {
    serverUrl: string;
    /** Sort the in-game hand into house groups instead of draw order. */
    groupHandByHouse: boolean;
    /**
     * Stand the hand down while the opponent is taking their turn, so the
     * board and the log have the screen. The same setting exists on the
     * account (`optionSettings.hideHandOnOpponentTurn`) and either turns it
     * on — see src/game/handVisibility.ts.
     */
    hideHandOnOpponentTurn: boolean;
    hydrated: boolean;
    hydrate: () => Promise<void>;
    setGroupHandByHouse: (value: boolean) => Promise<void>;
    setHideHandOnOpponentTurn: (value: boolean) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
    serverUrl: SERVER_URL,
    groupHandByHouse: true,
    // Off by default, so an existing player's board keeps behaving the way it
    // always has until they ask for this.
    hideHandOnOpponentTurn: false,
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
            const stored = await SecureStore.getItemAsync(HIDE_HAND_KEY);
            if (stored !== null) {
                set({ hideHandOnOpponentTurn: stored === '1' });
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
    },
    setHideHandOnOpponentTurn: async (value: boolean) => {
        set({ hideHandOnOpponentTurn: value });
        try {
            await SecureStore.setItemAsync(HIDE_HAND_KEY, value ? '1' : '0');
        } catch {
            // non-fatal: the choice still applies for this session
        }
    }
}));
