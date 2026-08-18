import React, { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import {
    ActivityIndicator,
    FlatList,
    Pressable,
    RefreshControl,
    StyleSheet,
    Text,
    View
} from 'react-native';
import {
    fetchClubs,
    fetchMembers,
    fetchTeams,
    joinClubByCode,
    joinTeamByCode,
    type ClubSummary,
    type DirectoryMember,
    type TeamSummary
} from '../src/api/community';
import PlayerName from '../src/community/PlayerBadge';
import { colors, radius, spacing } from '../src/theme';
import { Button, EmptyState, ErrorBanner, TextField } from '../src/ui/primitives';

/**
 * ARCHON: the people section — the website's Community menu, folded onto one
 * screen.
 *
 * On the site these are four pages (Players, Leaderboards, Clubs, Teams). The
 * leaderboards already live on the Stats tab here, so this carries the three
 * that had nowhere to go. One screen with a segment bar rather than three
 * stack entries, because they are the same question asked three ways: who
 * else plays this.
 */

type Section = 'players' | 'clubs' | 'teams';

function SegmentBar(props: {
    value: Section;
    onChange: (value: Section) => void;
}) {
    const options: { key: Section; label: string }[] = [
        { key: 'players', label: 'Players' },
        { key: 'clubs', label: 'Clubs' },
        { key: 'teams', label: 'Teams' }
    ];

    return (
        <View style={styles.segmentRow}>
            {options.map((option) => {
                const active = props.value === option.key;

                return (
                    <Pressable
                        key={option.key}
                        onPress={() => props.onChange(option.key)}
                        style={[styles.segment, active && styles.segmentActive]}
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

function PlayersSection() {
    const [query, setQuery] = useState('');
    const [members, setMembers] = useState<DirectoryMember[]>([]);
    const [total, setTotal] = useState<number | undefined>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const load = useCallback(async (search: string) => {
        setLoading(true);
        setError(undefined);
        try {
            const result = await fetchMembers({ query: search || undefined, limit: 50 });
            setMembers(result.members ?? []);
            setTotal(result.stats?.total);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load the player list');
        } finally {
            setLoading(false);
        }
    }, []);

    // Debounced so typing a name is one request, not one per keystroke.
    useEffect(() => {
        const timer = setTimeout(() => load(query.trim()), query ? 300 : 0);

        return () => clearTimeout(timer);
    }, [load, query]);

    return (
        <FlatList
            data={members}
            keyExtractor={(member) => member.username}
            contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
            refreshControl={
                <RefreshControl
                    refreshing={loading}
                    onRefresh={() => load(query.trim())}
                    tintColor={colors.brand}
                />
            }
            ListHeaderComponent={
                <View>
                    <ErrorBanner message={error} />
                    <TextField
                        placeholder='Search players'
                        value={query}
                        onChangeText={setQuery}
                    />
                    {typeof total === 'number' ? (
                        <Text style={styles.summary}>
                            {total.toLocaleString()} players registered
                        </Text>
                    ) : null}
                </View>
            }
            renderItem={({ item }) => (
                <Pressable
                    onPress={() =>
                        router.push(`/players/${encodeURIComponent(item.username)}`)
                    }
                    style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
                >
                    <View style={{ flex: 1 }}>
                        <PlayerName username={item.username} linked={false} />
                        <Text style={styles.rowMeta}>
                            {[
                                [item.state, item.country].filter(Boolean).join(', ') || undefined,
                                typeof item.gamesPlayed === 'number' && item.gamesPlayed > 0
                                    ? `${item.gamesPlayed} rated games`
                                    : undefined
                            ]
                                .filter(Boolean)
                                .join(' · ')}
                        </Text>
                    </View>
                    {typeof item.rating === 'number' ? (
                        <Text style={styles.rowValue}>{Math.round(item.rating)}</Text>
                    ) : null}
                </Pressable>
            )}
            ListEmptyComponent={
                loading ? null : (
                    <EmptyState
                        title={query ? `Nobody matches “${query}”` : 'No players listed'}
                        subtitle='Only accounts that have verified their email appear here.'
                    />
                )
            }
        />
    );
}

function ClubsSection() {
    const [query, setQuery] = useState('');
    const [clubs, setClubs] = useState<ClubSummary[]>([]);
    const [code, setCode] = useState('');
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [notice, setNotice] = useState<string | undefined>();

    const load = useCallback(async (search: string) => {
        setLoading(true);
        setError(undefined);
        try {
            const result = await fetchClubs(search || undefined);
            setClubs(result.clubs ?? []);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load clubs');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => load(query.trim()), query ? 300 : 0);

        return () => clearTimeout(timer);
    }, [load, query]);

    const redeem = async () => {
        const trimmed = code.trim();
        if (!trimmed) {
            return;
        }
        setBusy(true);
        setNotice(undefined);
        setError(undefined);
        try {
            const result = await joinClubByCode(trimmed);
            if (!result.success) {
                setError(result.message ?? 'That code did not work');
                return;
            }
            setCode('');
            setNotice('Joined');
            if (result.clubId) {
                router.push(`/club/${result.clubId}`);
            } else {
                load(query.trim());
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'That code did not work');
        } finally {
            setBusy(false);
        }
    };

    return (
        <FlatList
            data={clubs}
            keyExtractor={(club) => String(club.id)}
            contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
            refreshControl={
                <RefreshControl
                    refreshing={loading}
                    onRefresh={() => load(query.trim())}
                    tintColor={colors.brand}
                />
            }
            ListHeaderComponent={
                <View>
                    <ErrorBanner message={error} />
                    <TextField
                        placeholder='Search clubs'
                        value={query}
                        onChangeText={setQuery}
                    />
                    <View style={styles.codeRow}>
                        <TextField
                            placeholder='Join code'
                            value={code}
                            onChangeText={setCode}
                            autoCapitalize='characters'
                            containerStyle={{ flex: 1, marginBottom: 0 }}
                        />
                        <Button title='Join' onPress={redeem} loading={busy} />
                    </View>
                    {notice ? <Text style={styles.notice}>{notice}</Text> : null}
                </View>
            }
            renderItem={({ item }) => (
                <Pressable
                    onPress={() => router.push(`/club/${item.id}`)}
                    style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
                >
                    <View style={{ flex: 1 }}>
                        <Text style={styles.rowTitle}>{item.name}</Text>
                        {item.description ? (
                            <Text style={styles.rowMeta} numberOfLines={2}>
                                {item.description}
                            </Text>
                        ) : null}
                        <Text style={styles.rowMeta}>
                            {[
                                item.owner ? `run by ${item.owner}` : undefined,
                                item.joinPolicy === 'open'
                                    ? 'open to all'
                                    : item.joinPolicy === 'request'
                                    ? 'apply to join'
                                    : 'invite only'
                            ]
                                .filter(Boolean)
                                .join(' · ')}
                        </Text>
                    </View>
                    <Text style={styles.rowValue}>{item.memberCount ?? 0}</Text>
                </Pressable>
            )}
            ListEmptyComponent={
                loading ? null : (
                    <EmptyState
                        title='No clubs yet'
                        subtitle='A club is a group of players with its own board and leaderboard.'
                    />
                )
            }
        />
    );
}

function TeamsSection() {
    const [query, setQuery] = useState('');
    const [teams, setTeams] = useState<TeamSummary[]>([]);
    const [code, setCode] = useState('');
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const load = useCallback(async (search: string) => {
        setLoading(true);
        setError(undefined);
        try {
            const result = await fetchTeams(search || undefined);
            setTeams(result.teams ?? []);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load teams');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => load(query.trim()), query ? 300 : 0);

        return () => clearTimeout(timer);
    }, [load, query]);

    const redeem = async () => {
        const trimmed = code.trim();
        if (!trimmed) {
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            const result = await joinTeamByCode(trimmed);
            if (!result.success) {
                setError(result.message ?? 'That code did not work');
                return;
            }
            setCode('');
            if (result.teamId) {
                router.push(`/team/${result.teamId}`);
            } else {
                load(query.trim());
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'That code did not work');
        } finally {
            setBusy(false);
        }
    };

    return (
        <FlatList
            data={teams}
            keyExtractor={(team) => String(team.id)}
            contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
            refreshControl={
                <RefreshControl
                    refreshing={loading}
                    onRefresh={() => load(query.trim())}
                    tintColor={colors.brand}
                />
            }
            ListHeaderComponent={
                <View>
                    <ErrorBanner message={error} />
                    <TextField placeholder='Search teams' value={query} onChangeText={setQuery} />
                    <View style={styles.codeRow}>
                        <TextField
                            placeholder='Join code'
                            value={code}
                            onChangeText={setCode}
                            autoCapitalize='characters'
                            containerStyle={{ flex: 1, marginBottom: 0 }}
                        />
                        <Button title='Join' onPress={redeem} loading={busy} />
                    </View>
                </View>
            }
            renderItem={({ item }) => (
                <Pressable
                    onPress={() => router.push(`/team/${item.id}`)}
                    style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
                >
                    <View style={{ flex: 1 }}>
                        <Text style={styles.rowTitle}>{item.name}</Text>
                        <Text style={styles.rowMeta}>
                            {[
                                item.captain ? `captained by ${item.captain}` : undefined,
                                item.clubName,
                                `${item.memberCount ?? 0} member${
                                    item.memberCount === 1 ? '' : 's'
                                }`
                            ]
                                .filter(Boolean)
                                .join(' · ')}
                        </Text>
                    </View>
                    {typeof item.rating === 'number' ? (
                        <Text style={styles.rowValue}>{Math.round(item.rating)}</Text>
                    ) : null}
                </Pressable>
            )}
            ListEmptyComponent={
                loading ? null : (
                    <EmptyState
                        title='No teams yet'
                        subtitle='Teams enter events as a unit and carry their own rating.'
                    />
                )
            }
        />
    );
}

export default function CommunityScreen() {
    const [section, setSection] = useState<Section>('players');

    return (
        <View style={styles.container}>
            <SegmentBar value={section} onChange={setSection} />
            {section === 'players' ? <PlayersSection /> : null}
            {section === 'clubs' ? <ClubsSection /> : null}
            {section === 'teams' ? <TeamsSection /> : null}
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
    segment: {
        flex: 1,
        alignItems: 'center',
        paddingVertical: 8,
        borderRadius: 7
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
        color: colors.brand
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.lg,
        padding: spacing.md,
        marginBottom: spacing.sm
    },
    rowTitle: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700'
    },
    rowMeta: {
        color: colors.textFaint,
        fontSize: 12,
        marginTop: 2
    },
    rowValue: {
        color: colors.brand,
        fontSize: 16,
        fontWeight: '800'
    },
    summary: {
        color: colors.textFaint,
        fontSize: 12,
        marginBottom: spacing.sm
    },
    codeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginBottom: spacing.md
    },
    notice: {
        color: '#7ed494',
        fontSize: 12,
        marginBottom: spacing.sm
    }
});
