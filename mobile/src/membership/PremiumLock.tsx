import React from 'react';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { useAuthStore } from '../stores/authStore';
import { colors, radius, spacing } from '../theme';
import { Button } from '../ui/primitives';
import { hasAnyCapability } from './entitlements';
import { upgradePrompt } from './storefront';

/**
 * ARCHON (N12): a panel that is only shown to entitled accounts.
 *
 * Two rules, both from the web version and both worth keeping:
 *
 *  - **It sells rather than scolds.** A locked panel says what the feature
 *    tells you, not "Premium Required". Somebody who cannot see a thing should
 *    at least learn what it is.
 *  - **It is a courtesy, not a control.** Every endpoint behind these panels
 *    carries `requireCapability`, so this decides what is drawn and never what
 *    is allowed. An admin passes without a special case here, because their
 *    capability list already contains everything.
 *
 * The call to action is deliberately not a purchase button: on iOS that is a
 * rejection under Guideline 3.1.1, so the button opens the Archon+ screen,
 * which itself decides per platform what it may say. See storefront.ts.
 */
export function PremiumLock(props: {
    /** Any one of these unlocks the panel — matches the per-section server gate. */
    capabilities: string[];
    /** What this panel would tell them, in one line. */
    pitch: string;
    children: React.ReactNode;
}) {
    const user = useAuthStore((state) => state.user);

    if (hasAnyCapability(user, props.capabilities)) {
        return <>{props.children}</>;
    }

    return (
        <View style={styles.locked}>
            <Text style={styles.lockGlyph}>◈</Text>
            <Text style={styles.pitch}>{props.pitch}</Text>
            <Text style={styles.prompt}>{upgradePrompt()}</Text>
            <Button
                title='Archon+'
                variant='secondary'
                small
                onPress={() => router.push('/membership')}
                style={{ marginTop: spacing.md, alignSelf: 'flex-start' }}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    locked: {
        borderWidth: 1,
        borderColor: colors.border,
        borderStyle: 'dashed',
        borderRadius: radius.md,
        backgroundColor: colors.surface,
        padding: spacing.lg
    },
    lockGlyph: {
        color: colors.brand,
        fontSize: 18,
        marginBottom: spacing.xs
    },
    pitch: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '600',
        marginBottom: spacing.xs
    },
    prompt: {
        color: colors.textDim,
        fontSize: 12,
        lineHeight: 17
    }
});

export default PremiumLock;
