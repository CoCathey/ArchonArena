import React, { useEffect } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '../src/theme';

/**
 * ARCHON: a landing pad for `archonarena://patreon`.
 *
 * The OAuth callback is normally caught by the auth session that opened the
 * browser, and this screen never appears. But the scheme is registered with the
 * OS, so the URL can arrive when nothing is waiting for it: a cold start from
 * the link, a stale link tapped out of a browser history days later, or the
 * session having already been torn down.
 *
 * Without a route for it, expo-router answers a registered deep link with its
 * "unmatched route" screen — a developer error page, in a shipped build, on a
 * URL the app itself told the OS it handles. That is a Guideline 2.1
 * observation waiting to happen.
 *
 * It deliberately does NOT try to complete the link. The code needs the signed
 * state token from the attempt that started it, which lives in the memory of a
 * flow that is no longer running; redeeming it here is impossible, and pretending
 * otherwise would spend a single-use code for nothing.
 */
export default function PatreonCallbackScreen() {
    useEffect(() => {
        // Long enough to read, short enough not to feel stuck.
        const timer = setTimeout(() => router.replace('/membership'), 1800);

        return () => clearTimeout(timer);
    }, []);

    return (
        <View style={styles.container}>
            <ActivityIndicator color={colors.brand} size='large' />
            <Text style={styles.title}>Finishing up…</Text>
            <Text style={styles.body}>
                Taking you back to Archon+. If your Patreon account is not connected yet, tap
                Connect Patreon there to try again.
            </Text>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.bg,
        padding: spacing.xl
    },
    title: {
        color: colors.text,
        fontSize: 16,
        fontWeight: '700',
        marginTop: spacing.lg
    },
    body: {
        color: colors.textDim,
        fontSize: 13,
        lineHeight: 19,
        textAlign: 'center',
        marginTop: spacing.sm
    }
});
