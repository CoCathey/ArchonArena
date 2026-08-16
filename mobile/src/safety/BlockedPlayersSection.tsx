import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { fetchBlockList, unblockPlayer } from '../api/client';
import { colors, spacing } from '../theme';
import { Button, ErrorBanner } from '../ui/primitives';

/**
 * ARCHON: the other half of blocking — undoing it.
 *
 * App Store Review Guideline 1.2 asks for the ability to block abusive users.
 * A block you cannot see or lift is a worse control than no block at all: people
 * block in anger, and an app that offers no way back turns a moment's decision
 * into a permanent one they cannot even inspect.
 *
 * Loaded lazily and quiet when empty — most accounts have blocked nobody, and a
 * heading over an empty list is noise on a settings screen.
 */
export function BlockedPlayersSection() {
    const [blocked, setBlocked] = useState<string[]>([]);
    const [busy, setBusy] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [loaded, setLoaded] = useState(false);

    const load = useCallback(async () => {
        try {
            const result = await fetchBlockList();

            setBlocked(result.blockList ?? []);
        } catch {
            // A settings screen that still works is better than one that errors
            // over a list most people never populate.
            setBlocked([]);
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const unblock = async (username: string) => {
        setBusy(username);
        setError(undefined);

        try {
            const result = await unblockPlayer(username);

            if (!result.success) {
                setError(result.message ?? 'Could not unblock that player.');

                return;
            }

            setBlocked((current) => current.filter((entry) => entry !== username));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not unblock that player.');
        } finally {
            setBusy(undefined);
        }
    };

    if (!loaded || !blocked.length) {
        return null;
    }

    return (
        <View style={{ marginTop: spacing.md }}>
            <Text style={styles.heading}>Blocked players</Text>
            <Text style={styles.hint}>
                You do not see their chat, games or presence, and they do not see yours.
            </Text>

            <ErrorBanner message={error} />

            {blocked.map((username) => (
                <View key={username} style={styles.row}>
                    <Text style={styles.name}>{username}</Text>
                    <Button
                        title='Unblock'
                        variant='secondary'
                        small
                        disabled={busy === username}
                        loading={busy === username}
                        onPress={() => unblock(username)}
                    />
                </View>
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    heading: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
        marginBottom: 2
    },
    hint: {
        color: colors.textFaint,
        fontSize: 11,
        lineHeight: 16,
        marginBottom: spacing.sm
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 8,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.border
    },
    name: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '600'
    }
});

export default BlockedPlayersSection;
