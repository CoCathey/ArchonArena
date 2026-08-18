import React, { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    View
} from 'react-native';
import {
    fetchSessions,
    revokeSession,
    updateAccount,
    type AccountSession
} from '../src/api/account';
import { useAuthStore } from '../src/stores/authStore';
import { colors, radius, spacing } from '../src/theme';
import { Button, Card, ErrorBanner, TextField } from '../src/ui/primitives';

/**
 * ARCHON: the security page — signed-in devices and the password.
 *
 * Both were browser-only. A player who lost a phone could delete their whole
 * account from the app and could not sign that phone out of it, which is a
 * strange place for the two controls to sit relative to each other.
 *
 * Changing the password goes through the same account endpoint the website
 * uses, which replaces `settings` wholesale — so the current settings are sent
 * back with it rather than left out and silently cleared.
 */

function whenLabel(iso?: string): string {
    if (!iso) {
        return 'unknown';
    }
    const when = new Date(iso);
    if (!Number.isFinite(when.getTime())) {
        return 'unknown';
    }

    const days = Math.floor((Date.now() - when.getTime()) / 86400000);
    if (days === 0) {
        return `today at ${when.toLocaleTimeString(undefined, {
            hour: 'numeric',
            minute: '2-digit'
        })}`;
    }
    if (days === 1) {
        return 'yesterday';
    }
    if (days < 30) {
        return `${days} days ago`;
    }

    return when.toLocaleDateString();
}

export default function SecurityScreen() {
    const user = useAuthStore((state) => state.user);
    const currentTokenId = useAuthStore((state) => state.refreshToken?.id);

    const [sessions, setSessions] = useState<AccountSession[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [notice, setNotice] = useState<string | undefined>();

    const [password, setPassword] = useState('');
    const [passwordAgain, setPasswordAgain] = useState('');
    const [saving, setSaving] = useState(false);

    const [email, setEmail] = useState(String(user?.email ?? ''));

    const load = useCallback(async () => {
        setLoading(true);
        setError(undefined);
        try {
            const result = await fetchSessions();
            setSessions(result.tokens ?? []);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load your sessions');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const confirmRevoke = (session: AccountSession) => {
        const isThisDevice = session.id === currentTokenId;

        Alert.alert(
            isThisDevice ? 'Sign this device out' : 'Sign that device out',
            isThisDevice
                ? 'This is the session this app is using. You will have to sign in again.'
                : `Remove the session last used ${whenLabel(session.lastUsed)}?`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Sign out',
                    style: 'destructive',
                    onPress: async () => {
                        setError(undefined);
                        try {
                            const result = await revokeSession(session.id);
                            if (!result.success) {
                                setError(result.message ?? 'Could not remove that session');
                                return;
                            }
                            setNotice('Session removed');
                            await load();
                        } catch (err) {
                            setError(
                                err instanceof Error
                                    ? err.message
                                    : 'Could not remove that session'
                            );
                        }
                    }
                }
            ]
        );
    };

    const savePassword = async () => {
        setError(undefined);
        setNotice(undefined);

        if (password.length < 6) {
            setError('Passwords must be at least 6 characters.');
            return;
        }
        if (password !== passwordAgain) {
            setError('Those passwords do not match.');
            return;
        }

        setSaving(true);
        try {
            const result = await updateAccount({
                password,
                email: email.trim() || undefined,
                // Sent back unchanged: the server replaces the settings object
                // with whatever it receives.
                settings: (user?.settings as Record<string, unknown>) ?? {}
            });
            if (!result.success) {
                setError(result.message ?? 'Could not change your password');
                return;
            }
            setPassword('');
            setPasswordAgain('');
            setNotice('Password changed');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not change your password');
        } finally {
            setSaving(false);
        }
    };

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <ScrollView
                contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
                keyboardShouldPersistTaps='handled'
            >
                <ErrorBanner message={error} />
                {notice ? <Text style={styles.notice}>{notice}</Text> : null}

                <Card style={{ marginBottom: spacing.md }}>
                    <Text style={styles.sectionTitle}>Change password</Text>
                    <Text style={styles.hint}>
                        Changing it does not sign your other devices out — do that below.
                    </Text>
                    <TextField
                        label='New password'
                        value={password}
                        onChangeText={setPassword}
                        secureTextEntry
                        textContentType='newPassword'
                        containerStyle={{ marginTop: spacing.sm }}
                    />
                    <TextField
                        label='New password again'
                        value={passwordAgain}
                        onChangeText={setPasswordAgain}
                        secureTextEntry
                        textContentType='newPassword'
                    />
                    <Button
                        title='Change password'
                        loading={saving}
                        disabled={!password || !passwordAgain}
                        onPress={savePassword}
                    />
                </Card>

                <Card style={{ marginBottom: spacing.md }}>
                    <Text style={styles.sectionTitle}>Email</Text>
                    <Text style={styles.hint}>
                        Where password resets and anything you have asked to be mailed about go.
                    </Text>
                    <TextField
                        value={email}
                        onChangeText={setEmail}
                        keyboardType='email-address'
                        autoComplete='email'
                        containerStyle={{ marginTop: spacing.sm }}
                    />
                    <Button
                        variant='secondary'
                        title='Save email'
                        loading={saving}
                        disabled={!email.trim() || email.trim() === String(user?.email ?? '')}
                        onPress={async () => {
                            setError(undefined);
                            setNotice(undefined);
                            setSaving(true);
                            try {
                                const result = await updateAccount({
                                    email: email.trim(),
                                    settings: (user?.settings as Record<string, unknown>) ?? {}
                                });
                                setNotice(
                                    result.success
                                        ? 'Email saved'
                                        : result.message ?? 'Could not save that email'
                                );
                                if (!result.success) {
                                    setError(result.message ?? 'Could not save that email');
                                }
                            } catch (err) {
                                setError(
                                    err instanceof Error ? err.message : 'Could not save that email'
                                );
                            } finally {
                                setSaving(false);
                            }
                        }}
                    />
                </Card>

                <Card>
                    <Text style={styles.sectionTitle}>Signed-in devices</Text>
                    <Text style={styles.hint}>
                        Every browser and phone holding a live session. Removing one signs that
                        device out.
                    </Text>

                    {loading && sessions.length === 0 ? (
                        <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.md }} />
                    ) : null}

                    {sessions.map((session) => {
                        const isThisDevice = session.id === currentTokenId;

                        return (
                            <View key={session.id} style={styles.sessionRow}>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.sessionIp}>
                                        {session.ip ?? 'unknown address'}
                                        {isThisDevice ? ' · this device' : ''}
                                    </Text>
                                    <Text style={styles.sessionMeta}>
                                        Last used {whenLabel(session.lastUsed)}
                                    </Text>
                                </View>
                                <Button
                                    small
                                    variant='secondary'
                                    title='Sign out'
                                    onPress={() => confirmRevoke(session)}
                                />
                            </View>
                        );
                    })}

                    {!loading && sessions.length === 0 ? (
                        <Text style={styles.hint}>No other sessions.</Text>
                    ) : null}
                </Card>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    sectionTitle: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
        marginBottom: 4
    },
    hint: {
        color: colors.textFaint,
        fontSize: 12,
        lineHeight: 17,
        marginTop: 2
    },
    notice: {
        color: '#7ed494',
        fontSize: 13,
        marginBottom: spacing.md
    },
    sessionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.sm,
        borderTopColor: colors.border,
        borderTopWidth: StyleSheet.hairlineWidth,
        marginTop: spacing.sm
    },
    sessionIp: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '600'
    },
    sessionMeta: {
        color: colors.textFaint,
        fontSize: 11,
        marginTop: 2
    },
    codeBox: {
        borderRadius: radius.md
    }
});
