import React, { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    View
} from 'react-native';
import {
    addRandomChallengeDecks,
    enrollChallengeDeck,
    fetchChallengeReport,
    withdrawChallengeDeck,
    type ChallengeCandidate,
    type ChallengeDeck,
    type ChallengeReport
} from '../src/api/premium';
import { CAPABILITIES } from '../src/membership/capabilities';
import { PremiumLock } from '../src/membership/PremiumLock';
import { colors, radius, spacing } from '../src/theme';
import { Button, Card, ErrorBanner } from '../src/ui/primitives';

/**
 * ARCHON (N18): the Champion's Challenge — Vault Master deck testing.
 *
 * A member enrols decks and the platform plays them against each other in the
 * background, all day, against a learned opponent. The app carried the
 * capability id and nothing else, so the top tier's headline feature was
 * browser-only for anybody who paid for it on a phone.
 *
 * The website's page also draws the showcase games, the persona ladder, the
 * strength curve, the card contribution table and the Vault Tour field. Those
 * are reading, and reading is what a browser is for; this carries the part a
 * phone is actually good at — check on the roster, see what the lab has
 * concluded, and enrol or withdraw a deck while you think of it.
 */

function percent(value?: number | null): string {
    return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

function DeckCard(props: { deck: ChallengeDeck; onWithdraw: (deck: ChallengeDeck) => void }) {
    const { deck } = props;
    const delta = deck.delta;

    return (
        <View style={styles.deckCard}>
            <View style={styles.deckHeader}>
                <View style={{ flex: 1 }}>
                    <Text style={styles.deckName} numberOfLines={2}>
                        {deck.name}
                        {deck.hiddenGem ? <Text style={styles.gem}> · hidden gem</Text> : null}
                    </Text>
                    <Text style={styles.deckMeta}>
                        {[
                            deck.sas ? `${Math.round(deck.sas)} SAS` : undefined,
                            deck.ari ? `ARI ${deck.ari}` : undefined,
                            deck.random ? 'randomiser slot' : undefined
                        ]
                            .filter(Boolean)
                            .join(' · ')}
                    </Text>
                </View>
                <Pressable onPress={() => props.onWithdraw(deck)} hitSlop={8}>
                    <Text style={styles.withdraw}>Withdraw</Text>
                </Pressable>
            </View>

            <View style={styles.statRow}>
                <View style={styles.stat}>
                    <Text style={styles.statValue}>{percent(deck.winRate)}</Text>
                    <Text style={styles.statLabel}>Win rate</Text>
                </View>
                <View style={styles.stat}>
                    <Text style={styles.statValue}>
                        {deck.wins}–{deck.losses}
                    </Text>
                    <Text style={styles.statLabel}>Record</Text>
                </View>
                {/* Against what its SAS predicted — the number the lab exists
                    to produce, and the reason a 62% is worth reading. */}
                {delta !== null && delta !== undefined ? (
                    <View style={styles.stat}>
                        <Text
                            style={[
                                styles.statValue,
                                { color: delta >= 0 ? '#7ed494' : '#ff8f93' }
                            ]}
                        >
                            {delta >= 0 ? '+' : ''}
                            {Math.round(delta * 100)}
                        </Text>
                        <Text style={styles.statLabel}>vs expected</Text>
                    </View>
                ) : null}
                {deck.avgTurns ? (
                    <View style={styles.stat}>
                        <Text style={styles.statValue}>{deck.avgTurns}</Text>
                        <Text style={styles.statLabel}>Avg turns</Text>
                    </View>
                ) : null}
            </View>

            {deck.confident === false ? (
                <Text style={styles.thin}>
                    Too few games yet to lean on — the lab is still playing it.
                </Text>
            ) : null}

            {deck.bestOpening ? (
                <Text style={styles.detail}>
                    Best opening house: {deck.bestOpening.house} ·{' '}
                    {percent(deck.bestOpening.winRate)} over {deck.bestOpening.games} games
                </Text>
            ) : null}
            {deck.firstPlayerWinRate !== null && deck.firstPlayerWinRate !== undefined ? (
                <Text style={styles.detail}>
                    On the play {percent(deck.firstPlayerWinRate)} · on the draw{' '}
                    {percent(deck.secondPlayerWinRate)}
                </Text>
            ) : null}
        </View>
    );
}

function ChallengeBody() {
    const [report, setReport] = useState<ChallengeReport | undefined>();
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [pickerOpen, setPickerOpen] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError(undefined);
        try {
            const result = await fetchChallengeReport();
            if (!result.success) {
                setError(result.message ?? 'Could not load the lab');
                return;
            }
            setReport(result);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load the lab');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const act = async (action: () => Promise<{ success?: boolean; message?: string }>) => {
        setBusy(true);
        setError(undefined);
        try {
            const result = await action();
            if (!result.success) {
                setError(result.message ?? 'That did not work');
                return;
            }
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'That did not work');
        } finally {
            setBusy(false);
        }
    };

    const confirmWithdraw = (deck: ChallengeDeck) => {
        Alert.alert('Withdraw deck', `Stop testing ${deck.name}? Its results are kept.`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Withdraw',
                style: 'destructive',
                onPress: () => act(() => withdrawChallengeDeck(deck.deckId))
            }
        ]);
    };

    const decks = report?.decks ?? [];
    const candidates = report?.candidates ?? [];
    const free = Math.max(0, (report?.maxEnrolled ?? 0) - decks.length);

    if (loading && !report) {
        return <ActivityIndicator color={colors.brand} size='large' style={{ marginTop: 40 }} />;
    }

    return (
        <ScrollView
            contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
            refreshControl={
                <RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.brand} />
            }
        >
            <ErrorBanner message={error} />

            <Card style={{ marginBottom: spacing.md }}>
                <Text style={styles.sectionTitle}>The lab</Text>
                <Text style={styles.hint}>
                    {report?.running
                        ? `Your decks play in the background${
                              report.unlimited
                                  ? '.'
                                  : `, up to ${report.gamesPerDeckPerDay} games each a day.`
                          }`
                        : 'The lab is paused on this server. Enrolled decks stay enrolled.'}
                </Text>
                <Text style={styles.hint}>
                    {report?.totals?.games ?? 0} games in total ·{' '}
                    {report?.totals?.today ?? 0} today · {decks.length} of{' '}
                    {report?.maxEnrolled ?? 0} slots used
                </Text>

                <View style={styles.actions}>
                    <Button
                        small
                        title={pickerOpen ? 'Close' : 'Enrol a deck'}
                        variant='secondary'
                        disabled={free === 0 && !pickerOpen}
                        onPress={() => setPickerOpen((open) => !open)}
                        style={{ flex: 1 }}
                    />
                    <Button
                        small
                        title='Fill with random'
                        variant='secondary'
                        loading={busy}
                        disabled={free === 0}
                        onPress={() => act(() => addRandomChallengeDecks(free))}
                        style={{ flex: 1 }}
                    />
                </View>
            </Card>

            {pickerOpen ? (
                <Card style={{ marginBottom: spacing.md }}>
                    <Text style={styles.sectionTitle}>Your decks</Text>
                    {candidates.length === 0 ? (
                        <Text style={styles.hint}>
                            Nothing eligible — a deck has to be one the engine can simulate.
                        </Text>
                    ) : (
                        candidates.map((candidate: ChallengeCandidate) => (
                            <Pressable
                                key={candidate.deckId}
                                onPress={() =>
                                    act(async () => {
                                        const result = await enrollChallengeDeck(candidate.deckId);
                                        if (result.success) {
                                            setPickerOpen(false);
                                        }

                                        return result;
                                    })
                                }
                                style={styles.candidateRow}
                            >
                                <Text style={styles.candidateName} numberOfLines={1}>
                                    {candidate.name}
                                </Text>
                                {candidate.sas ? (
                                    <Text style={styles.candidateSas}>
                                        {Math.round(candidate.sas)} SAS
                                    </Text>
                                ) : null}
                            </Pressable>
                        ))
                    )}
                </Card>
            ) : null}

            {(report?.findings ?? []).length > 0 ? (
                <Card style={{ marginBottom: spacing.md }}>
                    <Text style={styles.sectionTitle}>What the lab found</Text>
                    {(report?.findings ?? []).slice(0, 5).map((finding, index) => (
                        <Text key={index} style={styles.finding}>
                            • {finding.text ?? JSON.stringify(finding)}
                        </Text>
                    ))}
                </Card>
            ) : null}

            {decks.length === 0 ? (
                <Card>
                    <Text style={styles.hint}>
                        Nothing enrolled yet. Put a deck in and the platform starts playing it
                        against the field — you do not have to be here for it.
                    </Text>
                </Card>
            ) : (
                decks.map((deck) => (
                    <DeckCard key={deck.deckId} deck={deck} onWithdraw={confirmWithdraw} />
                ))
            )}
        </ScrollView>
    );
}

export default function ChampionsChallengeScreen() {
    return (
        <View style={styles.container}>
            <PremiumLock
                capabilities={[CAPABILITIES.CHAMPIONS_CHALLENGE]}
                pitch='Enrol your decks and the platform tests them against the field around the clock, then tells you which ones beat what their rating predicted.'
            >
                <ChallengeBody />
            </PremiumLock>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg,
        padding: 0
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
    actions: {
        flexDirection: 'row',
        gap: spacing.sm,
        marginTop: spacing.md
    },
    candidateRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md,
        paddingVertical: 9,
        borderTopColor: colors.border,
        borderTopWidth: StyleSheet.hairlineWidth
    },
    candidateName: {
        color: colors.accent,
        fontSize: 14,
        fontWeight: '600',
        flex: 1
    },
    candidateSas: {
        color: colors.textFaint,
        fontSize: 11
    },
    finding: {
        color: colors.textDim,
        fontSize: 13,
        lineHeight: 19,
        marginTop: 4
    },
    deckCard: {
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.lg,
        padding: spacing.md,
        marginBottom: spacing.sm
    },
    deckHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.md
    },
    deckName: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700'
    },
    gem: {
        color: colors.brand,
        fontSize: 12,
        fontWeight: '700'
    },
    deckMeta: {
        color: colors.textFaint,
        fontSize: 11,
        marginTop: 2
    },
    withdraw: {
        color: colors.danger,
        fontSize: 12,
        fontWeight: '600'
    },
    statRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.lg,
        marginTop: spacing.md
    },
    stat: {
        alignItems: 'flex-start'
    },
    statValue: {
        color: colors.text,
        fontSize: 17,
        fontWeight: '800'
    },
    statLabel: {
        color: colors.textFaint,
        fontSize: 9,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.4
    },
    thin: {
        color: colors.warning,
        fontSize: 11,
        marginTop: spacing.sm
    },
    detail: {
        color: colors.textFaint,
        fontSize: 11,
        marginTop: 4
    }
});
