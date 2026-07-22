import React, { useState } from 'react';
import { router } from 'expo-router';
import {
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    Text
} from 'react-native';
import { register } from '../src/api/client';
import { colors, spacing } from '../src/theme';
import { Button, ErrorBanner, TextField } from '../src/ui/primitives';

export default function RegisterScreen() {
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState<string | undefined>();
    const [notice, setNotice] = useState<string | undefined>();
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        setError(undefined);
        setNotice(undefined);

        if (username.trim().length < 3 || username.trim().length > 15) {
            setError('Username must be 3-15 characters');
            return;
        }
        if (!/^[A-Za-z0-9_-]+$/.test(username.trim())) {
            setError('Usernames may only use a-z, 0-9, _ and -');
            return;
        }
        if (!email.includes('@')) {
            setError('Enter a valid email address');
            return;
        }
        if (password.length < 6) {
            setError('Password must be at least 6 characters');
            return;
        }
        if (password !== confirm) {
            setError('Passwords do not match');
            return;
        }

        setBusy(true);
        try {
            const result = await register(username.trim(), email.trim(), password);
            if (!result.success) {
                setError(result.message ?? 'Registration failed');
                return;
            }
            setNotice(
                'Account created. If email activation is enabled you will receive a message; otherwise you can sign in now.'
            );
            setTimeout(() => router.back(), 2500);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Registration failed');
        } finally {
            setBusy(false);
        }
    };

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.safe}
        >
            <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps='handled'>
                <ErrorBanner message={error} />
                {notice ? <Text style={styles.notice}>{notice}</Text> : null}

                <TextField
                    label='Username'
                    value={username}
                    onChangeText={setUsername}
                    placeholder='3-15 characters'
                />
                <TextField
                    label='Email'
                    value={email}
                    onChangeText={setEmail}
                    placeholder='you@example.com'
                    keyboardType='email-address'
                />
                <TextField
                    label='Password'
                    value={password}
                    onChangeText={setPassword}
                    placeholder='At least 6 characters'
                    secureTextEntry
                />
                <TextField
                    label='Confirm password'
                    value={confirm}
                    onChangeText={setConfirm}
                    placeholder='Repeat your password'
                    secureTextEntry
                    onSubmitEditing={submit}
                />

                <Button title='Create account' onPress={submit} loading={busy} />
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    safe: {
        flex: 1,
        backgroundColor: colors.bg
    },
    container: {
        padding: spacing.xl
    },
    notice: {
        color: '#7ed494',
        fontSize: 14,
        marginBottom: spacing.md
    }
});
