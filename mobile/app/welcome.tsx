import React, { useState } from 'react';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import {
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View
} from 'react-native';
import { avatarUrl, importDeck, parseDeckUuid, updateAvatar } from '../src/api/client';
import { saveLocation } from '../src/api/account';
import { markOnboarded } from '../src/api/play';
import { useAuthStore } from '../src/stores/authStore';
import { colors, radius, spacing } from '../src/theme';
import { Button, Card, ErrorBanner, TextField } from '../src/ui/primitives';

/**
 * ARCHON: the welcome flow, on the phone.
 *
 * The website walks a new account through five steps; the app dropped somebody
 * straight into an empty game list, where the two things that make the app
 * useful — a deck and somewhere to play — are both several taps away and
 * neither is suggested.
 *
 * Same five steps, same server calls, and the same rule that matters most:
 * every one of them is skippable. `markOnboarded` is called on finish AND on
 * skip, because a wizard that reappears until it is completed is a wizard
 * people learn to resent.
 */

const STEPS = [
    'Where are you from?',
    'Import your decks',
    'Add a picture',
    'Play your first game'
];

export default function WelcomeScreen() {
    const user = useAuthStore((state) => state.user);

    const [step, setStep] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const [country, setCountry] = useState('');
    const [state, setState] = useState('');
    const [deckLink, setDeckLink] = useState('');
    const [deckNotice, setDeckNotice] = useState<string | undefined>();
    const avatar = avatarUrl(user?.avatar);

    const finish = async () => {
        setBusy(true);
        try {
            await markOnboarded();
        } catch {
            // Not worth blocking on: the worst case is seeing this again.
        } finally {
            setBusy(false);
            router.replace('/(tabs)');
        }
    };

    const next = () => setStep((current) => Math.min(STEPS.length - 1, current + 1));

    const saveWhere = async () => {
        setError(undefined);
        if (!country.trim() && !state.trim()) {
            next();

            return;
        }

        setBusy(true);
        try {
            await saveLocation({
                country: country.trim().toUpperCase(),
                state: state.trim()
            });
            next();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not save that');
        } finally {
            setBusy(false);
        }
    };

    const importFirstDeck = async () => {
        const uuid = parseDeckUuid(deckLink);
        if (!uuid) {
            setError('Paste a Master Vault deck link or deck id');

            return;
        }

        setBusy(true);
        setError(undefined);
        setDeckNotice(undefined);
        try {
            const result = await importDeck(uuid);
            if (!result.success) {
                setError(result.message ?? 'Import failed');

                return;
            }
            setDeckLink('');
            setDeckNotice('Deck imported');
            next();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Import failed');
        } finally {
            setBusy(false);
        }
    };

    const pickAvatar = async () => {
        setError(undefined);
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
            setError('Photo access is off for Archon Arena. You can add a picture later.');

            return;
        }

        const picked = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.7,
            base64: true
        });

        if (picked.canceled || !picked.assets?.[0]?.base64) {
            return;
        }

        setBusy(true);
        try {
            const result = await updateAvatar(picked.assets[0].base64);
            if (!result.success) {
                setError(result.message ?? 'Could not save that picture');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not save that picture');
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
                contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
                keyboardShouldPersistTaps='handled'
            >
                <Text style={styles.title}>Welcome, {user?.username}</Text>
                <Text style={styles.subtitle}>
                    Four quick things. All of them optional — skip any you like.
                </Text>

                <View style={styles.dots}>
                    {STEPS.map((title, index) => (
                        <Pressable
                            key={title}
                            onPress={() => setStep(index)}
                            hitSlop={8}
                            accessibilityLabel={title}
                        >
                            <View
                                style={[
                                    styles.dot,
                                    index === step && styles.dotActive,
                                    index < step && styles.dotDone
                                ]}
                            />
                        </Pressable>
                    ))}
                </View>

                <ErrorBanner message={error} />

                <Card>
                    <Text style={styles.stepTitle}>
                        {step + 1}/{STEPS.length} · {STEPS[step]}
                    </Text>

                    {step === 0 ? (
                        <>
                            <Text style={styles.body}>
                                Optional and public. It puts you on the regional leaderboards and
                                helps people near you find a game.
                            </Text>
                            <TextField
                                label='Country'
                                value={country}
                                onChangeText={setCountry}
                                placeholder='e.g. GB'
                                autoCapitalize='characters'
                                maxLength={2}
                                containerStyle={{ marginTop: spacing.md }}
                            />
                            <TextField
                                label='State or region'
                                value={state}
                                onChangeText={setState}
                                autoCapitalize='words'
                            />
                            <Button title='Continue' loading={busy} onPress={saveWhere} />
                        </>
                    ) : null}

                    {step === 1 ? (
                        <>
                            <Text style={styles.body}>
                                Paste a Master Vault deck link to bring one deck in now. You can
                                import a whole collection later from the Decks tab.
                            </Text>
                            <TextField
                                value={deckLink}
                                onChangeText={setDeckLink}
                                placeholder='Master Vault link or deck id'
                                containerStyle={{ marginTop: spacing.md }}
                            />
                            {deckNotice ? (
                                <Text style={styles.notice}>{deckNotice}</Text>
                            ) : null}
                            <Button
                                title='Import deck'
                                loading={busy}
                                disabled={!deckLink.trim()}
                                onPress={importFirstDeck}
                            />
                        </>
                    ) : null}

                    {step === 2 ? (
                        <>
                            <Text style={styles.body}>
                                It shows next to your name in the lobby and on your profile.
                            </Text>
                            <View style={styles.avatarRow}>
                                {avatar ? (
                                    <Image source={{ uri: avatar }} style={styles.avatar} />
                                ) : (
                                    <View style={[styles.avatar, styles.avatarEmpty]}>
                                        <Text style={styles.avatarInitial}>
                                            {(user?.username ?? '?').slice(0, 1).toUpperCase()}
                                        </Text>
                                    </View>
                                )}
                                <Button
                                    variant='secondary'
                                    title={avatar ? 'Change picture' : 'Choose a picture'}
                                    loading={busy}
                                    onPress={pickAvatar}
                                />
                            </View>
                            <Button title='Continue' onPress={next} />
                        </>
                    ) : null}

                    {step === 3 ? (
                        <>
                            <Text style={styles.body}>
                                That is everything. Find Match pairs you with somebody of similar
                                Amber; the practice tables let you play the house bot first if you
                                would rather warm up.
                            </Text>
                            <Button title='Start playing' loading={busy} onPress={finish} />
                        </>
                    ) : null}
                </Card>

                <Pressable onPress={finish} hitSlop={8} style={styles.skip}>
                    <Text style={styles.skipText}>Skip all of this</Text>
                </Pressable>
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
        fontSize: 24,
        fontWeight: '900',
        textAlign: 'center'
    },
    subtitle: {
        color: colors.textFaint,
        fontSize: 13,
        textAlign: 'center',
        marginTop: 4
    },
    dots: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: spacing.sm,
        marginVertical: spacing.lg
    },
    dot: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: colors.border
    },
    dotActive: {
        backgroundColor: colors.brand
    },
    dotDone: {
        backgroundColor: colors.brandDark
    },
    stepTitle: {
        color: colors.text,
        fontSize: 16,
        fontWeight: '800'
    },
    body: {
        color: colors.textDim,
        fontSize: 14,
        lineHeight: 20,
        marginTop: spacing.sm
    },
    notice: {
        color: '#7ed494',
        fontSize: 13,
        marginBottom: spacing.sm
    },
    avatarRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        marginVertical: spacing.lg
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
    skip: {
        alignSelf: 'center',
        marginTop: spacing.lg,
        padding: spacing.sm
    },
    skipText: {
        color: colors.textFaint,
        fontSize: 13,
        fontWeight: '600'
    }
});
