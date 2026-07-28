import React, { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    View
} from 'react-native';
import {
    ApiError,
    fetchLeaderboard,
    fetchMatchHistory,
    fetchPlayerRatings,
    fetchPlayerStats
} from '../../src/api/client';
import type {
    LeaderboardEntry,
    PastGame,
    PlayerRating,
    PlayerRatingsResult,
    PlayerStatsResult
} from '../../src/api/types';
import { useAuthStore } from '../../src/stores/authStore';
import { colors, spacing } from '../../src/theme';
import HouseIcon from '../../src/ui/HouseIcon';
import { Card, EmptyState, ErrorBanner } from '../../src/ui/primitives';

const POOLS = [
    { key: 'archon', label: 'Archon' },
    { key: 'sealed', label: 'Sealed' },
    { key: 'alliance', label: 'Alliance' }
] as const;

const PAGE_SIZE = 50;

function SegmentBar<T extends string>(props: {
    options: { key: T; label: string }[];
    value: T;
    onChange: (value: T) => void;
    compact?: boolean;
}) {
    return (
        <View style={[styles.segmentRow, props.compact && styles.segmentRowCompact]}>
            {props.options.map((option) => {
                const active = option.key === props.value;
                return (
                    <Pressable
                        key={option.key}
                        onPress={() => props.onChange(option.key)}
                        style={[
                            styles.segment,
                            props.compact && styles.segmentCompact,
                            active && styles.segmentActive
                        ]}
                    >
                        <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                            {option.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

// ---- Rankings ----

function RankingsSection(props: { username?: string }) {
    const [pool, setPool] = useState<string>('archon');
    const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const load = useCallback(
        async (reset: boolean, offset: number) => {
            reset ? setLoading(true) : setLoadingMore(true);
            setError(undefined);
            try {
                // Over-fetch by one row to learn whether another page exists —
                // the API has no total count (same trick as the web client).
                const result = await fetchLeaderboard({
                    pool,
                    scope: 'world',
                    limit: PAGE_SIZE + 1,
                    offset
                });
                const raw = result.entries ?? [];
                const page = raw.slice(0, PAGE_SIZE);
                setHasMore(raw.length > PAGE_SIZE);
                setEntries((current) => (reset ? page : [...current, ...page]));
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Could not load rankings');
            } finally {
                setLoading(false);
                setLoadingMore(false);
            }
        },
        [pool]
    );

    useEffect(() => {
        setEntries([]);
        load(true, 0);
    }, [load]);

    return (
        <View style={{ flex: 1 }}>
            <SegmentBar
                compact
                options={POOLS.map((p) => ({ key: p.key, label: p.label }))}
                value={pool}
                onChange={setPool}
            />
            <View style={{ paddingHorizontal: spacing.md }}>
                <ErrorBanner message={error} />
            </View>
            <FlatList
                data={entries}
                keyExtractor={(entry) => `${entry.rank}-${entry.username}`}
                refreshControl={
                    <RefreshControl
                        refreshing={loading}
                        onRefresh={() => load(true, 0)}
                        tintColor={colors.textDim}
                    />
                }
                contentContainerStyle={{ padding: spacing.md, paddingTop: 4 }}
                renderItem={({ item }) => {
                    const isMe = item.username === props.username;
                    return (
                        <View style={[styles.rankRow, isMe && styles.rankRowMe]}>
                            <Text style={styles.rankNumber}>#{item.rank}</Text>
                            <View style={{ flex: 1 }}>
                                <Text
                                    style={[styles.rankName, isMe && { color: colors.brand }]}
                                    numberOfLines={1}
                                >
                                    {item.username}
                                    {item.provisional ? (
                                        <Text style={styles.provisional}> · provisional</Text>
                                    ) : null}
                                </Text>
                                <Text style={styles.rankRecord}>
                                    {item.wins ?? 0}W – {item.losses ?? 0}L ·{' '}
                                    {item.gamesPlayed} rated
                                </Text>
                            </View>
                            <Text style={styles.rankRating}>{item.rating}</Text>
                        </View>
                    );
                }}
                ListEmptyComponent={
                    loading ? null : (
                        <EmptyState
                            title='No ranked players yet'
                            subtitle='Rankings appear once players finish enough rated games in this pool.'
                        />
                    )
                }
                ListFooterComponent={
                    hasMore ? (
                        <Pressable
                            onPress={() => load(false, entries.length)}
                            style={styles.loadMore}
                            disabled={loadingMore}
                        >
                            {loadingMore ? (
                                <ActivityIndicator color={colors.textDim} />
                            ) : (
                                <Text style={styles.loadMoreText}>Load more</Text>
                            )}
                        </Pressable>
                    ) : null
                }
            />
        </View>
    );
}

// ---- My stats ----

function formatDuration(seconds?: number): string | undefined {
    if (!seconds || seconds <= 0) {
        return undefined;
    }
    const minutes = Math.round(seconds / 60);
    return `${minutes} min`;
}

function MyStatsSection(props: { username?: string }) {
    const [ratings, setRatings] = useState<PlayerRating[]>([]);
    const [stats, setStats] = useState<PlayerStatsResult['stats']>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const load = useCallback(async () => {
        if (!props.username) {
            return;
        }
        setLoading(true);
        setError(undefined);
        try {
            const [ratingsResult, statsResult] = await Promise.all([
                fetchPlayerRatings(props.username),
                fetchPlayerStats(props.username).catch((err) => {
                    // 404 just means no finished games yet.
                    if (err instanceof ApiError && err.status === 404) {
                        return { success: true } as PlayerStatsResult;
                    }
                    throw err;
                })
            ]);
            setRatings((ratingsResult as PlayerRatingsResult).ratings ?? []);
            setStats(statsResult.stats);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load your stats');
        } finally {
            setLoading(false);
        }
    }, [props.username]);

    useEffect(() => {
        load();
    }, [load]);

    const overall = stats?.overall;

    return (
        <ScrollView
            contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
            refreshControl={
                <RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.textDim} />
            }
        >
            <ErrorBanner message={error} />

            {ratings.length > 0 ? (
                ratings.map((rating) => (
                    <Card key={rating.pool} style={{ marginBottom: spacing.sm }}>
                        <View style={styles.ratingHeader}>
                            <Text style={styles.ratingPool}>{rating.pool}</Text>
                            <Text style={styles.ratingValue}>{rating.rating}</Text>
                        </View>
                        <Text style={styles.ratingMeta}>
                            {rating.rank
                                ? `World rank #${rating.rank}${
                                      rating.totalRated ? ` of ${rating.totalRated}` : ''
                                  } · `
                                : ''}
                            {rating.wins ?? 0}W – {rating.losses ?? 0}L
                            {rating.provisional ? ' · provisional' : ''}
                        </Text>
                    </Card>
                ))
            ) : !loading ? (
                <Card style={{ marginBottom: spacing.sm }}>
                    <Text style={styles.ratingPool}>Not ranked yet</Text>
                    <Text style={styles.ratingMeta}>
                        Finish a few rated games to get a rating and appear on the leaderboard.
                    </Text>
                </Card>
            ) : null}

            {overall ? (
                <Card style={{ marginBottom: spacing.sm }}>
                    <Text style={styles.sectionTitle}>Overall</Text>
                    <View style={styles.statGrid}>
                        <View style={styles.statCell}>
                            <Text style={styles.statValue}>{overall.games}</Text>
                            <Text style={styles.statLabel}>games</Text>
                        </View>
                        <View style={styles.statCell}>
                            <Text style={styles.statValue}>
                                {overall.wins}–{overall.losses}
                            </Text>
                            <Text style={styles.statLabel}>record</Text>
                        </View>
                        <View style={styles.statCell}>
                            <Text style={styles.statValue}>
                                {typeof overall.winRate === 'number'
                                    ? `${overall.winRate.toFixed(0)}%`
                                    : '—'}
                            </Text>
                            <Text style={styles.statLabel}>win rate</Text>
                        </View>
                        <View style={styles.statCell}>
                            <Text style={styles.statValue}>
                                {typeof overall.avgKeys === 'number'
                                    ? overall.avgKeys.toFixed(1)
                                    : '—'}
                            </Text>
                            <Text style={styles.statLabel}>avg keys</Text>
                        </View>
                        {formatDuration(overall.avgDurationSec) ? (
                            <View style={styles.statCell}>
                                <Text style={styles.statValue}>
                                    {formatDuration(overall.avgDurationSec)}
                                </Text>
                                <Text style={styles.statLabel}>avg game</Text>
                            </View>
                        ) : null}
                    </View>
                </Card>
            ) : null}

            {(stats?.houses?.length ?? 0) > 0 ? (
                <Card style={{ marginBottom: spacing.sm }}>
                    <Text style={styles.sectionTitle}>By house</Text>
                    {stats!.houses!.map((house) => (
                        <View key={house.house} style={styles.tableRow}>
                            <HouseIcon house={house.house.toLowerCase()} size={18} />
                            <Text style={styles.tableName}>{house.house}</Text>
                            <Text style={styles.tableMeta}>
                                {house.games} games
                                {typeof house.winRate === 'number'
                                    ? ` · ${house.winRate.toFixed(0)}% wins`
                                    : ''}
                            </Text>
                        </View>
                    ))}
                </Card>
            ) : null}

            {(stats?.formats?.length ?? 0) > 0 ? (
                <Card>
                    <Text style={styles.sectionTitle}>By format</Text>
                    {stats!.formats!.map((format) => (
                        <View key={format.format} style={styles.tableRow}>
                            <Text style={[styles.tableName, { textTransform: 'capitalize' }]}>
                                {format.format}
                            </Text>
                            <Text style={styles.tableMeta}>
                                {format.wins}–{format.losses}
                                {typeof format.winRate === 'number'
                                    ? ` · ${format.winRate.toFixed(0)}%`
                                    : ''}
                            </Text>
                        </View>
                    ))}
                </Card>
            ) : null}

            {!loading && !overall && ratings.length === 0 && !error ? (
                <EmptyState
                    title='No games yet'
                    subtitle='Play some games and your stats will show up here.'
                />
            ) : null}
        </ScrollView>
    );
}

// ---- Match history ----

function keyCount(keys: PastGame['players'][number]['keys']): number {
    if (typeof keys === 'number') {
        return keys;
    }
    if (keys && typeof keys === 'object') {
        return Object.values(keys).filter(Boolean).length;
    }
    return 0;
}

function gameDuration(game: PastGame): string | undefined {
    if (!game.startedAt || !game.finishedAt) {
        return undefined;
    }
    const ms = new Date(game.finishedAt).getTime() - new Date(game.startedAt).getTime();
    if (!Number.isFinite(ms) || ms <= 0) {
        return undefined;
    }
    return `${Math.max(1, Math.round(ms / 60000))} min`;
}

function MatchesSection(props: { username?: string }) {
    const [games, setGames] = useState<PastGame[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const load = useCallback(async () => {
        setLoading(true);
        setError(undefined);
        try {
            const result = await fetchMatchHistory();
            // Same filter as the web Matches page: proper two-player games only.
            setGames((result.games ?? []).filter((game) => game.players?.length === 2));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load match history');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    return (
        <FlatList
            data={games}
            keyExtractor={(game) => game.gameId}
            refreshControl={
                <RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.textDim} />
            }
            contentContainerStyle={{ padding: spacing.md }}
            ListHeaderComponent={<ErrorBanner message={error} />}
            renderItem={({ item }) => {
                const mine = item.players[0];
                const theirs = item.players[1];
                // players[].deck is the deck identity slug; the aligned decks[]
                // rows carry the display name (null when the deck was deleted
                // or is a standalone deck).
                const myDeck = item.decks?.[0]?.name ?? mine?.deck;
                const theirDeck = item.decks?.[1]?.name ?? theirs?.deck;
                const won = !!item.winner && item.winner === props.username;
                const myKeys = keyCount(mine?.keys);
                const oppKeys = keyCount(theirs?.keys);
                const duration = gameDuration(item);
                const when = item.finishedAt
                    ? new Date(item.finishedAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric'
                      })
                    : undefined;
                return (
                    <View style={styles.matchRow}>
                        <View
                            style={[
                                styles.matchOutcome,
                                { backgroundColor: won ? '#233a2a' : '#3a2326' }
                            ]}
                        >
                            <Text
                                style={[
                                    styles.matchOutcomeText,
                                    { color: won ? '#7ed494' : '#ff8f93' }
                                ]}
                            >
                                {won ? 'WIN' : 'LOSS'}
                            </Text>
                            <Text style={styles.matchKeys}>
                                {myKeys}–{oppKeys}
                            </Text>
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.matchOpponent} numberOfLines={1}>
                                vs {theirs?.name ?? 'unknown'}
                            </Text>
                            {myDeck || theirDeck ? (
                                <Text style={styles.matchDecks} numberOfLines={2}>
                                    {myDeck ?? 'unknown deck'} · {theirDeck ?? 'unknown deck'}
                                </Text>
                            ) : null}
                            <Text style={styles.matchMeta}>
                                {[
                                    item.gameFormat,
                                    when,
                                    duration,
                                    item.winReason && item.winReason !== 'keys'
                                        ? `by ${item.winReason}`
                                        : undefined
                                ]
                                    .filter(Boolean)
                                    .join(' · ')}
                            </Text>
                        </View>
                    </View>
                );
            }}
            ListEmptyComponent={
                loading ? (
                    <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.xl }} />
                ) : (
                    <EmptyState
                        title='No finished games yet'
                        subtitle='Your latest 30 finished games will show up here.'
                    />
                )
            }
        />
    );
}

// ---- Screen ----

type Section = 'rankings' | 'me' | 'matches';

export default function StatsScreen() {
    const username = useAuthStore((state) => state.user?.username);
    const [section, setSection] = useState<Section>('rankings');

    return (
        <View style={styles.container}>
            <SegmentBar<Section>
                options={[
                    { key: 'rankings', label: 'Rankings' },
                    { key: 'me', label: 'My stats' },
                    { key: 'matches', label: 'Matches' }
                ]}
                value={section}
                onChange={setSection}
            />
            {section === 'rankings' ? <RankingsSection username={username} /> : null}
            {section === 'me' ? <MyStatsSection username={username} /> : null}
            {section === 'matches' ? <MatchesSection username={username} /> : null}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    segmentRow: {
        flexDirection: 'row',
        margin: spacing.md,
        marginBottom: spacing.sm,
        backgroundColor: colors.bgElevated,
        borderRadius: 10,
        borderColor: colors.border,
        borderWidth: 1,
        padding: 3,
        gap: 3
    },
    segmentRowCompact: {
        marginTop: 0,
        marginBottom: 4
    },
    segment: {
        flex: 1,
        alignItems: 'center',
        paddingVertical: 8,
        borderRadius: 7
    },
    segmentCompact: {
        paddingVertical: 6
    },
    segmentActive: {
        backgroundColor: colors.surfaceHover
    },
    segmentText: {
        color: colors.textDim,
        fontSize: 13,
        fontWeight: '600'
    },
    segmentTextActive: {
        color: colors.text,
        fontWeight: '800'
    },
    rankRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 10,
        paddingHorizontal: spacing.md,
        paddingVertical: 9,
        marginBottom: 6
    },
    rankRowMe: {
        borderColor: colors.brand
    },
    rankNumber: {
        color: colors.textFaint,
        fontSize: 13,
        fontWeight: '800',
        minWidth: 34,
        fontVariant: ['tabular-nums']
    },
    rankName: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '700'
    },
    provisional: {
        color: colors.textFaint,
        fontSize: 11,
        fontWeight: '500'
    },
    rankRecord: {
        color: colors.textFaint,
        fontSize: 11,
        marginTop: 1
    },
    rankRating: {
        color: colors.brand,
        fontSize: 16,
        fontWeight: '900',
        fontVariant: ['tabular-nums']
    },
    loadMore: {
        alignItems: 'center',
        paddingVertical: spacing.md
    },
    loadMoreText: {
        color: colors.accent,
        fontWeight: '700',
        fontSize: 14
    },
    ratingHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between'
    },
    ratingPool: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '800',
        textTransform: 'capitalize'
    },
    ratingValue: {
        color: colors.brand,
        fontSize: 22,
        fontWeight: '900',
        fontVariant: ['tabular-nums']
    },
    ratingMeta: {
        color: colors.textDim,
        fontSize: 12,
        marginTop: 4
    },
    sectionTitle: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '800',
        marginBottom: 8
    },
    statGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.lg
    },
    statCell: {
        minWidth: 64
    },
    statValue: {
        color: colors.text,
        fontSize: 17,
        fontWeight: '800',
        fontVariant: ['tabular-nums']
    },
    statLabel: {
        color: colors.textFaint,
        fontSize: 11,
        marginTop: 2
    },
    tableRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingVertical: 7,
        borderTopColor: 'rgba(42, 54, 80, 0.5)',
        borderTopWidth: StyleSheet.hairlineWidth
    },
    tableName: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '600',
        flex: 1
    },
    tableMeta: {
        color: colors.textDim,
        fontSize: 12
    },
    matchRow: {
        flexDirection: 'row',
        gap: spacing.md,
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: spacing.md,
        marginBottom: 6
    },
    matchOutcome: {
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 10,
        paddingVertical: 6,
        minWidth: 56
    },
    matchOutcomeText: {
        fontSize: 12,
        fontWeight: '900'
    },
    matchKeys: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '800',
        marginTop: 2,
        fontVariant: ['tabular-nums']
    },
    matchOpponent: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '800'
    },
    matchDecks: {
        color: colors.textDim,
        fontSize: 12,
        marginTop: 2
    },
    matchMeta: {
        color: colors.textFaint,
        fontSize: 11,
        marginTop: 3,
        textTransform: 'capitalize'
    }
});
