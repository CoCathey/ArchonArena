import React, { useEffect, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { blockPlayer, fetchModerationOptions, submitReport } from '../api/client';
import { colors, radius, spacing } from '../theme';
import { Button, ErrorBanner, TextField } from '../ui/primitives';

/**
 * ARCHON: report or block a player, from wherever you can see them.
 *
 * App Store Review Guideline 1.2 requires an app carrying user-generated
 * content to provide a method for reporting offensive content AND a way to
 * block abusive users. This app has lobby chat, in-game chat and free-text
 * profiles, so it is a UGC app by Apple's reckoning; both controls existed on
 * the website and neither existed here.
 *
 * Reporting and blocking are deliberately the same sheet. They are the two
 * halves of one intention - "I do not want this person near me" - and somebody
 * who has just been harassed should not have to find two different controls.
 * Blocking is immediate and theirs alone; reporting goes to a human.
 *
 * The reason list comes from the server rather than being repeated here, so the
 * phone cannot offer a reason the moderation queue does not understand.
 */
export function ReportPlayerSheet(props: {
    username: string;
    visible: boolean;
    onClose: () => void;
    /** Called after a successful block, so a list can drop the row. */
    onBlocked?: () => void;
}) {
    const { username, visible, onClose } = props;

    const [reasons, setReasons] = useState<string[]>([]);
    const [reason, setReason] = useState<string | undefined>();
    const [details, setDetails] = useState('');
    const [busy, setBusy] = useState<'report' | 'block' | undefined>();
    const [error, setError] = useState<string | undefined>();

    useEffect(() => {
        if (!visible) {
            return;
        }

        setError(undefined);
        fetchModerationOptions()
            .then((result) => setReasons(result.reasons ?? []))
            .catch(() => {
                // The sheet still blocks without them; only reporting needs a
                // reason, and it says so.
                setReasons([]);
            });
    }, [visible]);

    const close = () => {
        setReason(undefined);
        setDetails('');
        setError(undefined);
        onClose();
    };

    const onReport = async () => {
        if (!reason) {
            setError('Choose a reason.');

            return;
        }

        setBusy('report');
        setError(undefined);

        try {
            const result = await submitReport({
                targetType: 'player',
                targetUsername: username,
                reason,
                details: details.trim() || undefined
            });

            if (!result.success) {
                setError(result.message ?? 'Could not send that report.');

                return;
            }

            close();
            Alert.alert(
                'Report sent',
                'Thank you. A moderator will review this. You can also block this player so they cannot reach you in the meantime.'
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not send that report.');
        } finally {
            setBusy(undefined);
        }
    };

    const onBlock = async () => {
        setBusy('block');
        setError(undefined);

        try {
            const result = await blockPlayer(username);

            if (!result.success) {
                setError(result.message ?? 'Could not block that player.');

                return;
            }

            close();
            props.onBlocked?.();
            Alert.alert(
                'Blocked',
                `You will not see ${username} in the lobby or in chat, and they will not see you. You can undo this in Profile.`
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not block that player.');
        } finally {
            setBusy(undefined);
        }
    };

    return (
        <Modal animationType='slide' onRequestClose={close} transparent visible={visible}>
            <View style={styles.backdrop}>
                <View style={styles.sheet}>
                    <Text style={styles.title}>{username}</Text>

                    <ErrorBanner message={error} />

                    <Text style={styles.label}>Block</Text>
                    <Text style={styles.body}>
                        You will not see each other in the lobby, in chat or in each other&apos;s
                        game lists. A game already in progress is not interrupted.
                    </Text>
                    <Button
                        title={busy === 'block' ? 'Blocking…' : `Block ${username}`}
                        variant='secondary'
                        small
                        disabled={!!busy}
                        loading={busy === 'block'}
                        onPress={onBlock}
                        style={{ marginTop: spacing.sm, alignSelf: 'flex-start' }}
                    />

                    <View style={styles.divider} />

                    <Text style={styles.label}>Report to a moderator</Text>
                    <View style={styles.reasons}>
                        {reasons.map((entry) => (
                            <Pressable
                                key={entry}
                                onPress={() => setReason(entry)}
                                style={[styles.chip, reason === entry ? styles.chipOn : null]}
                            >
                                <Text
                                    style={[
                                        styles.chipText,
                                        reason === entry ? styles.chipTextOn : null
                                    ]}
                                >
                                    {entry.replace(/-/g, ' ')}
                                </Text>
                            </Pressable>
                        ))}
                        {!reasons.length ? (
                            <Text style={styles.body}>
                                Could not load the report reasons. Check your connection and try
                                again.
                            </Text>
                        ) : null}
                    </View>

                    <TextField
                        containerStyle={{ marginTop: spacing.sm }}
                        multiline
                        numberOfLines={3}
                        onChangeText={setDetails}
                        placeholder='Anything else a moderator should know (optional)'
                        value={details}
                    />

                    <View style={styles.actions}>
                        <Button title='Cancel' variant='secondary' small onPress={close} />
                        <Button
                            title={busy === 'report' ? 'Sending…' : 'Send report'}
                            variant='primary'
                            small
                            disabled={!reason || !!busy}
                            loading={busy === 'report'}
                            onPress={onReport}
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
        borderTopLeftRadius: radius.lg,
        borderTopRightRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgElevated,
        padding: spacing.lg,
        paddingBottom: spacing.xl
    },
    title: {
        color: colors.text,
        fontSize: 17,
        fontWeight: '800',
        marginBottom: spacing.md
    },
    label: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '700',
        marginBottom: 2
    },
    body: {
        color: colors.textDim,
        fontSize: 12,
        lineHeight: 17
    },
    divider: {
        height: 1,
        backgroundColor: colors.border,
        marginVertical: spacing.lg
    },
    reasons: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.xs,
        marginTop: spacing.sm
    },
    chip: {
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        borderRadius: radius.pill,
        paddingHorizontal: spacing.md,
        paddingVertical: 6
    },
    chipOn: {
        borderColor: colors.brand,
        backgroundColor: 'rgba(232,163,61,0.15)'
    },
    chipText: {
        color: colors.text,
        fontSize: 12,
        textTransform: 'capitalize'
    },
    chipTextOn: {
        color: colors.brand,
        fontWeight: '600'
    },
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: spacing.sm,
        marginTop: spacing.md
    }
});

/** A small control that opens the sheet. Drop it anywhere a name is shown. */
export function ReportPlayerButton(props: { username: string; onBlocked?: () => void }) {
    const [open, setOpen] = useState(false);

    return (
        <>
            <Pressable hitSlop={8} onPress={() => setOpen(true)}>
                <Text style={reportButtonStyles.text}>Report</Text>
            </Pressable>
            <ReportPlayerSheet
                onBlocked={props.onBlocked}
                onClose={() => setOpen(false)}
                username={props.username}
                visible={open}
            />
        </>
    );
}

const reportButtonStyles = StyleSheet.create({
    text: {
        color: colors.textFaint,
        fontSize: 11,
        textDecorationLine: 'underline'
    }
});

export default ReportPlayerSheet;
