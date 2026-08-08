import React, { useState } from 'react';
import { router } from 'expo-router';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { avatarUrl, logout, updateAvatar } from '../../src/api/client';
import { disconnectLobby } from '../../src/net/lobbySocket';
import { closeGameSocket } from '../../src/net/gameSocket';
import { useAuthStore } from '../../src/stores/authStore';
import { useSettingsStore } from '../../src/stores/settingsStore';
import { colors, spacing } from '../../src/theme';
import { Button, Card, ErrorBanner } from '../../src/ui/primitives';

function SettingRow(props: {
    label: string;
    hint?: string;
    value: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <View style={styles.settingRow}>
            <View style={{ flex: 1, paddingRight: spacing.md }}>
                <Text style={styles.settingLabel}>{props.label}</Text>
                {props.hint ? <Text style={styles.hint}>{props.hint}</Text> : null}
            </View>
            <Switch
                value={props.value}
                onValueChange={props.onChange}
                trackColor={{ true: colors.brandDark, false: colors.surfaceHover }}
                thumbColor={props.value ? colors.brand : colors.textFaint}
            />
        </View>
    );
}

export default function ProfileScreen() {
    const user = useAuthStore((state) => state.user);
    const groupHandByHouse = useSettingsStore((state) => state.groupHandByHouse);
    const setGroupHandByHouse = useSettingsStore((state) => state.setGroupHandByHouse);

    const [busy, setBusy] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [notice, setNotice] = useState<string | undefined>();

    const avatar = avatarUrl(user?.avatar);

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

    const pickAvatar = async () => {
        setError(undefined);
        setNotice(undefined);

        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
            setError('Photo access is needed to choose a picture. Enable it in Settings.');
            return;
        }

        const picked = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsEditing: true,
            aspect: [1, 1],
            // The server stores a small square, so there is no point sending a
            // 12-megapixel original over a phone connection.
            quality: 0.8,
            base64: true
        });

        if (picked.canceled || !picked.assets?.[0]) {
            return;
        }

        const asset = picked.assets[0];
        if (!asset.base64) {
            setError('Could not read that image. Try another one.');
            return;
        }

        setUploading(true);
        try {
            const result = await updateAvatar(asset.base64);
            if (!result.success) {
                setError(result.message ?? 'Could not update your picture');
                return;
            }
            setNotice('Profile picture updated');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not update your picture');
        } finally {
            setUploading(false);
        }
    };

    return (
        <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.md }}>
            <Card style={{ marginBottom: spacing.md }}>
                <View style={styles.identityRow}>
                    <Pressable
                        onPress={pickAvatar}
                        disabled={uploading}
                        style={({ pressed }) => [styles.avatarWrap, pressed && { opacity: 0.7 }]}
                        accessibilityRole='button'
                        accessibilityLabel='Change profile picture'
                    >
                        {avatar ? (
                            <Image
                                source={{ uri: avatar }}
                                style={styles.avatar}
                                contentFit='cover'
                                // The file name changes on every upload, so a
                                // fresh URL is always a fresh image.
                                cachePolicy='disk'
                            />
                        ) : (
                            <View style={[styles.avatar, styles.avatarEmpty]}>
                                <Text style={styles.avatarInitial}>
                                    {(user?.username ?? '?').charAt(0).toUpperCase()}
                                </Text>
                            </View>
                        )}
                        <Text style={styles.avatarHint}>
                            {uploading ? 'Uploading…' : 'Change'}
                        </Text>
                    </Pressable>

                    <View style={{ flex: 1 }}>
                        <Text style={styles.username}>{user?.username}</Text>
                        {user?.email ? (
                            <Text style={styles.email}>{String(user.email)}</Text>
                        ) : null}
                        <Button
                            small
                            variant='secondary'
                            title='Change picture'
                            onPress={pickAvatar}
                            loading={uploading}
                            style={{ alignSelf: 'flex-start', marginTop: spacing.sm }}
                        />
                    </View>
                </View>
                <ErrorBanner message={error} />
                {notice ? <Text style={styles.notice}>{notice}</Text> : null}
            </Card>

            <Card style={{ marginBottom: spacing.md }}>
                <Text style={styles.sectionTitle}>Game</Text>
                <SettingRow
                    label='Group hand by house'
                    hint='Sorts your hand into house order instead of draw order.'
                    value={groupHandByHouse}
                    onChange={setGroupHandByHouse}
                />
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
    identityRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg
    },
    avatarWrap: {
        alignItems: 'center',
        gap: 4
    },
    avatar: {
        width: 72,
        height: 72,
        borderRadius: 36,
        borderWidth: 2,
        borderColor: colors.border,
        backgroundColor: colors.bgElevated
    },
    avatarEmpty: {
        alignItems: 'center',
        justifyContent: 'center'
    },
    avatarInitial: {
        color: colors.textDim,
        fontSize: 28,
        fontWeight: '800'
    },
    avatarHint: {
        color: colors.accent,
        fontSize: 11,
        fontWeight: '700'
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
    settingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 6
    },
    settingLabel: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '600'
    },
    hint: {
        color: colors.textFaint,
        fontSize: 12,
        marginTop: 2,
        lineHeight: 17
    },
    notice: {
        color: '#7ed494',
        fontSize: 13,
        marginTop: spacing.md
    },
    footer: {
        color: colors.textFaint,
        fontSize: 11,
        lineHeight: 16,
        marginTop: spacing.xl,
        textAlign: 'center'
    }
});
