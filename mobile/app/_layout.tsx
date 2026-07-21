import React, { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { checkAuth, refreshAuthToken } from '../src/api/client';
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
        (async () => {
            // Try to restore the session silently before showing any screen.
            if (useAuthStore.getState().refreshToken) {
                const token = await refreshAuthToken();
                if (token) {
                    await checkAuth();
                }
            }
            setBooted(true);
        })();
    }, [authHydrated, settingsHydrated, booted]);

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
                <Stack.Screen name='register' options={{ title: 'Create account' }} />
                <Stack.Screen name='new-game' options={{ title: 'New game', presentation: 'modal' }} />
                <Stack.Screen name='pending' options={{ title: 'Game lobby' }} />
                <Stack.Screen
                    name='game'
                    options={{ headerShown: false, gestureEnabled: false }}
                />
            </Stack>
        </>
    );
}
