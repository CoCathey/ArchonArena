import React, { useEffect } from 'react';
import { Redirect, Tabs } from 'expo-router';
import { AppState, ColorValue, Text } from 'react-native';
import { connectLobby } from '../../src/net/lobbySocket';
import { useAuthStore } from '../../src/stores/authStore';
import { useFriendsStore } from '../../src/stores/friendsStore';
import { colors } from '../../src/theme';

/**
 * How often to re-check for friend requests. They arrive over email/push
 * notifications rather than the lobby socket, so the badge needs a poll — a
 * slow one, since a request is not time-critical.
 */
const FRIEND_POLL_MS = 60000;

function TabIcon(props: { glyph: string; color: ColorValue }) {
    return <Text style={{ fontSize: 20, color: props.color }}>{props.glyph}</Text>;
}

export default function TabsLayout() {
    const user = useAuthStore((state) => state.user);
    const token = useAuthStore((state) => state.token);
    const incoming = useFriendsStore((state) => state.incoming.length);
    const loadFriends = useFriendsStore((state) => state.load);

    useEffect(() => {
        if (token) {
            connectLobby();
        }
    }, [token]);

    // Keep the pending-request badge current while the app is in the
    // foreground, and stop entirely while it is backgrounded.
    useEffect(() => {
        if (!token) {
            // Signing out (or a session expiring) must not leave one account's
            // friends on screen for whoever signs in next.
            useFriendsStore.getState().reset();
            return undefined;
        }

        const poll = () => {
            if (AppState.currentState === 'active') {
                loadFriends({ quiet: true });
            }
        };

        loadFriends({ quiet: true });
        const timer = setInterval(poll, FRIEND_POLL_MS);
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') {
                loadFriends({ quiet: true });
            }
        });

        return () => {
            clearInterval(timer);
            subscription.remove();
        };
    }, [loadFriends, token]);

    if (!user || !token) {
        return <Redirect href='/login' />;
    }

    return (
        <Tabs
            screenOptions={{
                headerStyle: { backgroundColor: colors.bgElevated },
                headerTintColor: colors.text,
                headerTitleStyle: { fontWeight: '700' },
                tabBarStyle: {
                    backgroundColor: colors.bgElevated,
                    borderTopColor: colors.border
                },
                tabBarActiveTintColor: colors.brand,
                tabBarInactiveTintColor: colors.textFaint,
                sceneStyle: { backgroundColor: colors.bg }
            }}
        >
            <Tabs.Screen
                name='index'
                options={{
                    title: 'Play',
                    tabBarIcon: ({ color }) => <TabIcon glyph='⚔' color={color} />
                }}
            />
            <Tabs.Screen
                name='decks'
                options={{
                    title: 'Decks',
                    tabBarIcon: ({ color }) => <TabIcon glyph='🂠' color={color} />
                }}
            />
            <Tabs.Screen
                name='friends'
                options={{
                    title: 'Friends',
                    tabBarIcon: ({ color }) => <TabIcon glyph='♟' color={color} />,
                    tabBarBadge: incoming > 0 ? incoming : undefined,
                    tabBarBadgeStyle: { backgroundColor: colors.brand, color: '#161006' }
                }}
            />
            <Tabs.Screen
                name='stats'
                options={{
                    title: 'Stats',
                    tabBarIcon: ({ color }) => <TabIcon glyph='♛' color={color} />
                }}
            />
            <Tabs.Screen
                name='profile'
                options={{
                    title: 'Profile',
                    tabBarIcon: ({ color }) => <TabIcon glyph='◈' color={color} />
                }}
            />
        </Tabs>
    );
}
