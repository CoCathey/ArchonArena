import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { registerPushToken, removePushToken } from './api/client';
import { routeForSiteUrl } from './appRoutes';

/**
 * ARCHON: push notifications.
 *
 * The server decides what is worth interrupting somebody for (see the
 * notification taxonomy) and sends through Expo. This side does three things:
 * asks for permission, hands the resulting token to the server, and turns a
 * tap into a screen.
 *
 * The token is kept here so sign-out can withdraw it. Leaving it registered
 * would keep delivering the previous account's pairings to a phone that has
 * since been handed to somebody else.
 */
let currentToken: string | undefined;

/** Foreground behaviour: show the banner rather than swallowing it. */
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false
    })
});

/**
 * Android requires a channel before anything is delivered, and the channel —
 * not the message — carries importance. HIGH is what makes a pairing or a
 * match reminder appear as a heads-up banner instead of a silent tray entry.
 */
async function ensureAndroidChannel(): Promise<void> {
    if (Platform.OS !== 'android') {
        return;
    }

    await Notifications.setNotificationChannelAsync('default', {
        name: 'Tournaments and matches',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#e8a33d'
    });
}

/** The EAS project id, which Expo needs to mint a token for this build. */
function projectId(): string | undefined {
    const config = Constants.expoConfig as { extra?: { eas?: { projectId?: string } } } | null;

    return (
        config?.extra?.eas?.projectId ??
        (Constants.easConfig as { projectId?: string } | undefined)?.projectId
    );
}

export interface PushRegistration {
    token?: string;
    /** Why there is no token, when there is none. */
    reason?: 'simulator' | 'denied' | 'unavailable' | 'error';
}

/**
 * Ask for permission (if it has not been settled already), mint a token and
 * register it. Safe to call on every launch — re-registering is also how a
 * rotated token, or a phone that has changed hands, gets fixed.
 */
export async function registerForPush(): Promise<PushRegistration> {
    // A simulator has no push service to register with. This is not a failure
    // worth showing anybody, it is just what a simulator is.
    if (!Device.isDevice) {
        return { reason: 'simulator' };
    }

    try {
        await ensureAndroidChannel();

        const existing = await Notifications.getPermissionsAsync();
        let status = existing.status;

        // Only ask when the user has not already answered. Asking again after
        // a refusal does nothing on iOS anyway.
        if (status !== 'granted' && existing.canAskAgain) {
            status = (await Notifications.requestPermissionsAsync()).status;
        }

        if (status !== 'granted') {
            return { reason: 'denied' };
        }

        const id = projectId();
        const response = await Notifications.getExpoPushTokenAsync(id ? { projectId: id } : {});
        const token = response?.data;

        if (!token) {
            return { reason: 'unavailable' };
        }

        currentToken = token;

        await registerPushToken(token, {
            platform: Platform.OS,
            deviceName: Device.deviceName ?? undefined
        });

        return { token };
    } catch {
        // Never surface this: the app works without push, and a phone that
        // could not register is not a reason to block anything.
        return { reason: 'error' };
    }
}

/**
 * Withdraw this device on sign-out. Best effort — if the call fails the token
 * still stops working once the next account registers it, but leaving it is
 * how one person ends up getting another's notifications.
 */
export async function unregisterPush(): Promise<void> {
    if (!currentToken) {
        return;
    }

    const token = currentToken;
    currentToken = undefined;

    try {
        await removePushToken(token);
    } catch {
        // Signing out must not fail because the network did.
    }
}

/**
 * Where a notification wants to go. The server sends the site path it would
 * have used on the web; the app maps the ones it can render and ignores the
 * rest rather than pushing a screen that does not exist.
 */
export function routeForNotification(data: Record<string, unknown> | undefined): string | undefined {
    if (!data) {
        return undefined;
    }

    const tournamentId = data.tournamentId;
    if (typeof tournamentId === 'number' || typeof tournamentId === 'string') {
        return `/tournament/${tournamentId}`;
    }

    // Fall back to the web url, which is what non-tournament categories carry —
    // a direct message reaches the phone with nothing but `/messages/<name>` to
    // say where it came from. Shared with lobby notices so the two never
    // disagree about which site paths the app can open.
    return routeForSiteUrl(data.url);
}
