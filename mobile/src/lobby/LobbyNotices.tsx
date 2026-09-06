import { useEffect } from 'react';
import { router } from 'expo-router';
import { Alert } from 'react-native';
import type { LobbyNotice } from '../api/types';
import { routeForSiteUrl } from '../appRoutes';
import { successFeedback, warnFeedback } from '../haptics';
import { useLobbyStore } from '../stores/lobbyStore';

/**
 * ARCHON: says the lobby's 'lobbynotice' messages, wherever the player is.
 *
 * These notices exist because a tournament player pressed a button and nothing
 * happened. The one thing they must not be is another thing that only renders
 * in a place the player is not — and an inline banner, where 'banner' and
 * 'gameError' go, is exactly that: it lives on the Play tab, while somebody
 * who has just been cleared out of a finished tournament table is as likely to
 * be on the event page or in their decks.
 *
 * So they come out as an Alert, which is how this app already puts a sentence
 * in front of somebody from any screen ("Report sent", "Blocked", "Account
 * deleted"), and which can carry the notice's url as a button — one press to
 * the event page rather than a search for it. Mounted once at the root, like
 * the website's LobbyNoticeToaster.
 */

/**
 * An Alert has no equivalent of the web toast's colour, so the tone picks the
 * heading — the one thing that says at a glance whether the modal that has
 * just appeared is news or something standing in the player's way.
 */
function titleFor(tone: LobbyNotice['tone']): string {
    return tone === 'warning' ? 'Heads up' : 'From the lobby';
}

export default function LobbyNotices() {
    const notice = useLobbyStore((state) => state.notice);

    useEffect(() => {
        if (!notice?.message) {
            return;
        }

        // Cleared before the Alert goes up, not after it is dismissed: the
        // notice has been delivered at this point, and leaving it in the store
        // would show it again on the next render of any screen that subscribes.
        useLobbyStore.getState().clearNotice();

        const tone = notice.tone ?? 'info';
        const route = routeForSiteUrl(notice.url);

        // The tone only picked a toast colour on the website. A phone has a
        // better channel for it: an alert that arrives while the phone is in a
        // pocket is felt before it is read.
        if (tone === 'success') {
            successFeedback();
        } else if (tone === 'warning') {
            warnFeedback();
        }

        Alert.alert(
            titleFor(tone),
            notice.message,
            route
                ? [
                      { text: 'Not now', style: 'cancel' },
                      { text: 'Open', onPress: () => router.push(route) }
                  ]
                : [{ text: 'OK' }]
        );
    }, [notice]);

    return null;
}
