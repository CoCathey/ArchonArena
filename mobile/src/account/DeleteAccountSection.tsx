import React, { useState } from 'react';
import { router } from 'expo-router';
import { Alert, Modal, StyleSheet, Text, View } from 'react-native';

import { deleteAccount } from '../api/client';
import { closeGameSocket } from '../net/gameSocket';
import { disconnectLobby } from '../net/lobbySocket';
import { unregisterPush } from '../push';
import { useAuthStore } from '../stores/authStore';
import { colors, radius, spacing } from '../theme';
import { Button, ErrorBanner, TextField } from '../ui/primitives';

/**
 * ARCHON: deleting your account, from inside the app.
 *
 * App Store Review Guideline 5.1.1(v): an app that lets people create an
 * account must let them delete it, and the deletion must be *initiated in the
 * app*. Pointing at a support address or at the website does not satisfy it,
 * which is why this exists here rather than as a link out.
 *
 * It is the same endpoint the website has used since before this app existed,
 * so the two cannot drift apart about what deletion means.
 *
 * ## What it actually does, and why the wording says so
 *
 * The server anonymises rather than drops rows: identity is erased — username,
 * email, password, avatar, the Patreon and Decks of KeyForge credentials, every
 * token — while the games this player took part in survive, because a finished
 * game belongs to their opponent as much as to them, and a tournament's
 * standings belong to the event.
 *
 * The player is told that plainly. "Delete everything" would be a promise the
 * platform cannot keep without rewriting other people's history, and a
 * confirmation dialog that overstates what it does is worse than one that is
 * specific.
 */
export function DeleteAccountSection() {
    const username = useAuthStore((state) => state.user?.username);

    const [confirming, setConfirming] = useState(false);
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const close = () => {
        setConfirming(false);
        setPassword('');
        setError(undefined);
    };

    const onDelete = async () => {
        if (!username || !password) {
            return;
        }

        setBusy(true);
        setError(undefined);

        try {
            const result = await deleteAccount(username, password);

            if (!result.success) {
                // Almost always a wrong password. Kept in the sheet so they can
                // simply retype it.
                setError(result.message ?? 'Could not delete your account.');

                return;
            }

            // Torn down in the same order as signing out, and for the same
            // reason: withdraw this device's push token while the session still
            // has credentials, or it keeps delivering this account's
            // notifications to whoever signs in next.
            closeGameSocket();
            disconnectLobby();
            await unregisterPush();
            await useAuthStore.getState().clear();

            setConfirming(false);
            router.replace('/login');

            Alert.alert(
                'Account deleted',
                'Your account has been deleted and you have been signed out.'
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not delete your account.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <View style={styles.section}>
            <Text style={styles.heading}>Delete account</Text>
            <Text style={styles.body}>
                Permanently erases your username, email address, profile picture and any linked
                Patreon or Decks of KeyForge account, and signs you out everywhere. This cannot be
                undone.
            </Text>
            <Text style={styles.caveat}>
                Games you have finished stay in your opponents&apos; match history, and past
                tournament results stay in those events — with your name removed.
            </Text>

            <Button
                title='Delete account'
                variant='danger'
                small
                onPress={() => setConfirming(true)}
                style={{ marginTop: spacing.md, alignSelf: 'flex-start' }}
            />

            {/* A password is required even though the caller is signed in: an
                unlocked phone on a table is the situation this guards. */}
            <Modal
                animationType='fade'
                onRequestClose={close}
                transparent
                visible={confirming}
            >
                <View style={styles.backdrop}>
                    <View style={styles.dialog}>
                        <Text style={styles.dialogTitle}>Delete your account?</Text>
                        <Text style={styles.body}>
                            Enter your password to confirm. This cannot be undone.
                        </Text>

                        <ErrorBanner message={error} />

                        <TextField
                            autoFocus
                            containerStyle={{ marginTop: spacing.md }}
                            label='Password'
                            onChangeText={setPassword}
                            secureTextEntry
                            textContentType='password'
                            value={password}
                        />

                        <View style={styles.dialogActions}>
                            <Button
                                title='Cancel'
                                variant='secondary'
                                small
                                disabled={busy}
                                onPress={close}
                            />
                            <Button
                                title={busy ? 'Deleting…' : 'Delete account'}
                                variant='danger'
                                small
                                disabled={!password || busy}
                                loading={busy}
                                onPress={onDelete}
                            />
                        </View>
                    </View>
                </View>
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    section: {
        borderWidth: 1,
        borderColor: colors.danger,
        borderRadius: radius.md,
        backgroundColor: 'rgba(229,72,77,0.08)',
        padding: spacing.lg,
        marginTop: spacing.md
    },
    heading: {
        color: colors.danger,
        fontSize: 15,
        fontWeight: '700',
        marginBottom: spacing.xs
    },
    body: {
        color: colors.textDim,
        fontSize: 12,
        lineHeight: 17
    },
    caveat: {
        color: colors.textFaint,
        fontSize: 11,
        lineHeight: 16,
        marginTop: spacing.sm
    },
    backdrop: {
        flex: 1,
        backgroundColor: colors.overlay,
        alignItems: 'center',
        justifyContent: 'center',
        padding: spacing.lg
    },
    dialog: {
        width: '100%',
        maxWidth: 380,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.lg,
        backgroundColor: colors.bgElevated,
        padding: spacing.lg
    },
    dialogTitle: {
        color: colors.text,
        fontSize: 16,
        fontWeight: '700',
        marginBottom: spacing.sm
    },
    dialogActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: spacing.sm,
        marginTop: spacing.md
    }
});

export default DeleteAccountSection;
