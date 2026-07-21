import React, { useState } from 'react';
import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { logout } from '../../src/api/client';
import { disconnectLobby } from '../../src/net/lobbySocket';
import { closeGameSocket } from '../../src/net/gameSocket';
import { useAuthStore } from '../../src/stores/authStore';
import { useSettingsStore } from '../../src/stores/settingsStore';
import { colors, spacing } from '../../src/theme';
import { Button, Card, TextField } from '../../src/ui/primitives';

export default function ProfileScreen() {
    const user = useAuthStore((state) => state.user);
    const serverUrl = useSettingsStore((state) => state.serverUrl);
    const setServerUrl = useSettingsStore((state) => state.setServerUrl);
    const [serverInput, setServerInput] = useState(serverUrl);
    const [saved, setSaved] = useState(false);
    const [busy, setBusy] = useState(false);

    const signOut = async () => {
        setBusy(true);
        try {
            closeGameSocket();
            disconnectLobby();
            await logout();
            router.replace('/login');
        } finally {
            setBusy(false);
        }
    };

    const saveServer = async () => {
        await setServerUrl(serverInput);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
    };

    return (
        <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.md }}>
            <Card style={{ marginBottom: spacing.md }}>
                <Text style={styles.username}>{user?.username}</Text>
                {user?.email ? <Text style={styles.email}>{String(user.email)}</Text> : null}
            </Card>

            <Card style={{ marginBottom: spacing.md }}>
                <Text style={styles.sectionTitle}>Server</Text>
                <Text style={styles.hint}>
                    The lobby server this app connects to. Change it to play on a self-hosted
                    Archon Arena instance, then sign in again.
                </Text>
                <TextField
                    value={serverInput}
                    onChangeText={setServerInput}
                    placeholder='https://archonarena.com'
                    keyboardType='url'
                />
                <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                    <Button small variant='secondary' title='Save' onPress={saveServer} />
                    {saved ? <Text style={styles.savedText}>Saved</Text> : null}
                </View>
            </Card>

            <Button title='Sign out' variant='danger' onPress={signOut} loading={busy} />

            <Text style={styles.footer}>
                Archon Arena mobile · KeyForge is a trademark of Fantasy Flight Games / Ghost
                Galaxy. This fan-made app is not affiliated with them.
            </Text>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    username: {
        color: colors.text,
        fontSize: 22,
        fontWeight: '800'
    },
    email: {
        color: colors.textDim,
        fontSize: 13,
        marginTop: 4
    },
    sectionTitle: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
        marginBottom: 6
    },
    hint: {
        color: colors.textFaint,
        fontSize: 12,
        marginBottom: spacing.md,
        lineHeight: 17
    },
    savedText: {
        color: '#7ed494',
        fontSize: 13,
        alignSelf: 'center'
    },
    footer: {
        color: colors.textFaint,
        fontSize: 11,
        lineHeight: 16,
        marginTop: spacing.xl,
        textAlign: 'center'
    }
});
