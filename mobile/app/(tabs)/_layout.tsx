import React, { useEffect } from 'react';
import { Redirect, Tabs } from 'expo-router';
import { ColorValue, Text } from 'react-native';
import { connectLobby } from '../../src/net/lobbySocket';
import { useAuthStore } from '../../src/stores/authStore';
import { colors } from '../../src/theme';

function TabIcon(props: { glyph: string; color: ColorValue }) {
    return <Text style={{ fontSize: 20, color: props.color }}>{props.glyph}</Text>;
}

export default function TabsLayout() {
    const user = useAuthStore((state) => state.user);
    const token = useAuthStore((state) => state.token);

    useEffect(() => {
        if (token) {
            connectLobby();
        }
    }, [token]);

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
