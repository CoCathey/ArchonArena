import React, { useEffect, useState } from 'react';
import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, AppState, Pressable, Text, View } from 'react-native';
import { checkAuth, refreshAuthToken } from '../src/api/client';
import { resyncGame } from '../src/net/gameSocket';
import { connectLobby } from '../src/net/lobbySocket';
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
                    name='deck/[id]'
                    options={{ title: 'Deck', headerBackTitle: 'Back' }}
                />
                <Stack.Screen
                    name='game'
                    options={{ headerShown: false, gestureEnabled: false }}
                />
            </Stack>
        </>
    );
}
