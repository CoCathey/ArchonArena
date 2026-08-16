import React, { useRef, useState } from 'react';
import { router } from 'expo-router';
import {
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { login } from '../src/api/client';
import { connectLobby } from '../src/net/lobbySocket';
import { colors, spacing } from '../src/theme';
import { Button, ErrorBanner, TextField } from '../src/ui/primitives';

export default function LoginScreen() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | undefined>();
    const [busy, setBusy] = useState(false);
    const passwordRef = useRef<TextInput>(null);
    const scrollRef = useRef<ScrollView>(null);

    const fail = (message: string) => {
        setError(message);
        scrollRef.current?.scrollTo({ y: 0, animated: true });
    };

    const submit = async () => {
        setError(undefined);
        if (!username.trim() || !password) {
            fail('Enter your username and password');
            return;
        }
        setBusy(true);
        try {
            const result = await login(username.trim(), password);
            if (!result.success) {
                fail(result.message ?? 'Login failed');
                return;
            }
            await connectLobby();
            router.replace('/(tabs)');
        } catch (err) {
            fail(err instanceof Error ? err.message : 'Login failed');
        } finally {
            setBusy(false);
        }
    };

    return (
        <SafeAreaView style={styles.safe}>
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                style={{ flex: 1 }}
            >
                <ScrollView
                    ref={scrollRef}
                    contentContainerStyle={styles.container}
                    keyboardShouldPersistTaps='handled'
                >
                    <View style={styles.header}>
                        <Text style={styles.logo}>ARCHON ARENA</Text>
                        <Text style={styles.tagline}>Play KeyForge anywhere</Text>
                        {/* ARCHON: the trademark attribution belongs on the
                            first screen, not at the foot of the fourth tab
                            behind the sign-in wall. A reviewer meets the
                            KeyForge name here, in the tagline directly above,
                            and meets the card art in the first game; the
                            disclaimer has to be where they already are. */}
                        <Text style={styles.disclaimer}>
                            A fan-run, open-source platform. KeyForge is a trademark of Fantasy
                            Flight Games / Ghost Galaxy. Not affiliated with, endorsed by or
                            sponsored by them.
                        </Text>
                    </View>

                    <ErrorBanner message={error} />

                    <TextField
                        label='Username'
                        value={username}
                        onChangeText={setUsername}
                        placeholder='Your username'
                        textContentType='username'
                        returnKeyType='next'
                        onSubmitEditing={() => passwordRef.current?.focus()}
                        submitBehavior='submit'
                    />
                    <TextField
                        ref={passwordRef}
                        label='Password'
                        value={password}
                        onChangeText={setPassword}
                        placeholder='Your password'
                        secureTextEntry
                        textContentType='password'
                        returnKeyType='go'
                        onSubmitEditing={submit}
                    />

                    <Button title='Sign in' onPress={submit} loading={busy} />

                    <View style={styles.links}>
                        <Text style={styles.linkText} onPress={() => router.push('/register')}>
                            Create an account
                        </Text>
                    </View>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safe: {
        flex: 1,
        backgroundColor: colors.bg
    },
    container: {
        flexGrow: 1,
        justifyContent: 'center',
        padding: spacing.xl
    },
    header: {
        alignItems: 'center',
        marginBottom: 40
    },
    logo: {
        color: colors.brand,
        fontSize: 30,
        fontWeight: '900',
        letterSpacing: 4
    },
    disclaimer: {
        color: colors.textFaint,
        fontSize: 10,
        lineHeight: 14,
        textAlign: 'center',
        marginTop: 10,
        paddingHorizontal: 8
    },
    tagline: {
        color: colors.textDim,
        fontSize: 14,
        marginTop: 8
    },
    links: {
        flexDirection: 'row',
        justifyContent: 'center',
        marginTop: spacing.lg
    },
    linkText: {
        color: colors.accent,
        fontSize: 14,
        fontWeight: '600'
    }
});
