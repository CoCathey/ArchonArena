import React, { useState } from 'react';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
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
import {
    hasOnlineTable,
    isDecided,
    liveOffers,
    planReport,
    reportSource,
    seriesLabel,
    seriesScore,
    type ReportPlan
} from './matchState';

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
    /** An armed match report, waiting for the second tap that writes it. */
    const [confirming, setConfirming] = useState<
        { winner: 'mine' | 'theirs'; plan: Extract<ReportPlan, { ok: true }> } | undefined
    >();

    const amPlayer1 = match.player1Id === myUserId;
    const opponent = amPlayer1 ? match.player2 : match.player1;
    const opponentId = amPlayer1 ? match.player2Id : match.player1Id;
    const decided = isDecided(match);
    const iReported = match.reportedBy === myUserId;
    const scheduled = parseUtc(match.scheduledAt);
    const offers = liveOffers(match);
    const score = seriesScore(match, myUserId);

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

    /**
     * Arm a match report, or say why it cannot be made.
     *
     * Nothing is sent here. Reporting ends the whole series and overwrites what
     * the platform recorded from the games themselves, so it takes a second,
     * deliberate tap against a sentence naming the score it will write.
     */
    const armReport = (winner: 'mine' | 'theirs') => {
        const plan = planReport(
            match,
            myUserId,
            winner === 'mine' ? myUserId : (opponentId as number)
        );

        if (!plan.ok) {
            setError(plan.reason);
            return;
        }

        setError(undefined);
        setConfirming({ winner, plan });
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

            {/* ---- The series ---- */}
            {seriesLabel(score) ? <Text style={styles.series}>{seriesLabel(score)}</Text> : null}

            {/* ---- When ---- */}
            {scheduled ? (
                <Text style={styles.when}>
                    Agreed for {localTime(match.scheduledAt)} ({relativeTime(match.scheduledAt)})
                </Text>
            ) : !decided && offers.length ? (
                // Only while the match is live: the server refuses every
                // scheduling call once it has a result, so an offer left
                // standing on a decided match is not one to answer.
                <View style={styles.offerList}>
                    {offers.map((offer) => {
                        const theirs = offer.proposedById !== myUserId;

                        return (
                            <View key={offer.id ?? offer.time} style={styles.offerLine}>
                                <View style={styles.offerWhenBox}>
                                    <Text style={styles.when}>
                                        {localTime(offer.time)}
                                        {offer.end ? ` until ${localTime(offer.end)}` : ''}
                                    </Text>
                                    <Text style={styles.offerBy}>
                                        {theirs
                                            ? `${offer.proposedBy ?? opponent} offered this`
                                            : 'you offered this'}
                                        {offer.end ? ' — any time in the window' : ''}
                                    </Text>
                                </View>
                                {/* Accepting names the offer: the server refuses
                                    an unnamed accept once two are on the table. */}
                                {theirs ? (
                                    <Button
                                        small
                                        title='Play then'
                                        loading={busy === `accept-${offer.id}`}
                                        onPress={() =>
                                            run(`accept-${offer.id}`, () =>
                                                acceptMatchTime(
                                                    tournament.id,
                                                    match.id,
                                                    offer.id ?? undefined
                                                )
                                            )
                                        }
                                    />
                                ) : null}
                            </View>
                        );
                    })}
                    {match.scheduleNote ? (
                        <Text style={styles.whenMuted}>“{match.scheduleNote}”</Text>
                    ) : null}
                </View>
            ) : tournament.pacing === 'async' ? (
                <Text style={styles.whenMuted}>No time agreed yet.</Text>
            ) : null}

            <ErrorBanner message={error} />

            {/* ---- Result already in ---- */}
            {decided ? (
                <View>
                    <Text style={styles.body}>
                        {match.winnerId === myUserId
                            ? 'You won'
                            : match.winnerId
                            ? `${opponent} won`
                            : // No winner and a result all the same: the
                              // organizer's ruling that nobody took this one.
                              'Recorded as a loss for both of you'}
                        {score.recorded ? ` ${score.mine}–${score.theirs}` : ''}
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
                    {/* ---- Scheduling (async events) ----
                        Accepting is per offer, up with the times themselves;
                        what is left here is adding one and clearing them. */}
                    {tournament.pacing === 'async' ? (
                        <View style={styles.actions}>
                            <Button
                                small
                                variant='secondary'
                                title={
                                    scheduled
                                        ? 'Change the time'
                                        : offers.length
                                        ? 'Offer another time'
                                        : 'Propose a time'
                                }
                                onPress={() => setShowOffers((open) => !open)}
                            />
                            {scheduled || offers.length ? (
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

                    {/* ---- Play ----
                        An irl event is played across a table and the server
                        refuses to open a game for one, so the button was a
                        guaranteed error message on every irl pairing. */}
                    {hasOnlineTable(tournament) ? (
                        <View style={styles.actions}>
                            <Button
                                small
                                title={
                                    score.recorded
                                        ? `Open the table for game ${score.recorded + 1}`
                                        : 'Open the table'
                                }
                                loading={busy === 'table'}
                                onPress={openTable}
                            />
                        </View>
                    ) : null}

                    {/* ---- Report the whole match ---- */}
                    {confirming ? (
                        <View style={styles.confirmBox}>
                            <Text style={styles.confirmText}>
                                This ends the match, not a game: it records the series as{' '}
                                {confirming.winner === 'mine'
                                    ? 'won by you'
                                    : `won by ${opponent}`}
                                , {confirming.plan.mine}–{confirming.plan.theirs}.
                                {confirming.plan.kept
                                    ? ` The ${
                                          confirming.plan.kept === 1
                                              ? 'game'
                                              : `${confirming.plan.kept} games`
                                      } already recorded ${
                                          confirming.plan.kept === 1 ? 'is' : 'are'
                                      } kept.`
                                    : ''}
                            </Text>
                            <View style={styles.actions}>
                                <Button
                                    small
                                    variant='danger'
                                    title={`Record ${confirming.plan.mine}–${confirming.plan.theirs}`}
                                    loading={busy === 'report'}
                                    onPress={() =>
                                        run('report', () =>
                                            reportResult(
                                                tournament.id,
                                                match.id,
                                                confirming.winner === 'mine'
                                                    ? myUserId
                                                    : opponentId,
                                                {
                                                    ...confirming.plan.scores,
                                                    source: reportSource(tournament)
                                                }
                                            )
                                        ).then(() => setConfirming(undefined))
                                    }
                                />
                                <Button
                                    small
                                    variant='ghost'
                                    title='Not yet'
                                    onPress={() => setConfirming(undefined)}
                                />
                            </View>
                        </View>
                    ) : (
                        <View style={styles.actions}>
                            <Button
                                small
                                variant='secondary'
                                title='Report the match: I won it'
                                onPress={() => armReport('mine')}
                            />
                            <Button
                                small
                                variant='ghost'
                                title={`Report the match: ${opponent} won it`}
                                onPress={() => armReport('theirs')}
                            />
                        </View>
                    )}
                    <Text style={styles.hint}>
                        Games played on the table report themselves. These two end the whole
                        match — use them only for a result the engine did not see.
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
    series: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '700',
        marginTop: 6
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
    offerList: {
        marginTop: 2
    },
    offerLine: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.sm
    },
    offerWhenBox: {
        flexShrink: 1
    },
    offerBy: {
        color: colors.textFaint,
        fontSize: 11,
        marginTop: 2
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
    confirmBox: {
        marginTop: spacing.md,
        backgroundColor: colors.bgElevated,
        borderColor: colors.danger,
        borderWidth: 1,
        borderRadius: radius.md,
        padding: spacing.sm
    },
    confirmText: {
        color: colors.text,
        fontSize: 12,
        lineHeight: 17
    },
    disputed: {
        color: colors.warning,
        fontSize: 12,
        fontWeight: '700',
        marginTop: spacing.sm
    }
});
