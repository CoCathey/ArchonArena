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
import {
    fetchMyMatches,
    fetchTournaments,
    type OpenMatch,
    type TournamentSummary
} from '../../src/api/tournaments';
import {
    actionLabel,
    localTime,
    relativeTime,
    statusLabel,
    tournamentFormatLabel
} from '../../src/tournaments/format';
import { useAuthStore } from '../../src/stores/authStore';
import { colors, radius, spacing } from '../../src/theme';
import { Button, EmptyState, ErrorBanner } from '../../src/ui/primitives';

const FILTERS = [
    { key: 'open', label: 'Open' },
    { key: 'active', label: 'Running' },
    { key: 'complete', label: 'Finished' }
] as const;

type FilterKey = (typeof FILTERS)[number]['key'];

/** The list endpoint's status filter for each tab. */
const STATUS_FOR: Record<FilterKey, string> = {
    open: 'registration',
    active: 'active',
    complete: 'complete'
};

function MatchCard(props: { match: OpenMatch }) {
    const { match } = props;
    const when = localTime(match.scheduledAt ?? match.proposedTime);
    const relative = relativeTime(match.scheduledAt ?? match.proposedTime);
    const deadline = relativeTime(match.roundEndsAt);
    // Anything waiting on this player is worth colouring; anything waiting on
    // the opponent is not.
    const mine = match.needsAction === 'respond' || match.needsAction === 'propose';

    return (
        <Pressable
            onPress={() => router.push(`/tournament/${match.tournamentId}`)}
            style={({ pressed }) => [
                styles.matchCard,
                mine && { borderColor: colors.brand },
                pressed && { opacity: 0.7 }
            ]}
        >
            <View style={styles.matchTop}>
                <Text style={styles.matchEvent} numberOfLines={1}>
                    {match.tournamentName}
                </Text>
                <Text style={[styles.matchAction, mine && { color: colors.brand }]}>
                    {actionLabel(match)}
                </Text>
            </View>
            <Text style={styles.matchOpponent} numberOfLines={1}>
                Round {match.round} · {match.opponent ? `vs ${match.opponent}` : 'Bye'}
            </Text>
            {when ? (
                <Text style={styles.matchWhen}>
                    {when}
                    {relative ? ` · ${relative}` : ''}
                </Text>
            ) : deadline ? (
                <Text style={styles.matchWhen}>Round ends {deadline}</Text>
            ) : null}
        </Pressable>
    );
}

function TournamentRow(props: { event: TournamentSummary }) {
    const { event } = props;
    const start = localTime(event.startTime);
    const bounded = typeof event.sasMin === 'number' || typeof event.sasMax === 'number';

    return (
        <Pressable
            onPress={() => router.push(`/tournament/${event.id}`)}
            style={({ pressed }) => [styles.eventRow, pressed && { opacity: 0.7 }]}
        >
            <View style={{ flex: 1 }}>
                <Text style={styles.eventName} numberOfLines={2}>
                    {event.name}
                </Text>
                <Text style={styles.eventMeta} numberOfLines={1}>
                    {tournamentFormatLabel(event.format)}
                    {event.pacing === 'async' ? ' · async' : ''}
                    {event.rated ? ' · rated' : ''}
                    {typeof event.playerCount === 'number'
                        ? ` · ${event.playerCount}${event.playerCap ? `/${event.playerCap}` : ''} players`
                        : ''}
                </Text>
                <View style={styles.badgeRow}>
                    <Text style={styles.statusBadge}>{statusLabel(event)}</Text>
                    {bounded ? (
                        <Text style={styles.badge}>
                            SAS {event.sasMin ?? '–'}–{event.sasMax ?? '–'}
                        </Text>
                    ) : null}
                    {event.entryFeeCents ? (
                        <Text style={styles.badge}>
                            {(event.entryFeeCents / 100).toFixed(2)} {event.prizeCurrency ?? 'USD'}
                        </Text>
                    ) : null}
                </View>
                {start ? <Text style={styles.eventStart}>Starts {start}</Text> : null}
            </View>
        </Pressable>
    );
}

export default function TournamentsScreen() {
    const username = useAuthStore((state) => state.user?.username);
    const [filter, setFilter] = useState<FilterKey>('open');
    const [events, setEvents] = useState<TournamentSummary[]>([]);
    const [matches, setMatches] = useState<OpenMatch[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const load = useCallback(async () => {
        setLoading(true);
        setError(undefined);
        try {
            // The two are independent; a failure to load one should not blank
            // the other.
            const [list, mine] = await Promise.allSettled([
                fetchTournaments(STATUS_FOR[filter]),
                fetchMyMatches()
            ]);

            if (list.status === 'fulfilled') {
                setEvents(list.value.tournaments ?? []);
            }
            if (mine.status === 'fulfilled') {
                setMatches(mine.value.matches ?? []);
            }
            if (list.status === 'rejected') {
                setError(
                    list.reason instanceof Error
                        ? list.reason.message
                        : 'Could not load tournaments'
                );
            }
        } finally {
            setLoading(false);
        }
    }, [filter]);

    useEffect(() => {
        load();
    }, [load]);

    return (
        <ScrollView
            style={styles.container}
            contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
            refreshControl={
                <RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.textDim} />
            }
        >
            <ErrorBanner message={error} />

            {matches.length > 0 ? (
                <View style={{ marginBottom: spacing.lg }}>
                    <Text style={styles.sectionTitle}>Your matches</Text>
                    {matches.map((match) => (
                        <MatchCard key={`${match.tournamentId}-${match.matchId}`} match={match} />
                    ))}
                </View>
            ) : null}

            <View style={styles.headerRow}>
                <View style={styles.filterRow}>
                    {FILTERS.map((option) => (
                        <Pressable
                            key={option.key}
                            onPress={() => setFilter(option.key)}
                            style={[
                                styles.filterChip,
                                filter === option.key && styles.filterChipActive
                            ]}
                        >
                            <Text
                                style={[
                                    styles.filterText,
                                    filter === option.key && styles.filterTextActive
                                ]}
                            >
                                {option.label}
                            </Text>
                        </Pressable>
                    ))}
                </View>
                {username ? (
                    <Button
                        small
                        title='New'
                        onPress={() => router.push('/tournament/new')}
                    />
                ) : null}
            </View>

            {events.map((event) => (
                <TournamentRow key={event.id} event={event} />
            ))}

            {events.length === 0 ? (
                loading ? (
                    <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.xl }} />
                ) : (
                    <EmptyState
                        title={
                            filter === 'open'
                                ? 'No events taking registrations'
                                : filter === 'active'
                                ? 'Nothing running right now'
                                : 'No finished events yet'
                        }
                        subtitle={
                            filter === 'open' && username
                                ? 'Create one with the button above.'
                                : undefined
                        }
                    />
                )
            ) : null}
        </ScrollView>
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
        fontWeight: '800',
        marginBottom: spacing.sm
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.sm,
        marginBottom: spacing.md
    },
    filterRow: {
        flexDirection: 'row',
        gap: spacing.sm,
        flex: 1
    },
    filterChip: {
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: 13,
        paddingVertical: 6
    },
    filterChipActive: {
        backgroundColor: colors.brand,
        borderColor: colors.brand
    },
    filterText: {
        color: colors.textDim,
        fontSize: 12,
        fontWeight: '700'
    },
    filterTextActive: {
        color: '#161006'
    },
    matchCard: {
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.lg,
        padding: spacing.md,
        marginBottom: spacing.sm
    },
    matchTop: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.sm
    },
    matchEvent: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '800',
        flex: 1
    },
    matchAction: {
        color: colors.textDim,
        fontSize: 11,
        fontWeight: '700'
    },
    matchOpponent: {
        color: colors.textDim,
        fontSize: 13,
        marginTop: 4
    },
    matchWhen: {
        color: colors.textFaint,
        fontSize: 11,
        marginTop: 3
    },
    eventRow: {
        flexDirection: 'row',
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.lg,
        padding: spacing.md,
        marginBottom: spacing.sm
    },
    eventName: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700'
    },
    eventMeta: {
        color: colors.textDim,
        fontSize: 12,
        marginTop: 3,
        textTransform: 'capitalize'
    },
    badgeRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
        marginTop: 7
    },
    statusBadge: {
        color: colors.brand,
        fontSize: 10,
        fontWeight: '800',
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: 8,
        paddingVertical: 3,
        overflow: 'hidden'
    },
    badge: {
        color: colors.textDim,
        fontSize: 10,
        fontWeight: '700',
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: 8,
        paddingVertical: 3,
        overflow: 'hidden'
    },
    eventStart: {
        color: colors.textFaint,
        fontSize: 11,
        marginTop: 6
    }
});
