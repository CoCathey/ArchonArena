import React, { useEffect, useState } from 'react';
import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, AppState, Pressable, Text, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import { checkAuth, refreshAuthToken } from '../src/api/client';
import { registerForPush, routeForNotification } from '../src/push';
import { resyncGame } from '../src/net/gameSocket';
import { connectLobby } from '../src/net/lobbySocket';
import LobbyNotices from '../src/lobby/LobbyNotices';
import { useAuthStore } from '../src/stores/authStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import { colors } from '../src/theme';

export default function RootLayout() {
    const [booted, setBooted] = useState(false);
    const authHydrated = useAuthStore((state) => state.hydrated);
    const settingsHydrated = useSettingsStore((state) => state.hydrated);

    useEffect(() => {
        useAuthStore.getState().hydrate();
        useSettingsStore.getState().hydrate();
    }, []);

    useEffect(() => {
        if (!authHydrated || !settingsHydrated || booted) {
            return;
        }
        // Never let a stalled restore keep the splash up indefinitely — the
        // login screen (with its server-settings escape hatch) must be able to
        // appear even offline. (REST calls also self-timeout in the client.)
        const safety = setTimeout(() => setBooted(true), 8000);
        (async () => {
            // Try to restore the session silently before showing any screen.
            if (useAuthStore.getState().refreshToken) {
                const token = await refreshAuthToken();
                if (token) {
                    await checkAuth();
                }
            }
            clearTimeout(safety);
            setBooted(true);
        })();
        return () => clearTimeout(safety);
    }, [authHydrated, settingsHydrated, booted]);

    // Register this device for push once there is a session to attach it to,
    // and again whenever the account changes — the token follows the account,
    // not the install.
    const token = useAuthStore((state) => state.token);
    useEffect(() => {
        if (token) {
            registerForPush();
        }
    }, [token]);

    // A tapped notification opens what it is about. Both paths are needed:
    // `getLastNotificationResponseAsync` covers a cold start (the tap launched
    // the app), the listener covers a tap while it is already running.
    useEffect(() => {
        if (!booted) {
            return undefined;
        }

        let cancelled = false;

        const open = (response: Notifications.NotificationResponse | null) => {
            const data = response?.notification?.request?.content?.data as
                | Record<string, unknown>
                | undefined;
            const route = routeForNotification(data);

            if (route && !cancelled) {
                router.push(route);
            }
        };

        Notifications.getLastNotificationResponseAsync().then(open);
        const sub = Notifications.addNotificationResponseReceivedListener(open);

        return () => {
            cancelled = true;
            sub.remove();
        };
    }, [booted]);

    // iOS suspends sockets in the background; reconnect on return to foreground.
    useEffect(() => {
        const sub = AppState.addEventListener('change', (state) => {
            if (state === 'active' && useAuthStore.getState().token) {
                connectLobby();
                // Pull a fresh game state — a socket suspended in the background
                // can look "connected" but be dead, leaving a stale board.
                resyncGame();
            }
        });
        return () => sub.remove();
    }, []);

    if (!booted) {
        return (
            <View
                style={{
                    flex: 1,
                    backgroundColor: colors.bg,
                    alignItems: 'center',
                    justifyContent: 'center'
                }}
            >
                <ActivityIndicator size='large' color={colors.brand} />
                <StatusBar style='light' />
            </View>
        );
    }

    return (
        <>
            <StatusBar style='light' />
            {/* Renders nothing; it exists so a notice the lobby sends to this
                player is said whatever screen they are on. */}
            <LobbyNotices />
            <Stack
                screenOptions={{
                    headerStyle: { backgroundColor: colors.bgElevated },
                    headerTintColor: colors.text,
                    headerTitleStyle: { fontWeight: '700' },
                    contentStyle: { backgroundColor: colors.bg }
                }}
            >
                <Stack.Screen name='(tabs)' options={{ headerShown: false }} />
                <Stack.Screen name='login' options={{ headerShown: false }} />
                <Stack.Screen
                    name='register'
                    options={{ title: 'Create account', headerBackTitle: 'Back' }}
                />
                <Stack.Screen
                    name='new-game'
                    options={{
                        title: 'New game',
                        presentation: 'modal',
                        headerLeft: () => (
                            <Pressable onPress={() => router.back()} hitSlop={8}>
                                <Text style={{ color: colors.accent, fontSize: 16, fontWeight: '600' }}>
                                    Cancel
                                </Text>
                            </Pressable>
                        )
                    }}
                />
                <Stack.Screen
                    name='pending'
                    options={{ title: 'Game lobby', headerBackTitle: 'Back' }}
                />
                <Stack.Screen
                    name='tournament/[id]'
                    options={{ title: 'Event', headerBackTitle: 'Back' }}
                />
                <Stack.Screen
                    name='tournament/new'
                    options={{
                        title: 'New event',
                        presentation: 'modal',
                        // A modal has no back button; without this the only
                        // way out was a swipe nothing on screen suggests.
                        headerLeft: () => (
                            <Pressable onPress={() => router.back()} hitSlop={8}>
                                <Text style={{ color: colors.accent, fontSize: 16, fontWeight: '600' }}>
                                    Cancel
                                </Text>
                            </Pressable>
                        )
                    }}
                />
                <Stack.Screen
                    name='deck/[id]'
                    options={{ title: 'Deck', headerBackTitle: 'Back' }}
                />
                <Stack.Screen
                    name='notifications'
                    options={{ title: 'Notifications', headerBackTitle: 'Back' }}
                />
                {/* ARCHON: direct messages. The push notification for one has
                    been reaching phones since the website grew an inbox; until
                    these screens existed the tap had nowhere to land. */}
                <Stack.Screen
                    name='messages/index'
                    options={{ title: 'Messages', headerBackTitle: 'Back' }}
                />
                <Stack.Screen
                    name='messages/[username]'
                    options={{ title: 'Conversation', headerBackTitle: 'Messages' }}
                />
                <Stack.Screen
                    name='forgot-password'
                    options={{ title: 'Reset password', headerBackTitle: 'Back' }}
                />
                <Stack.Screen
                    name='security'
                    options={{ title: 'Security', headerBackTitle: 'Back' }}
                />
                <Stack.Screen
                    name='profile-edit'
                    options={{ title: 'Edit profile', headerBackTitle: 'Back' }}
                />
                {/* ARCHON (N13/N9): playing across a table. The phone is the
                    device you have AT the table, so these belong here more
                    than they belong in a browser. */}
                <Stack.Screen
                    name='in-person'
                    options={{ title: 'Paper games', headerBackTitle: 'Back' }}
                />
                <Stack.Screen
                    name='stores'
                    options={{ title: 'Into the Fray', headerBackTitle: 'Back' }}
                />
                <Stack.Screen
                    name='check-in'
                    options={{ title: 'Event check-in', headerBackTitle: 'Back' }}
                />
                <Stack.Screen name='welcome' options={{ headerShown: false }} />
                <Stack.Screen
                    name='deck-import'
                    options={{ title: 'Import decks', headerBackTitle: 'Back' }}
                />
                <Stack.Screen
                    name='decks/alliance'
                    options={{ title: 'Build alliance', headerBackTitle: 'Back' }}
                />
                {/* ARCHON: the people section. Stack screens rather than a
                    sixth tab — the tab bar is full, and these are places you
                    go from a name you tapped rather than places you live. */}
                <Stack.Screen
                    name='community'
                    options={{ title: 'Community', headerBackTitle: 'Back' }}
                />
                <Stack.Screen
                    name='players/[username]'
                    options={{ title: 'Player', headerBackTitle: 'Back' }}
                />
                <Stack.Screen
                    name='club/[id]'
                    options={{ title: 'Club', headerBackTitle: 'Back' }}
                />
                <Stack.Screen
                    name='team/[id]'
                    options={{ title: 'Team', headerBackTitle: 'Back' }}
                />
                {/* ARCHON (N12): Archon+ and the tools it unlocks. Stack
                    screens rather than tabs — six tabs is already the most a
                    phone reads comfortably, and these are places you go to
                    rather than places you live. Reached from Profile and from
                    the locked panels on Stats. */}
                <Stack.Screen
                    name='membership'
                    options={{ title: 'Archon+', headerBackTitle: 'Back' }}
                />
                {/* The registered `archonarena://patreon` deep link. Normally
                    swallowed by the auth session; this exists so a cold start
                    on that URL does not land on expo-router's unmatched-route
                    error page in a shipped build. */}
                <Stack.Screen name='patreon' options={{ headerShown: false }} />
                <Stack.Screen
                    name='intelligence'
                    options={{ title: 'Archon Intelligence', headerBackTitle: 'Back' }}
                />
                <Stack.Screen
                    name='champions-challenge'
                    options={{ title: "Champion's Challenge", headerBackTitle: 'Back' }}
                />
                <Stack.Screen
                    name='tournament-lab'
                    options={{ title: 'Deep Probe', headerBackTitle: 'Back' }}
                />
                <Stack.Screen
                    name='game'
                    options={{ headerShown: false, gestureEnabled: false }}
                />
            </Stack>
        </>
    );
}
