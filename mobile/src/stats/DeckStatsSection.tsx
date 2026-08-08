import React, { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import {
    ActivityIndicator,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    View
} from 'react-native';
import { ApiError, fetchDeckStats } from '../api/client';
import type { DeckPerformance, DeckStatsResult } from '../api/types';
import { colors, radius, spacing } from '../theme';
import BarList, { type BarItem } from '../ui/BarList';
import HouseIcon from '../ui/HouseIcon';
import { Card, EmptyState, ErrorBanner } from '../ui/primitives';

type Stats = NonNullable<DeckStatsResult['stats']>;

/** Sorts a player's decks the way they are most often asked about. */
const SORTS = [
    { key: 'delta', label: 'Vs SAS' },
    { key: 'winRate', label: 'Win %' },
    { key: 'games', label: 'Played' }
] as const;

type SortKey = (typeof SORTS)[number]['key'];

function percent(value?: number | null): string {
    return typeof value === 'number' ? `${value.toFixed(0)}%` : '—';
}

/** Signed points above/below what this deck's SAS band achieves site-wide. */
function DeltaBadge(props: { delta?: number | null }) {
    if (typeof props.delta !== 'number') {
        return null;
    }
    const good = props.delta >= 0;
    return (
        <Text style={[styles.delta, { color: good ? '#7ed494' : '#ff8f93' }]}>
            {good ? '+' : '−'}
            {Math.abs(props.delta).toFixed(0)} vs SAS
        </Text>
    );
}

function DeckPerformanceRow(props: { deck: DeckPerformance }) {
    const { deck } = props;
    return (
        <Pressable
            onPress={() => router.push(`/deck/${deck.deckId}`)}
            style={({ pressed }) => [styles.deckRow, pressed && { opacity: 0.6 }]}
        >
            <View style={{ flex: 1 }}>
                <Text style={styles.deckName} numberOfLines={1}>
                    {deck.name}
                </Text>
                <View style={styles.deckMeta}>
                    <Text style={styles.deckRecord}>
                        {deck.wins}W – {deck.losses}L
                    </Text>
                    {typeof deck.sasRating === 'number' ? (
                        <Text style={styles.deckSas}>{Math.round(deck.sasRating)} SAS</Text>
                    ) : null}
                    <DeltaBadge delta={deck.sasDelta} />
                </View>
            </View>
            <Text style={styles.deckWinRate}>{percent(deck.winRate)}</Text>
        </Pressable>
    );
}

function Callout(props: { title: string; deck?: DeckPerformance | null; tone: 'good' | 'bad' }) {
    if (!props.deck) {
        return null;
    }
    return (
        <View
            style={[
                styles.callout,
                { borderColor: props.tone === 'good' ? colors.success : colors.border }
            ]}
        >
            <Text style={styles.calloutTitle}>{props.title}</Text>
            <Text style={styles.calloutDeck} numberOfLines={1}>
                {props.deck.name}
            </Text>
            <Text style={styles.calloutMeta}>
                {percent(props.deck.winRate)} over {props.deck.games} games
                {typeof props.deck.expectedWinRate === 'number'
                    ? ` · ${percent(props.deck.expectedWinRate)} expected`
                    : ''}
            </Text>
        </View>
    );
}

/**
 * How the player's own decks have performed, and against which houses. The
 * interesting column is the delta: whether a deck beats what its SAS predicts,
 * which is a question about piloting rather than about deck power.
 */
export default function DeckStatsSection(props: { username?: string }) {
    const [stats, setStats] = useState<Stats | undefined>();
    const [sort, setSort] = useState<SortKey>('delta');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const load = useCallback(async () => {
        if (!props.username) {
            return;
        }
        setLoading(true);
        setError(undefined);
        try {
            const result = await fetchDeckStats(props.username);
            setStats(result.stats);
        } catch (err) {
            // 404 just means the account has no finished games yet.
            if (err instanceof ApiError && err.status === 404) {
                setStats(undefined);
            } else {
                setError(err instanceof Error ? err.message : 'Could not load your deck stats');
            }
        } finally {
            setLoading(false);
        }
    }, [props.username]);

    useEffect(() => {
        load();
    }, [load]);

    const played = (stats?.decks ?? []).filter((deck) => deck.games > 0);
    const sorted = [...played].sort((a, b) => {
        if (sort === 'games') {
            return b.games - a.games;
        }
        if (sort === 'winRate') {
            return (b.winRate ?? -1) - (a.winRate ?? -1);
        }
        // Decks with no SAS have no expectation to beat; keep them last rather
        // than treating "unknown" as zero.
        return (b.sasDelta ?? -Infinity) - (a.sasDelta ?? -Infinity);
    });

    const matchupItems: BarItem[] = (stats?.matchups ?? []).map((matchup) => ({
        key: matchup.opponentHouse,
        label: matchup.opponentHouse,
        value: matchup.winRate,
        display: percent(matchup.winRate),
        sub: `${matchup.games} games`,
        icon: <HouseIcon house={matchup.opponentHouse.toLowerCase()} size={15} />
    }));

    if (!props.username) {
        return (
            <EmptyState
                title='Sign in to see your decks'
                subtitle='Deck performance is tied to your account.'
            />
        );
    }

    return (
        <ScrollView
            contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
            refreshControl={
                <RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.textDim} />
            }
        >
            <ErrorBanner message={error} />

            {loading && !stats ? (
                <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.xl }} />
            ) : null}

            {stats?.bestDeck || stats?.worstDeck ? (
                <View style={styles.calloutRow}>
                    <Callout title='Best deck' deck={stats?.bestDeck} tone='good' />
                    <Callout title='Weakest deck' deck={stats?.worstDeck} tone='bad' />
                </View>
            ) : null}

            {played.length > 0 ? (
                <Card style={{ marginBottom: spacing.sm }}>
                    <View style={styles.cardHeader}>
                        <Text style={styles.sectionTitle}>Your decks</Text>
                        <View style={styles.sortRow}>
                            {SORTS.map((option) => (
                                <Pressable
                                    key={option.key}
                                    onPress={() => setSort(option.key)}
                                    style={[
                                        styles.sortChip,
                                        sort === option.key && styles.sortChipActive
                                    ]}
                                >
                                    <Text
                                        style={[
                                            styles.sortChipText,
                                            sort === option.key && styles.sortChipTextActive
                                        ]}
                                    >
                                        {option.label}
                                    </Text>
                                </Pressable>
                            ))}
                        </View>
                    </View>
                    <Text style={styles.sectionHint}>
                        “Vs SAS” is how far a deck beats the win rate its power band achieves
                        site-wide.
                    </Text>
                    {sorted.map((deck) => (
                        <DeckPerformanceRow key={String(deck.deckId)} deck={deck} />
                    ))}
                </Card>
            ) : null}

            {matchupItems.length > 0 ? (
                <Card>
                    <Text style={styles.sectionTitle}>Against each house</Text>
                    <Text style={styles.sectionHint}>
                        Your record against decks containing each house. Every opponent deck
                        counts for all three of its houses.
                    </Text>
                    <BarList items={matchupItems} marker={50} />
                </Card>
            ) : null}

            {!loading && played.length === 0 && !error ? (
                <EmptyState
                    title='No deck results yet'
                    subtitle='Finish some games and each deck’s record will show up here.'
                />
            ) : null}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    calloutRow: {
        flexDirection: 'row',
        gap: spacing.sm,
        marginBottom: spacing.sm
    },
    callout: {
        flex: 1,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderRadius: radius.md,
        padding: spacing.md
    },
    calloutTitle: {
        color: colors.textFaint,
        fontSize: 10,
        fontWeight: '800',
        textTransform: 'uppercase',
        letterSpacing: 0.5
    },
    calloutDeck: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '800',
        marginTop: 4
    },
    calloutMeta: {
        color: colors.textDim,
        fontSize: 10,
        marginTop: 3,
        lineHeight: 14
    },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.sm
    },
    sectionTitle: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '800'
    },
    sectionHint: {
        color: colors.textFaint,
        fontSize: 11,
        marginTop: 4,
        marginBottom: spacing.sm,
        lineHeight: 15
    },
    sortRow: {
        flexDirection: 'row',
        gap: 4
    },
    sortChip: {
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: 9,
        paddingVertical: 4
    },
    sortChipActive: {
        backgroundColor: colors.surfaceHover,
        borderColor: colors.borderLight
    },
    sortChipText: {
        color: colors.textFaint,
        fontSize: 10,
        fontWeight: '700'
    },
    sortChipTextActive: {
        color: colors.text
    },
    deckRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingVertical: 8,
        borderTopColor: 'rgba(42, 54, 80, 0.5)',
        borderTopWidth: StyleSheet.hairlineWidth
    },
    deckName: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '700'
    },
    deckMeta: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginTop: 3
    },
    deckRecord: {
        color: colors.textDim,
        fontSize: 11
    },
    deckSas: {
        color: colors.brand,
        fontSize: 11,
        fontWeight: '700'
    },
    delta: {
        fontSize: 11,
        fontWeight: '700'
    },
    deckWinRate: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '800',
        fontVariant: ['tabular-nums']
    }
});
