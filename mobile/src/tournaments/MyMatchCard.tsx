import React, { useState } from 'react';
import { router } from 'expo-router';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import {
    acceptMatchTime,
    clearMatchTime,
    confirmResult,
    disputeResult,
    openMatchGame,
    proposeMatchTime,
    reportResult,
    type TournamentDetail,
    type TournamentMatch
} from '../api/tournaments';
import { lobby } from '../net/lobbySocket';
import { colors, radius, spacing } from '../theme';
import { Button, ErrorBanner, TextField } from '../ui/primitives';
import { localTime, parseUtc, relativeTime } from './format';

/** Quick offers, so proposing a time is not a date-picker expedition. */
const QUICK_OFFERS = [
    { label: 'In 1 hour', hours: 1 },
    { label: 'In 3 hours', hours: 3 },
    { label: 'Tonight 8pm', at: { hour: 20, dayOffset: 0 } },
    { label: 'Tomorrow 8pm', at: { hour: 20, dayOffset: 1 } }
] as const;

function offerToDate(offer: (typeof QUICK_OFFERS)[number]): Date {
    const when = new Date();

    if ('hours' in offer) {
        when.setHours(when.getHours() + offer.hours, 0, 0, 0);

        return when;
    }

    when.setDate(when.getDate() + offer.at.dayOffset);
    when.setHours(offer.at.hour, 0, 0, 0);

    // "Tonight 8pm" after 8pm means tomorrow, not a time that has passed.
    if (when.getTime() <= Date.now()) {
        when.setDate(when.getDate() + 1);
    }

    return when;
}

/**
 * The player's own match in an event: when it is, and everything they can do
 * about it. Everything here is authorized server-side — this decides only what
 * is worth putting on screen.
 */
export default function MyMatchCard(props: {
    tournament: TournamentDetail;
    match: TournamentMatch;
    myUserId: number;
    onChanged: () => void;
}) {
    const { tournament, match, myUserId } = props;
    const [busy, setBusy] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [note, setNote] = useState('');
    const [showOffers, setShowOffers] = useState(false);
    const [disputing, setDisputing] = useState(false);

    const amPlayer1 = match.player1Id === myUserId;
    const opponent = amPlayer1 ? match.player2 : match.player1;
    const opponentId = amPlayer1 ? match.player2Id : match.player1Id;
    const decided = !!match.winnerId;
    const iReported = match.reportedBy === myUserId;
    const scheduled = parseUtc(match.scheduledAt);
    const proposed = parseUtc(match.proposedTime);
    const theyProposed = !!match.proposedTime && match.proposedBy !== myUserId;

    const run = async (key: string, action: () => Promise<{ success: boolean; message?: string }>) => {
        setBusy(key);
        setError(undefined);
        try {
            const result = await action();
            if (!result.success) {
                setError(result.message ?? 'That did not work.');
                return;
            }
            props.onChanged();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'That did not work.');
        } finally {
            setBusy(undefined);
        }
    };

    /** Open (or rejoin) the lobby table for this match and go to it. */
    const openTable = async () => {
        setBusy('table');
        setError(undefined);
        try {
            const result = await openMatchGame(tournament.id, match.id);
            if (!result.success) {
                setError(result.message ?? 'Could not open the table.');
                return;
            }
            // The lobby answers with a game state and the pending screen takes
            // over, exactly as joining from the lobby list does.
            if (result.gameId) {
                lobby.joinGame(result.gameId);
            }
            router.push('/(tabs)');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not open the table.');
        } finally {
            setBusy(undefined);
        }
    };

    if (!opponentId) {
        return (
            <View style={styles.card}>
                <Text style={styles.title}>Round {match.round}</Text>
                <Text style={styles.body}>You have a bye this round.</Text>
            </View>
        );
    }

    return (
        <View style={styles.card}>
            <View style={styles.headRow}>
                <Text style={styles.title}>
                    Round {match.round} · vs {opponent}
                </Text>
                {match.table ? <Text style={styles.table}>Table {match.table}</Text> : null}
            </View>

            {/* ---- When ---- */}
            {scheduled ? (
                <Text style={styles.when}>
                    Agreed for {localTime(match.scheduledAt)} ({relativeTime(match.scheduledAt)})
                </Text>
            ) : proposed ? (
                <Text style={styles.when}>
                    {theyProposed ? `${opponent} proposed` : 'You proposed'}{' '}
                    {localTime(match.proposedTime)}
                    {match.scheduleNote ? ` — “${match.scheduleNote}”` : ''}
                </Text>
            ) : tournament.pacing === 'async' ? (
                <Text style={styles.whenMuted}>No time agreed yet.</Text>
            ) : null}

            <ErrorBanner message={error} />

            {/* ---- Result already in ---- */}
            {decided ? (
                <View>
                    <Text style={styles.body}>
                        {match.winnerId === myUserId ? 'You won' : `${opponent} won`}
                        {typeof match.player1Wins === 'number' &&
                        typeof match.player2Wins === 'number'
                            ? ` ${amPlayer1 ? match.player1Wins : match.player2Wins}–${
                                  amPlayer1 ? match.player2Wins : match.player1Wins
                              }`
                            : ''}
                        {match.confirmed ? ' · confirmed' : ''}
                    </Text>
                    {/* The opponent's account of a match is not final until
                        this player agrees with it. */}
                    {!match.confirmed && !iReported ? (
                        <View style={styles.actions}>
                            <Button
                                small
                                title='That’s right'
                                loading={busy === 'confirm'}
                                onPress={() =>
                                    run('confirm', () => confirmResult(tournament.id, match.id))
                                }
                            />
                            <Button
                                small
                                variant='secondary'
                                title='Dispute'
                                onPress={() => setDisputing((open) => !open)}
                            />
                        </View>
                    ) : null}
                    {!match.confirmed && iReported ? (
                        <Text style={styles.hint}>Waiting for {opponent} to confirm.</Text>
                    ) : null}
                    {disputing ? (
                        <View style={styles.disputeBox}>
                            <TextField
                                placeholder='What actually happened?'
                                value={note}
                                onChangeText={setNote}
                                autoCapitalize='sentences'
                                containerStyle={{ marginBottom: spacing.sm }}
                            />
                            <Button
                                small
                                variant='danger'
                                title='Send to the organizer'
                                loading={busy === 'dispute'}
                                onPress={() =>
                                    run('dispute', () =>
                                        disputeResult(tournament.id, match.id, note.trim())
                                    ).then(() => {
                                        setDisputing(false);
                                        setNote('');
                                    })
                                }
                            />
                        </View>
                    ) : null}
                    {match.disputedBy ? (
                        <Text style={styles.disputed}>
                            Disputed — the organizer has been asked to rule.
                        </Text>
                    ) : null}
                </View>
            ) : (
                <>
                    {/* ---- Scheduling (async events) ---- */}
                    {tournament.pacing === 'async' ? (
                        <View style={styles.actions}>
                            {theyProposed ? (
                                <>
                                    <Button
                                        small
                                        title='Accept'
                                        loading={busy === 'accept'}
                                        onPress={() =>
                                            run('accept', () =>
                                                acceptMatchTime(tournament.id, match.id)
                                            )
                                        }
                                    />
                                    <Button
                                        small
                                        variant='secondary'
                                        title='Suggest another'
                                        onPress={() => setShowOffers((open) => !open)}
                                    />
                                </>
                            ) : (
                                <Button
                                    small
                                    variant='secondary'
                                    title={
                                        scheduled || proposed ? 'Change the time' : 'Propose a time'
                                    }
                                    onPress={() => setShowOffers((open) => !open)}
                                />
                            )}
                            {scheduled || proposed ? (
                                <Button
                                    small
                                    variant='ghost'
                                    title='Clear'
                                    loading={busy === 'clear'}
                                    onPress={() =>
                                        run('clear', () => clearMatchTime(tournament.id, match.id))
                                    }
                                />
                            ) : null}
                        </View>
                    ) : null}

                    {showOffers ? (
                        <View style={styles.offers}>
                            <Text style={styles.hint}>
                                Times are sent in your own zone and shown to {opponent} in theirs.
                            </Text>
                            <View style={styles.offerRow}>
                                {QUICK_OFFERS.map((offer) => (
                                    <Pressable
                                        key={offer.label}
                                        onPress={() =>
                                            run('propose', () =>
                                                proposeMatchTime(
                                                    tournament.id,
                                                    match.id,
                                                    offerToDate(offer).toISOString(),
                                                    note.trim() || undefined
                                                )
                                            ).then(() => {
                                                setShowOffers(false);
                                                setNote('');
                                            })
                                        }
                                        style={({ pressed }) => [
                                            styles.offerChip,
                                            pressed && { opacity: 0.7 }
                                        ]}
                                    >
                                        <Text style={styles.offerText}>{offer.label}</Text>
                                        <Text style={styles.offerWhen}>
                                            {localTime(offerToDate(offer).toISOString())}
                                        </Text>
                                    </Pressable>
                                ))}
                            </View>
                            <TextField
                                placeholder='Add a note (optional)'
                                value={note}
                                onChangeText={setNote}
                                autoCapitalize='sentences'
                                containerStyle={{ marginBottom: 0, marginTop: spacing.sm }}
                            />
                        </View>
                    ) : null}

                    {/* ---- Play ---- */}
                    <View style={styles.actions}>
                        <Button
                            small
                            title='Open the table'
                            loading={busy === 'table'}
                            onPress={openTable}
                        />
                        <Button
                            small
                            variant='secondary'
                            title='I won'
                            loading={busy === 'won'}
                            onPress={() =>
                                run('won', () =>
                                    reportResult(tournament.id, match.id, myUserId, {
                                        source: Platform.OS === 'web' ? undefined : 'app'
                                    })
                                )
                            }
                        />
                        <Button
                            small
                            variant='ghost'
                            title='They won'
                            loading={busy === 'lost'}
                            onPress={() =>
                                run('lost', () =>
                                    reportResult(tournament.id, match.id, opponentId)
                                )
                            }
                        />
                    </View>
                    <Text style={styles.hint}>
                        A game played on the table reports itself; these are for a result the
                        engine did not see.
                    </Text>
                </>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    card: {
        backgroundColor: colors.surface,
        borderColor: colors.brand,
        borderWidth: 1,
        borderRadius: radius.lg,
        padding: spacing.md,
        marginBottom: spacing.md
    },
    headRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.sm
    },
    title: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '800',
        flexShrink: 1
    },
    table: {
        color: colors.textDim,
        fontSize: 12,
        fontWeight: '700'
    },
    when: {
        color: colors.brand,
        fontSize: 13,
        fontWeight: '600',
        marginTop: 6
    },
    whenMuted: {
        color: colors.textFaint,
        fontSize: 13,
        marginTop: 6
    },
    body: {
        color: colors.textDim,
        fontSize: 13,
        marginTop: 6
    },
    hint: {
        color: colors.textFaint,
        fontSize: 11,
        lineHeight: 15,
        marginTop: 8
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm,
        marginTop: spacing.md
    },
    offers: {
        marginTop: spacing.md,
        borderTopColor: colors.border,
        borderTopWidth: StyleSheet.hairlineWidth,
        paddingTop: spacing.sm
    },
    offerRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm,
        marginTop: spacing.sm
    },
    offerChip: {
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        paddingHorizontal: 12,
        paddingVertical: 8
    },
    offerText: {
        color: colors.text,
        fontSize: 12,
        fontWeight: '700'
    },
    offerWhen: {
        color: colors.textFaint,
        fontSize: 10,
        marginTop: 2
    },
    disputeBox: {
        marginTop: spacing.md
    },
    disputed: {
        color: colors.warning,
        fontSize: 12,
        fontWeight: '700',
        marginTop: spacing.sm
    }
});
