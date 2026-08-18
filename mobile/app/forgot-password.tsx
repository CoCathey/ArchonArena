import React, { useState } from 'react';
import { router } from 'expo-router';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { requestPasswordReset } from '../src/api/account';
import { colors, spacing } from '../src/theme';
import { Button, Card, ErrorBanner, TextField } from '../src/ui/primitives';

/**
 * ARCHON: asking for a password reset from the app.
 *
 * The login screen offered no way out of a forgotten password, so the only
 * route back into an account was to find a browser. The reset link itself
 * still lands on the website — the app has no reset screen and does not need
 * one, since somebody following a mail link is already in a browser.
 *
 * The server never says whether an account exists, and neither does this: the
 * confirmation is the same either way.
 */
export default function ForgotPasswordScreen() {
    const [username, setUsername] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [sent, setSent] = useState(false);

    const submit = async () => {
        const wanted = username.trim();
        if (!wanted) {
            return;
        }

        setBusy(true);
        setError(undefined);
        try {
            const result = await requestPasswordReset(wanted);
            if (result.success === false && result.message) {
                setError(result.message);
                return;
            }
            setSent(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not send that request');
        } finally {
            setBusy(false);
        }
    };

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <ScrollView
                contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.xl }}
                keyboardShouldPersistTaps='handled'
            >
                <Card>
                    <Text style={styles.title}>Reset your password</Text>

                    {sent ? (
                        <>
                            <Text style={styles.body}>
                                If that account exists, a reset link is on its way to the address
                                on it. The link opens in your browser.
                            </Text>
                            <Button
                                title='Back to sign in'
                                onPress={() => router.back()}
                                style={{ marginTop: spacing.lg }}
                            />
                        </>
                    ) : (
                        <>
                            <Text style={styles.body}>
                                Enter your username and we will mail a reset link to the address on
                                the account.
                            </Text>
                            <ErrorBanner message={error} />
                            <TextField
                                label='Username'
                                value={username}
                                onChangeText={setUsername}
                                autoCapitalize='none'
                                autoComplete='username'
                                onSubmitEditing={submit}
                                containerStyle={{ marginTop: spacing.md }}
                            />
                            <Button
                                title='Send reset link'
                                loading={busy}
                                disabled={!username.trim()}
                                onPress={submit}
                            />
                            <Button
                                variant='ghost'
                                title='Back to sign in'
                                onPress={() => router.back()}
                                style={{ marginTop: spacing.sm }}
                            />
                        </>
                    )}
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
    title: {
        color: colors.text,
        fontSize: 20,
        fontWeight: '800'
    },
    body: {
        color: colors.textDim,
        fontSize: 14,
        lineHeight: 20,
        marginTop: spacing.sm
    }
});
