import React, { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import {
    avatarUrl,
    fetchNotificationPreferences,
    logout,
    setNotificationPreference,
    updateAvatar,
    type NotificationPreference
} from '../../src/api/client';
import { disconnectLobby } from '../../src/net/lobbySocket';
import { unregisterPush } from '../../src/push';
import { closeGameSocket } from '../../src/net/gameSocket';
import { useAuthStore } from '../../src/stores/authStore';
import { useSettingsStore } from '../../src/stores/settingsStore';
import { TIER_COLORS } from '../../src/membership/capabilities';
import { currentTier, currentTierName, isAdmin, isMember } from '../../src/membership/entitlements';
import { colors, radius, spacing } from '../../src/theme';
import FriendsSection from '../../src/friends/FriendsSection';
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

    const tier = currentTier(user);
    const tierName = currentTierName(user) ?? 'Free';
    const admin = isAdmin(user);
    const member = isMember(user);

    const [busy, setBusy] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [preferences, setPreferences] = useState<NotificationPreference[]>([]);
    const [error, setError] = useState<string | undefined>();
    const [notice, setNotice] = useState<string | undefined>();

    const avatar = avatarUrl(user?.avatar);

    const loadPreferences = useCallback(async () => {
        try {
            const result = await fetchNotificationPreferences();
            setPreferences(result.preferences ?? []);
        } catch {
            // The rest of the screen still works without them.
        }
    }, []);

    useEffect(() => {
        loadPreferences();
    }, [loadPreferences]);

    /**
     * Flip one channel. Written through immediately and optimistically — the
     * server stores the whole row, so the other two channels are sent as they
     * currently stand rather than left to a default.
     */
    const setChannel = async (
        preference: NotificationPreference,
        channel: 'inApp' | 'email' | 'push',
        value: boolean
    ) => {
        const next = { ...preference, [channel]: value };
        setPreferences((rows) =>
            rows.map((row) => (row.category === preference.category ? next : row))
        );

        try {
            await setNotificationPreference(preference.category, {
                inApp: next.inApp,
                email: next.email,
                push: next.push
            });
        } catch {
            // Put it back rather than showing a lie.
            setPreferences((rows) =>
                rows.map((row) => (row.category === preference.category ? preference : row))
            );
        }
    };

    const signOut = async () => {
        setBusy(true);
        try {
            closeGameSocket();
            disconnectLobby();
            // Withdraw this device first: once the session is gone the call
            // has no credentials, and a token left behind keeps delivering
            // this account's pairings to whoever signs in next.
            await unregisterPush();
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

            {/* ARCHON (N12): Archon+ status and the way in. High on the screen
                because "which tier am I on, and where do I manage it" is the
                one line a member opens Profile for — the same mistake the web
                membership page made by putting it at the bottom. */}
            <Card style={{ marginBottom: spacing.md }}>
                <View style={styles.membershipRow}>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.sectionTitle}>Archon+</Text>
                        <View style={styles.membershipStatus}>
                            <View
                                style={[
                                    styles.tierPill,
                                    { borderColor: TIER_COLORS[tier] ?? colors.border }
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.tierPillText,
                                        { color: TIER_COLORS[tier] ?? colors.textDim }
                                    ]}
                                >
                                    {admin ? `${tierName} · admin` : tierName}
                                </Text>
                            </View>
                        </View>
                    </View>
                    <Button
                        small
                        variant='secondary'
                        title={member ? 'Manage' : 'What you get'}
                        onPress={() => router.push('/membership')}
                    />
                </View>

                <View style={styles.linkRow}>
                    <Pressable onPress={() => router.push('/intelligence')} style={styles.linkItem}>
                        <Text style={styles.linkText}>Archon Intelligence</Text>
                        <Text style={styles.linkHint}>
                            Is this deck good, are you good with it, and how does it fare?
                        </Text>
                    </Pressable>
                    <Pressable
                        onPress={() => router.push('/tournament-lab')}
                        style={styles.linkItem}
                    >
                        <Text style={styles.linkText}>Tournament Lab</Text>
                        <Text style={styles.linkHint}>Which of your decks should you bring?</Text>
                    </Pressable>
                </View>
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

            {preferences.length > 0 ? (
                <Card style={{ marginBottom: spacing.md }}>
                    <Text style={styles.sectionTitle}>Notifications</Text>
                    <Text style={styles.hint}>
                        Push reaches this phone while the app is closed. Tournament pairings and
                        match times are on by default; nothing sociable is.
                    </Text>
                    {preferences.map((preference) => (
                        <View key={preference.category} style={styles.prefRow}>
                            <View style={{ flex: 1, paddingRight: spacing.md }}>
                                <Text style={styles.settingLabel}>{preference.label}</Text>
                                <Text style={styles.hint}>{preference.description}</Text>
                            </View>
                            <View style={styles.prefToggle}>
                                <Text style={styles.prefChannel}>push</Text>
                                <Switch
                                    value={preference.push}
                                    onValueChange={(value) =>
                                        setChannel(preference, 'push', value)
                                    }
                                    trackColor={{
                                        true: colors.brandDark,
                                        false: colors.surfaceHover
                                    }}
                                    thumbColor={preference.push ? colors.brand : colors.textFaint}
                                />
                            </View>
                        </View>
                    ))}
                </Card>
            ) : null}

            {/* ARCHON: friends live here now rather than in a tab of their own.
                Below the account settings and above sign-out, because it is the
                part of this screen you come back to - the settings above it are
                set once. */}
            <Text style={styles.friendsHeading}>Friends</Text>
            <FriendsSection />

            <Button
                title='Sign out'
                variant='danger'
                onPress={signOut}
                loading={busy}
                style={{ marginTop: spacing.md }}
            />

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
    friendsHeading: {
        color: colors.text,
        fontSize: 17,
        fontWeight: '800',
        marginBottom: spacing.sm,
        marginTop: spacing.xs
    },
    membershipRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md
    },
    membershipStatus: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm
    },
    tierPill: {
        alignSelf: 'flex-start',
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: spacing.md,
        paddingVertical: 2
    },
    tierPillText: {
        fontSize: 12,
        fontWeight: '700'
    },
    linkRow: {
        marginTop: spacing.md,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        paddingTop: spacing.sm,
        gap: spacing.sm
    },
    linkItem: {
        paddingVertical: 4
    },
    linkText: {
        color: colors.accent,
        fontSize: 14,
        fontWeight: '600'
    },
    linkHint: {
        color: colors.textFaint,
        fontSize: 11,
        marginTop: 1
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
    prefRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        borderTopColor: 'rgba(42, 54, 80, 0.5)',
        borderTopWidth: StyleSheet.hairlineWidth
    },
    prefToggle: {
        alignItems: 'center',
        gap: 2
    },
    prefChannel: {
        color: colors.textFaint,
        fontSize: 9,
        fontWeight: '700',
        textTransform: 'uppercase'
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
