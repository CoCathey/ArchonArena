import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { fetchTournamentLab } from '../src/api/client';
import type { TournamentLabDeck, TournamentLabResult } from '../src/api/types';
import { CAPABILITIES } from '../src/membership/capabilities';
import { hasCapability } from '../src/membership/entitlements';
import PremiumLock from '../src/membership/PremiumLock';
import {
    FormStrip,
    HouseBar,
    Muted,
    pct,
    SectionLabel,
    signed
} from '../src/membership/widgets';
import { useAuthStore } from '../src/stores/authStore';
import { colors, radius, spacing } from '../src/theme';
import { Button, Card, ErrorBanner } from '../src/ui/primitives';

/**
 * ARCHON (N12): Deep Probe (né the Tournament Lab) on the phone.
 *
 * "Which of my decks should I bring?" — answered from the player's own results
 * rather than from a rating anybody could look up.
 *
 * The two refusals from the web version are kept, because they are the point of
 * the feature rather than decoration:
 *
 *  - **No recommendation.** The Lab does not say "bring this one". It lays the
 *    evidence out, because the thing it cannot know — who is going to be at this
 *    event — is usually what decides.
 *  - **No confident-looking numbers over tiny samples.** A deck under the
 *    threshold shows its record AND a warning, rather than being silently
 *    ranked beside a deck with forty games.
 *
 * Stacked cards rather than the web's side-by-side columns: four columns on a
 * phone is four unreadable columns. The comparison still works because every
 * card carries the same rows in the same order.
 */

const MAX_SELECTED = 4;

function DeckCard(props: { deck: TournamentLabDeck }) {
    const { deck } = props;
    const swingTone = (deck.rating?.netSwing ?? 0) >= 0 ? colors.success : colors.danger;
    const expectedTone = (deck.rating?.vsExpectation ?? 0) >= 0 ? colors.success : colors.danger;

    return (
        <Card style={styles.deckCard}>
            <Text numberOfLines={1} style={styles.deckName}>
                {deck.deckName}
            </Text>
            <Text style={styles.deckSas}>
                {deck.sas ? `SAS ${deck.sas}` : 'SAS unknown'}
            </Text>

            <View style={styles.metricRow}>
                <Metric
                    label='Record'
                    value={`${deck.overview.wins ?? 0}–${deck.overview.losses ?? 0}`}
                />
                <Metric label='Win rate' value={pct(deck.overview.winRate)} />
                <Metric
                    color={swingTone}
                    label='Rating swing'
                    value={deck.rating?.available ? signed(deck.rating.netSwing) : '—'}
                />
                <Metric
                    color={expectedTone}
                    label='vs expected'
                    value={
                        deck.rating?.available && deck.rating.vsExpectation !== null
                            ? signed(deck.rating.vsExpectation, 1)
                            : '—'
                    }
                />
            </View>

            <View style={{ marginTop: spacing.sm }}>
                <SectionLabel>Recent form</SectionLabel>
                <FormStrip results={deck.form?.results ?? []} />
            </View>

            {deck.bestMatchups?.length ? (
                <View style={{ marginTop: spacing.sm }}>
                    <SectionLabel>Strong against</SectionLabel>
                    <Text style={[styles.matchups, { color: colors.success }]}>
                        {deck.bestMatchups
                            .map((row) => `${row.houseName || row.house} ${pct(row.winRate)}`)
                            .join(', ')}
                    </Text>
                </View>
            ) : null}

            {deck.worstMatchups?.length ? (
                <View style={{ marginTop: spacing.sm }}>
                    <SectionLabel>Struggles against</SectionLabel>
                    <Text style={[styles.matchups, { color: colors.danger }]}>
                        {deck.worstMatchups
                            .map((row) => `${row.houseName || row.house} ${pct(row.winRate)}`)
                            .join(', ')}
                    </Text>
                </View>
            ) : null}

            {deck.confident === false ? (
                <View style={styles.warning}>
                    <Text style={styles.warningText}>
                        Only {deck.overview.games ?? 0} games — too few to lean on.{' '}
                        {deck.minConfidentGames}+ is a usable sample.
                    </Text>
                </View>
            ) : null}
        </Card>
    );
}

function Metric(props: { label: string; value: string; color?: string }) {
    return (
        <View style={styles.metric}>
            <Text style={styles.metricLabel}>{props.label.toUpperCase()}</Text>
            <Text style={[styles.metricValue, props.color ? { color: props.color } : null]}>
                {props.value}
            </Text>
        </View>
    );
}

export default function TournamentLabScreen() {
    const user = useAuthStore((state) => state.user);
    const unlocked = hasCapability(user, CAPABILITIES.TOURNAMENT_LAB);
    const canCompare = hasCapability(user, CAPABILITIES.DECK_COMPARISON);

    const [selected, setSelected] = useState<number[]>([]);
    const [data, setData] = useState<TournamentLabResult | undefined>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const load = useCallback(async () => {
        if (!unlocked) {
            return;
        }

        setLoading(true);
        setError(undefined);

        try {
            setData(await fetchTournamentLab(selected));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load Deep Probe.');
        } finally {
            setLoading(false);
        }
    }, [selected, unlocked]);

    useEffect(() => {
        load();
    }, [load]);

    const toggle = (deckId: number) =>
        setSelected((current) =>
            current.includes(deckId)
                ? current.filter((id) => id !== deckId)
                : current.length >= MAX_SELECTED
                  ? current
                  : [...current, deckId]
        );

    const candidates = data?.candidates ?? [];
    const decks = data?.decks ?? [];

    return (
        <ScrollView
            style={{ flex: 1, backgroundColor: colors.bg }}
            contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: 48 }}
        >
            <ErrorBanner message={error} />

            <Card>
                <Text style={styles.lead}>
                    Which of your decks should you bring? Pick up to {MAX_SELECTED} and compare them
                    on what they have actually done for you — record, rating swing, recent form and
                    matchups.
                </Text>
            </Card>

            <PremiumLock
                capabilities={[CAPABILITIES.TOURNAMENT_LAB]}
                pitch='Work out which of your decks to bring to an event, from your own results.'
            >
                <View style={{ gap: spacing.md }}>
                    <Card>
                        <Text style={styles.panelTitle}>Choose decks</Text>
                        {candidates.length ? (
                            <View style={styles.chipRow}>
                                {candidates.map((candidate) => {
                                    const on = selected.includes(candidate.deckId);
                                    const atLimit = !on && selected.length >= MAX_SELECTED;

                                    return (
                                        <Pressable
                                            disabled={atLimit}
                                            key={candidate.deckId}
                                            onPress={() => toggle(candidate.deckId)}
                                            style={[
                                                styles.chip,
                                                on ? styles.chipActive : null,
                                                atLimit ? { opacity: 0.4 } : null
                                            ]}
                                        >
                                            <Text
                                                numberOfLines={1}
                                                style={[
                                                    styles.chipText,
                                                    on ? styles.chipTextActive : null
                                                ]}
                                            >
                                                {candidate.deckName}
                                            </Text>
                                            <Text style={styles.chipMeta}>
                                                {candidate.games}g · {pct(candidate.winRate)}
                                            </Text>
                                        </Pressable>
                                    );
                                })}
                            </View>
                        ) : (
                            <Muted>
                                No decks with recorded games yet. Play some games and your decks
                                appear here.
                            </Muted>
                        )}
                        {selected.length ? (
                            <Button
                                title='Clear selection'
                                variant='secondary'
                                small
                                onPress={() => setSelected([])}
                                style={{ marginTop: spacing.sm, alignSelf: 'flex-start' }}
                            />
                        ) : null}
                    </Card>

                    {loading ? <Muted>Comparing…</Muted> : null}

                    {/* The side-by-side comparison IS the deck_comparison
                        promise, so it is gated on that capability rather than
                        only on TOURNAMENT_LAB. Both are Archon today, so this
                        changes nothing for anyone - but the promise is enforced
                        where it is delivered. */}
                    {decks.length && canCompare
                        ? decks.map((deck) => <DeckCard deck={deck} key={deck.deckId} />)
                        : null}

                    {decks.length && data?.meta?.available ? (
                        <Card>
                            <Text style={styles.panelTitle}>What you would be walking into</Text>
                            {(data.meta.rows ?? []).slice(0, 7).map((row) => (
                                <HouseBar key={row.house} row={row} showPrevalence />
                            ))}
                            <Muted>
                                Share of house slots played across the last 30 days. Every deck
                                contributes three, so these sum to 300%.
                            </Muted>
                        </Card>
                    ) : null}

                    {!selected.length && candidates.length ? (
                        <View style={styles.emptyHint}>
                            <Text style={styles.emptyHintText}>
                                Pick a deck above to start comparing.
                            </Text>
                        </View>
                    ) : null}
                </View>
            </PremiumLock>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    lead: {
        color: colors.textDim,
        fontSize: 13,
        lineHeight: 19
    },
    panelTitle: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
        marginBottom: spacing.sm
    },
    chipRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.xs
    },
    chip: {
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgElevated,
        borderRadius: radius.pill,
        paddingHorizontal: spacing.md,
        paddingVertical: 6,
        maxWidth: 200
    },
    chipActive: {
        borderColor: colors.brand,
        backgroundColor: 'rgba(232,163,61,0.15)'
    },
    chipText: {
        color: colors.text,
        fontSize: 12
    },
    chipTextActive: {
        color: colors.brand,
        fontWeight: '600'
    },
    chipMeta: {
        color: colors.textFaint,
        fontSize: 10
    },
    deckCard: {
        borderWidth: 1,
        borderColor: colors.border
    },
    deckName: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '700'
    },
    deckSas: {
        color: colors.textFaint,
        fontSize: 11,
        marginBottom: spacing.sm
    },
    metricRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm
    },
    metric: {
        flexGrow: 1,
        flexBasis: '45%'
    },
    metricLabel: {
        color: colors.textFaint,
        fontSize: 9,
        letterSpacing: 0.6,
        fontWeight: '700'
    },
    metricValue: {
        color: colors.text,
        fontSize: 16,
        fontWeight: '700'
    },
    matchups: {
        fontSize: 12,
        lineHeight: 17
    },
    warning: {
        marginTop: spacing.md,
        borderWidth: 1,
        borderColor: colors.brandDark,
        backgroundColor: 'rgba(232,163,61,0.12)',
        borderRadius: radius.sm,
        paddingHorizontal: spacing.sm,
        paddingVertical: 6
    },
    warningText: {
        color: colors.brand,
        fontSize: 11,
        lineHeight: 16
    },
    emptyHint: {
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: colors.border,
        borderRadius: radius.md,
        padding: spacing.xl
    },
    emptyHintText: {
        color: colors.textDim,
        fontSize: 13,
        textAlign: 'center'
    }
});
