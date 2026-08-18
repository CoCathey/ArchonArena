import React, { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    View
} from 'react-native';
import {
    cancelInPersonGame,
    createInPersonGame,
    escalateInPersonGame,
    fetchInPersonGames,
    reportInPersonGame,
    withdrawInPersonReport,
    type InPersonGame
} from '../src/api/play';
import { GAME_FORMATS } from '../src/game/gameFormats';
import { useAuthStore } from '../src/stores/authStore';
import { colors, radius, spacing } from '../src/theme';
import { Button, Card, EmptyState, ErrorBanner, TextField } from '../src/ui/primitives';

/**
 * ARCHON (N13): recording a game played across a table.
 *
 * Both players report the result independently; the game confirms only when
 * the two reports agree, and a mismatch marks it disputed rather than trusting
 * whoever typed first. A confirmed game counts toward Amber exactly like an
 * online one, which is why the server sends `rated` with the list — a player
 * ought to know that before they report, not after.
 *
 * This is the surface that most obviously belongs on a phone rather than in a
 * browser: it is used at the table, with the cards still out.
 */

function statusLabel(game: InPersonGame): { text: string; color: string } {
    if (game.status === 'confirmed') {
        return { text: 'Confirmed', color: '#7ed494' };
    }
    if (game.status === 'disputed') {
        return { text: 'Reports disagree', color: colors.danger };
    }
    if (game.status === 'cancelled') {
        return { text: 'Cancelled', color: colors.textFaint };
    }
    if (game.awaitingMyReport) {
        return { text: 'Your report needed', color: colors.brand };
    }

    return { text: 'Waiting on them', color: colors.textDim };
}

function GameCard(props: {
    game: InPersonGame;
    myId?: number;
    onReport: (game: InPersonGame) => void;
    onAction: (
        game: InPersonGame,
        action: 'withdraw' | 'escalate' | 'cancel'
    ) => void;
}) {
    const { game, myId } = props;
    const status = statusLabel(game);
    const opponent =
        myId && game.player1.id === myId ? game.player2 : game.player1;
    const myReport = (game.reports ?? []).find((report) => report.reporterId === myId);

    return (
        <Card style={{ marginBottom: spacing.sm }}>
            <View style={styles.cardHeader}>
                <View style={{ flex: 1 }}>
                    <Text style={styles.opponent}>vs {opponent.username}</Text>
                    <Text style={styles.meta}>
                        {[
                            game.gameFormat,
                            game.clubName,
                            game.playedAt
                                ? new Date(game.playedAt).toLocaleDateString()
                                : undefined,
                            game.rated === false ? 'unrated' : undefined
                        ]
                            .filter(Boolean)
                            .join(' · ')}
                    </Text>
                </View>
                <Text style={[styles.status, { color: status.color }]}>{status.text}</Text>
            </View>

            {myReport ? (
                <Text style={styles.meta}>
                    You reported {myReport.player1Keys}–{myReport.player2Keys}, winner{' '}
                    {myReport.winnerId === game.player1.id
                        ? game.player1.username
                        : game.player2.username}
                    .
                </Text>
            ) : null}
            {game.unratedReason ? (
                <Text style={styles.meta}>Unrated: {game.unratedReason}</Text>
            ) : null}

            <View style={styles.cardActions}>
                {game.status === 'pending' && game.awaitingMyReport ? (
                    <Button
                        small
                        title='Report result'
                        onPress={() => props.onReport(game)}
                        style={{ flex: 1 }}
                    />
                ) : null}
                {game.status === 'pending' && myReport ? (
                    <Button
                        small
                        variant='secondary'
                        title='Withdraw report'
                        onPress={() => props.onAction(game, 'withdraw')}
                        style={{ flex: 1 }}
                    />
                ) : null}
                {game.status === 'disputed' && !game.reportId ? (
                    <Button
                        small
                        variant='secondary'
                        title='Ask a moderator'
                        onPress={() => props.onAction(game, 'escalate')}
                        style={{ flex: 1 }}
                    />
                ) : null}
                {game.status === 'pending' ? (
                    <Button
                        small
                        variant='ghost'
                        title='Cancel'
                        onPress={() => props.onAction(game, 'cancel')}
                    />
                ) : null}
            </View>
        </Card>
    );
}

function ReportForm(props: {
    game: InPersonGame;
    onCancel: () => void;
    onSubmit: (body: {
        winnerId: number;
        player1Keys: number;
        player2Keys: number;
    }) => Promise<void>;
}) {
    const { game } = props;
    const [winnerId, setWinnerId] = useState<number | undefined>();
    const [player1Keys, setPlayer1Keys] = useState('3');
    const [player2Keys, setPlayer2Keys] = useState('0');
    const [busy, setBusy] = useState(false);

    return (
        <Card style={{ marginBottom: spacing.md, borderColor: colors.brandDark }}>
            <Text style={styles.sectionTitle}>
                {game.player1.username} vs {game.player2.username}
            </Text>

            <Text style={styles.label}>Who won?</Text>
            <View style={styles.chipRow}>
                {[game.player1, game.player2].map((player) => (
                    <Pressable
                        key={player.id}
                        onPress={() => setWinnerId(player.id)}
                        style={[styles.chip, winnerId === player.id && styles.chipActive]}
                    >
                        <Text
                            style={[
                                styles.chipText,
                                winnerId === player.id && styles.chipTextActive
                            ]}
                        >
                            {player.username}
                        </Text>
                    </Pressable>
                ))}
            </View>

            <View style={styles.keysRow}>
                <TextField
                    label={`${game.player1.username} keys`}
                    value={player1Keys}
                    onChangeText={setPlayer1Keys}
                    keyboardType='number-pad'
                    maxLength={1}
                    containerStyle={{ flex: 1 }}
                />
                <TextField
                    label={`${game.player2.username} keys`}
                    value={player2Keys}
                    onChangeText={setPlayer2Keys}
                    keyboardType='number-pad'
                    maxLength={1}
                    containerStyle={{ flex: 1 }}
                />
            </View>

            <View style={styles.cardActions}>
                <Button
                    variant='secondary'
                    title='Cancel'
                    onPress={props.onCancel}
                    style={{ flex: 1 }}
                />
                <Button
                    title='Send report'
                    loading={busy}
                    disabled={!winnerId}
                    onPress={async () => {
                        if (!winnerId) {
                            return;
                        }
                        setBusy(true);
                        try {
                            await props.onSubmit({
                                winnerId,
                                player1Keys: parseInt(player1Keys, 10) || 0,
                                player2Keys: parseInt(player2Keys, 10) || 0
                            });
                        } finally {
                            setBusy(false);
                        }
                    }}
                    style={{ flex: 1 }}
                />
            </View>
        </Card>
    );
}

export default function InPersonScreen() {
    const myId = useAuthStore((state) => state.user?.id);
    const myNumericId = myId === undefined ? undefined : Number(myId);

    const [games, setGames] = useState<InPersonGame[]>([]);
    const [rated, setRated] = useState<boolean | undefined>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [reporting, setReporting] = useState<InPersonGame | undefined>();

    const [opponent, setOpponent] = useState('');
    const [format, setFormat] = useState('normal');
    const [creating, setCreating] = useState(false);
    const [formOpen, setFormOpen] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError(undefined);
        try {
            const result = await fetchInPersonGames();
            setGames(result.games ?? []);
            setRated(result.rated);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load your paper games');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const create = async () => {
        const name = opponent.trim();
        if (!name) {
            return;
        }
        setCreating(true);
        setError(undefined);
        try {
            const result = await createInPersonGame({
                opponentUsername: name,
                gameFormat: format
            });
            if (!result.success) {
                setError(result.message ?? 'Could not record that game');
                return;
            }
            setOpponent('');
            setFormOpen(false);
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not record that game');
        } finally {
            setCreating(false);
        }
    };

    const runAction = async (
        game: InPersonGame,
        action: 'withdraw' | 'escalate' | 'cancel'
    ) => {
        const perform = async () => {
            setError(undefined);
            try {
                const result =
                    action === 'withdraw'
                        ? await withdrawInPersonReport(game.id)
                        : action === 'escalate'
                        ? await escalateInPersonGame(game.id)
                        : await cancelInPersonGame(game.id);

                if (!result.success) {
                    setError(result.message ?? 'That did not work');
                    return;
                }
                await load();
            } catch (err) {
                setError(err instanceof Error ? err.message : 'That did not work');
            }
        };

        if (action === 'cancel') {
            Alert.alert('Cancel game', 'Remove this game entirely?', [
                { text: 'Keep', style: 'cancel' },
                { text: 'Cancel game', style: 'destructive', onPress: perform }
            ]);

            return;
        }

        perform();
    };

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <ScrollView
                contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
                keyboardShouldPersistTaps='handled'
                refreshControl={
                    <RefreshControl
                        refreshing={loading}
                        onRefresh={load}
                        tintColor={colors.brand}
                    />
                }
            >
                <ErrorBanner message={error} />

                <Card style={{ marginBottom: spacing.md }}>
                    <Text style={styles.sectionTitle}>Record a game you played in person</Text>
                    <Text style={styles.hint}>
                        Both of you report the result. It confirms when the two reports agree
                        {rated === false ? '.' : ', and a confirmed game moves your Amber.'}
                    </Text>

                    {formOpen ? (
                        <>
                            <TextField
                                label='Opponent'
                                value={opponent}
                                onChangeText={setOpponent}
                                placeholder='Their Archon Arena username'
                                autoCapitalize='none'
                                containerStyle={{ marginTop: spacing.sm }}
                            />
                            <Text style={styles.label}>Format</Text>
                            <View style={styles.chipRow}>
                                {GAME_FORMATS.map((entry) => (
                                    <Pressable
                                        key={entry.name}
                                        onPress={() => setFormat(entry.name)}
                                        style={[
                                            styles.chip,
                                            format === entry.name && styles.chipActive
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                styles.chipText,
                                                format === entry.name && styles.chipTextActive
                                            ]}
                                        >
                                            {entry.label}
                                        </Text>
                                    </Pressable>
                                ))}
                            </View>
                            <View style={styles.cardActions}>
                                <Button
                                    variant='secondary'
                                    title='Cancel'
                                    onPress={() => setFormOpen(false)}
                                    style={{ flex: 1 }}
                                />
                                <Button
                                    title='Record'
                                    loading={creating}
                                    disabled={!opponent.trim()}
                                    onPress={create}
                                    style={{ flex: 1 }}
                                />
                            </View>
                        </>
                    ) : (
                        <Button
                            title='New paper game'
                            onPress={() => setFormOpen(true)}
                            style={{ marginTop: spacing.md }}
                        />
                    )}
                </Card>

                {reporting ? (
                    <ReportForm
                        game={reporting}
                        onCancel={() => setReporting(undefined)}
                        onSubmit={async (body) => {
                            setError(undefined);
                            try {
                                const result = await reportInPersonGame(reporting.id, body);
                                if (!result.success) {
                                    setError(result.message ?? 'Could not send that report');
                                    return;
                                }
                                setReporting(undefined);
                                await load();
                            } catch (err) {
                                setError(
                                    err instanceof Error
                                        ? err.message
                                        : 'Could not send that report'
                                );
                            }
                        }}
                    />
                ) : null}

                {loading && games.length === 0 ? (
                    <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.xl }} />
                ) : null}

                {games.map((game) => (
                    <GameCard
                        key={game.id}
                        game={game}
                        myId={myNumericId}
                        onReport={setReporting}
                        onAction={runAction}
                    />
                ))}

                {!loading && games.length === 0 ? (
                    <EmptyState
                        title='No paper games yet'
                        subtitle='Record one after a game at a table and both of you confirm the result.'
                    />
                ) : null}
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    sectionTitle: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
        marginBottom: 4
    },
    hint: {
        color: colors.textFaint,
        fontSize: 12,
        lineHeight: 17,
        marginTop: 2
    },
    label: {
        color: colors.textDim,
        fontSize: 13,
        fontWeight: '600',
        marginTop: spacing.sm,
        marginBottom: 4
    },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.md
    },
    opponent: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700'
    },
    meta: {
        color: colors.textFaint,
        fontSize: 12,
        marginTop: 3
    },
    status: {
        fontSize: 11,
        fontWeight: '800',
        textTransform: 'uppercase',
        letterSpacing: 0.3,
        maxWidth: 110,
        textAlign: 'right'
    },
    cardActions: {
        flexDirection: 'row',
        gap: spacing.sm,
        marginTop: spacing.md
    },
    chipRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6
    },
    chip: {
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: spacing.md,
        paddingVertical: 6,
        backgroundColor: colors.bgElevated
    },
    chipActive: {
        borderColor: colors.brand,
        backgroundColor: colors.surfaceHover
    },
    chipText: {
        color: colors.textDim,
        fontSize: 12,
        fontWeight: '600'
    },
    chipTextActive: {
        color: colors.brand
    },
    keysRow: {
        flexDirection: 'row',
        gap: spacing.md,
        marginTop: spacing.sm
    }
});
