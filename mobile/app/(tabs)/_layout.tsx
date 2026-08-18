import React, { useEffect } from 'react';
import { Redirect, Tabs, router } from 'expo-router';
import { AppState, ColorValue, Pressable, Text, View } from 'react-native';
import { connectLobby } from '../../src/net/lobbySocket';
import { useAuthStore } from '../../src/stores/authStore';
import { useFriendsStore } from '../../src/stores/friendsStore';
import { useNotificationsStore } from '../../src/stores/notificationsStore';
import { colors } from '../../src/theme';

/**
 * How often to re-check for friend requests. They arrive over email/push
 * notifications rather than the lobby socket, so the badge needs a poll — a
 * slow one, since a request is not time-critical.
 */
const FRIEND_POLL_MS = 60000;

/**
 * How often to re-check the unread notification count. Same reasoning as the
 * friends poll: notifications arrive over push, so this only has to keep the
 * badge honest for somebody sitting in the app with push declined.
 */
const NOTIFICATION_POLL_MS = 60000;

function TabIcon(props: { glyph: string; color: ColorValue }) {
    return <Text style={{ fontSize: 20, color: props.color }}>{props.glyph}</Text>;
}

/**
 * ARCHON: the bell, mirroring the website's top-nav one. It sits on Play
 * because that is the screen the app opens on — a notification centre nobody
 * passes is a notification centre nobody reads.
 */
function NotificationBell() {
    const unread = useNotificationsStore((state) => state.unread);

    return (
        <Pressable
            onPress={() => router.push('/notifications')}
            hitSlop={10}
            accessibilityRole='button'
            accessibilityLabel={
                unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'
            }
            style={{ paddingHorizontal: 14 }}
        >
            <Text style={{ fontSize: 19, color: colors.text }}>🔔</Text>
            {unread > 0 ? (
                <View
                    style={{
                        position: 'absolute',
                        top: -3,
                        right: 7,
                        minWidth: 16,
                        paddingHorizontal: 3,
                        height: 16,
                        borderRadius: 8,
                        backgroundColor: colors.brand,
                        alignItems: 'center',
                        justifyContent: 'center'
                    }}
                >
                    <Text style={{ color: '#161006', fontSize: 10, fontWeight: '800' }}>
                        {unread > 99 ? '99+' : unread}
                    </Text>
                </View>
            ) : null}
        </Pressable>
    );
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

    // The bell's badge, on the same terms as the friends one.
    useEffect(() => {
        if (!token) {
            useNotificationsStore.getState().reset();
            return undefined;
        }

        const refresh = () => useNotificationsStore.getState().refreshCount();
        const poll = () => {
            if (AppState.currentState === 'active') {
                refresh();
            }
        };

        refresh();
        const timer = setInterval(poll, NOTIFICATION_POLL_MS);
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') {
                refresh();
            }
        });

        return () => {
            clearInterval(timer);
            subscription.remove();
        };
    }, [token]);

    if (!user || !token) {
        return <Redirect href='/login' />;
    }

    // ARCHON: a new account finishes (or skips) the welcome flow before it
    // lands on an empty game list. `onboarded === false` rather than falsy:
    // an older server that does not send the field must not push every
    // existing player back through the wizard.
    if ((user as { onboarded?: boolean }).onboarded === false) {
        return <Redirect href='/welcome' />;
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
                    tabBarIcon: ({ color }) => <TabIcon glyph='⚔' color={color} />,
                    headerRight: () => <NotificationBell />
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
                name='tournaments'
                options={{
                    title: 'Events',
                    tabBarIcon: ({ color }) => <TabIcon glyph='🏆' color={color} />
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
                    tabBarIcon: ({ color }) => <TabIcon glyph='◈' color={color} />,
                    // ARCHON: friends moved in here from their own tab, and the
                    // pending-request badge came with them - it is the only
                    // thing in that section that is time-sensitive, and without
                    // it a request would sit unseen behind a tab nobody opens
                    // unless they went looking.
                    tabBarBadge: incoming > 0 ? incoming : undefined,
                    tabBarBadgeStyle: { backgroundColor: colors.brand, color: '#161006' }
                }}
            />
        </Tabs>
    );
}
