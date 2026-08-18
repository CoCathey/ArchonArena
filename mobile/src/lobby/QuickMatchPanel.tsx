import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { lobby } from '../net/lobbySocket';
import { useLobbyStore } from '../stores/lobbyStore';
import { colors, radius, spacing } from '../theme';
import { Button } from '../ui/primitives';

/**
 * ARCHON: Quick Match on the phone.
 *
 * The app's "Quick join" is the `quickJoin` flag on newgame — take the first
 * open table in this mode, or make one. That is not what the website's Find
 * Match does: `joinqueue` puts you in a rating-aware queue and the lobby pairs
 * you with somebody of similar Amber, widening the window the longer you wait.
 * Both are worth having, so this is a second control rather than a change to
 * the first.
 *
 * Everything on screen comes from the server's own `matchmaking` events —
 * including how many people are queued in this format, which is the only
 * honest thing to tell somebody who is waiting.
 */

/**
 * Formats a player can queue for. The lobby accepts six
 * (`MATCHMAKING_FORMATS`); these are the four the website offers, for the same
 * reason it offers four — Unchained and Reversal have no standing queue, so
 * offering them is offering a wait that never ends.
 */
const QUEUE_FORMATS = [
    { key: 'normal', label: 'Archon' },
    { key: 'sealed', label: 'Sealed' },
    { key: 'alliance', label: 'Alliance' },
    { key: 'adaptive-bo1', label: 'Adaptive' }
];

function formatElapsed(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;

    return minutes > 0 ? `${minutes}m ${String(rest).padStart(2, '0')}s` : `${rest}s`;
}

export default function QuickMatchPanel(props: { visible: boolean; onClose: () => void }) {
    const matchmaking = useLobbyStore((state) => state.matchmaking);
    const [format, setFormat] = useState('normal');
    const [elapsed, setElapsed] = useState(0);

    const searching = matchmaking.status === 'searching';

    useEffect(() => {
        if (!searching) {
            setElapsed(0);
            return undefined;
        }

        setElapsed(0);
        const timer = setInterval(() => setElapsed((value) => value + 1), 1000);

        return () => clearInterval(timer);
    }, [searching, matchmaking.format]);

    // Closing the sheet must not leave the account silently queued: a match
    // found while the player has moved on drags them into a game they are no
    // longer expecting. Leaving the queue is the honest close.
    const close = () => {
        if (searching) {
            lobby.leaveQueue();
        }
        props.onClose();
    };

    return (
        <Modal
            visible={props.visible}
            transparent
            animationType='fade'
            onRequestClose={close}
        >
            <View style={styles.backdrop}>
                <Pressable style={{ flex: 1 }} onPress={close} />
                <View style={styles.sheet}>
                    <Text style={styles.title}>Find a match</Text>
                    <Text style={styles.subtitle}>
                        The lobby pairs you with a player of similar Amber, widening the range
                        the longer you wait.
                    </Text>

                    <View style={styles.formatRow}>
                        {QUEUE_FORMATS.map((entry) => {
                            const active = format === entry.key;

                            return (
                                <Pressable
                                    key={entry.key}
                                    onPress={() => !searching && setFormat(entry.key)}
                                    disabled={searching}
                                    style={[
                                        styles.formatChip,
                                        active && styles.formatChipActive,
                                        searching && !active && { opacity: 0.4 }
                                    ]}
                                >
                                    <Text
                                        style={[
                                            styles.formatText,
                                            active && styles.formatTextActive
                                        ]}
                                    >
                                        {entry.label}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>

                    {matchmaking.status === 'error' && matchmaking.message ? (
                        <Text style={styles.error}>{matchmaking.message}</Text>
                    ) : null}

                    {searching ? (
                        <View style={styles.searchingBlock}>
                            <Text style={styles.searchingText}>
                                Searching · {formatElapsed(elapsed)}
                            </Text>
                            {typeof matchmaking.queued === 'number' ? (
                                <Text style={styles.queuedText}>
                                    {matchmaking.queued} player
                                    {matchmaking.queued === 1 ? '' : 's'} in this queue
                                </Text>
                            ) : null}
                            <Text style={styles.queuedText}>
                                Leave the app open — a match opens the table for you.
                            </Text>
                        </View>
                    ) : null}

                    <View style={styles.actions}>
                        <Button variant='secondary' title='Close' onPress={close} style={{ flex: 1 }} />
                        <Button
                            title={searching ? 'Stop searching' : 'Find match'}
                            onPress={() =>
                                searching ? lobby.leaveQueue() : lobby.joinQueue(format)
                            }
                            style={{ flex: 1 }}
                        />
                    </View>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: colors.overlay,
        justifyContent: 'flex-end'
    },
    sheet: {
        backgroundColor: colors.bgElevated,
        borderTopColor: colors.border,
        borderTopWidth: 1,
        borderTopLeftRadius: radius.lg,
        borderTopRightRadius: radius.lg,
        padding: spacing.lg,
        paddingBottom: spacing.xl + spacing.md
    },
    title: {
        color: colors.text,
        fontSize: 18,
        fontWeight: '800'
    },
    subtitle: {
        color: colors.textFaint,
        fontSize: 12,
        lineHeight: 17,
        marginTop: 4
    },
    formatRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm,
        marginTop: spacing.md
    },
    formatChip: {
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: spacing.md,
        paddingVertical: 7,
        backgroundColor: colors.surface
    },
    formatChipActive: {
        borderColor: colors.brand,
        backgroundColor: colors.surfaceHover
    },
    formatText: {
        color: colors.textDim,
        fontSize: 13,
        fontWeight: '600'
    },
    formatTextActive: {
        color: colors.brand
    },
    searchingBlock: {
        marginTop: spacing.md,
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        padding: spacing.md,
        gap: 3
    },
    searchingText: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700'
    },
    queuedText: {
        color: colors.textFaint,
        fontSize: 12
    },
    error: {
        color: '#ff8f93',
        fontSize: 13,
        marginTop: spacing.md
    },
    actions: {
        flexDirection: 'row',
        gap: spacing.sm,
        marginTop: spacing.lg
    }
});
