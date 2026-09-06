import React, { useCallback, useEffect, useState } from 'react';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import {
    ActivityIndicator,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    View
} from 'react-native';
import { avatarUrl, fetchPlayerRatings, fetchPlayerStats } from '../../src/api/client';
import { fetchPlayerProfile, type PlayerProfile } from '../../src/api/community';
import type { PlayerRatingsResult, PlayerStatsResult } from '../../src/api/types';
import { ReportPlayerSheet } from '../../src/safety/ReportPlayerSheet';
import { sendFriendRequest } from '../../src/api/client';
import { useAuthStore } from '../../src/stores/authStore';
import { colors, radius, spacing } from '../../src/theme';
import { Button, Card, EmptyState, ErrorBanner } from '../../src/ui/primitives';

/**
 * ARCHON: a public player profile, which every username on the website links
 * to and the app had nowhere to send you.
 *
 * Three public endpoints, requested together: the profile header (avatar,
 * location, bio, clubs, recent games), the Amber ratings, and the win/loss
 * record. They are separate on the server because they are separate pages'
 * worth of data on the site; on a phone they are one screen, so a failure in
 * any one of them must not blank the other two.
 */

function joinedLabel(iso?: string): string | undefined {
    if (!iso) {
        return undefined;
    }
    const when = new Date(iso);

    return Number.isFinite(when.getTime())
        ? `Joined ${when.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`
        : undefined;
}

function locationLabel(profile?: PlayerProfile): string | undefined {
    const parts = [profile?.state, profile?.country].filter(Boolean);

    return parts.length ? parts.join(', ') : undefined;
}

export default function PlayerProfileScreen() {
    const { username } = useLocalSearchParams<{ username: string }>();
    const me = useAuthStore((state) => state.user?.username);

    const [profile, setProfile] = useState<PlayerProfile | undefined>();
    const [ratings, setRatings] = useState<PlayerRatingsResult | undefined>();
    const [stats, setStats] = useState<PlayerStatsResult | undefined>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [notice, setNotice] = useState<string | undefined>();
    const [reporting, setReporting] = useState(false);

    const load = useCallback(async () => {
        if (!username) {
            return;
        }
        setLoading(true);
        setError(undefined);

        // allSettled, not all: the ratings service answering slowly must not
        // cost the player their profile.
        const [profileResult, ratingsResult, statsResult] = await Promise.allSettled([
            fetchPlayerProfile(username),
            fetchPlayerRatings(username),
            fetchPlayerStats(username)
        ]);

        if (profileResult.status === 'fulfilled' && profileResult.value.profile) {
            setProfile(profileResult.value.profile);
        } else if (profileResult.status === 'rejected') {
            setError(
                profileResult.reason instanceof Error
                    ? profileResult.reason.message
                    : 'Could not load this player'
            );
        } else {
            setError(profileResult.value.message ?? 'No such player');
        }

        if (ratingsResult.status === 'fulfilled') {
            setRatings(ratingsResult.value);
        }
        if (statsResult.status === 'fulfilled') {
            setStats(statsResult.value);
        }

        setLoading(false);
    }, [username]);

    useEffect(() => {
        load();
    }, [load]);

    const isMe = !!me && me.toLowerCase() === String(username ?? '').toLowerCase();
    const avatar = avatarUrl(profile?.avatar);
    const location = locationLabel(profile);
    const joined = joinedLabel(profile?.joined);
    const archon = (ratings?.ratings ?? []).find((entry) => entry.pool === 'archon');
    const overall = stats?.stats?.overall;

    const addFriend = async () => {
        if (!username) {
            return;
        }
        setNotice(undefined);
        try {
            const result = await sendFriendRequest(username);
            setNotice(
                result.success
                    ? 'Friend request sent'
                    : result.message ?? 'Could not send that request'
            );
        } catch (err) {
            setNotice(err instanceof Error ? err.message : 'Could not send that request');
        }
    };

    return (
        <View style={styles.container}>
            <Stack.Screen options={{ title: String(username ?? 'Player') }} />
            <ScrollView
                contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
                refreshControl={
                    <RefreshControl
                        refreshing={loading}
                        onRefresh={load}
                        tintColor={colors.brand}
                    />
                }
            >
                <ErrorBanner message={error} />

                {!profile && loading ? (
                    <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.xl }} />
                ) : null}

                {profile ? (
                    <>
                        <Card style={{ marginBottom: spacing.md }}>
                            <View style={styles.identity}>
                                {avatar ? (
                                    <Image source={{ uri: avatar }} style={styles.avatar} />
                                ) : (
                                    <View style={[styles.avatar, styles.avatarEmpty]}>
                                        <Text style={styles.avatarInitial}>
                                            {profile.username.slice(0, 1).toUpperCase()}
                                        </Text>
                                    </View>
                                )}
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.username}>{profile.username}</Text>
                                    {profile.tierName ? (
                                        <Text style={styles.tier}>{profile.tierName}</Text>
                                    ) : null}
                                    {location ? (
                                        <Text style={styles.meta}>{location}</Text>
                                    ) : null}
                                    {joined ? <Text style={styles.meta}>{joined}</Text> : null}
                                </View>
                            </View>

                            {profile.bio ? <Text style={styles.bio}>{profile.bio}</Text> : null}

                            {!isMe ? (
                                <View style={styles.actions}>
                                    <Button
                                        small
                                        variant='secondary'
                                        title='Add friend'
                                        onPress={addFriend}
                                        style={{ flex: 1 }}
                                    />
                                    {/* The one place a conversation can be
                                        started from: every other route into
                                        messages is a reply to one. */}
                                    <Button
                                        small
                                        variant='secondary'
                                        title='Message'
                                        onPress={() =>
                                            router.push(
                                                `/messages/${encodeURIComponent(
                                                    profile.username
                                                )}`
                                            )
                                        }
                                        style={{ flex: 1 }}
                                    />
                                    <Button
                                        small
                                        variant='secondary'
                                        title='Report'
                                        onPress={() => setReporting(true)}
                                        style={{ flex: 1 }}
                                    />
                                </View>
                            ) : null}
                            {notice ? <Text style={styles.notice}>{notice}</Text> : null}
                        </Card>

                        {archon || overall ? (
                            <Card style={{ marginBottom: spacing.md }}>
                                <Text style={styles.sectionTitle}>Record</Text>
                                <View style={styles.statRow}>
                                    {archon ? (
                                        <View style={styles.stat}>
                                            <Text style={styles.statValue}>
                                                {Math.round(archon.rating)}
                                            </Text>
                                            <Text style={styles.statLabel}>Amber</Text>
                                        </View>
                                    ) : null}
                                    {typeof archon?.rank === 'number' ? (
                                        <View style={styles.stat}>
                                            <Text style={styles.statValue}>#{archon.rank}</Text>
                                            <Text style={styles.statLabel}>Rank</Text>
                                        </View>
                                    ) : null}
                                    {overall ? (
                                        <>
                                            <View style={styles.stat}>
                                                <Text style={styles.statValue}>
                                                    {overall.wins ?? 0}–{overall.losses ?? 0}
                                                </Text>
                                                <Text style={styles.statLabel}>W–L</Text>
                                            </View>
                                            {typeof overall.winRate === 'number' ? (
                                                <View style={styles.stat}>
                                                    <Text style={styles.statValue}>
                                                        {Math.round(overall.winRate)}%
                                                    </Text>
                                                    <Text style={styles.statLabel}>Win rate</Text>
                                                </View>
                                            ) : null}
                                        </>
                                    ) : null}
                                </View>
                            </Card>
                        ) : null}

                        {(profile.clubs ?? []).length > 0 ? (
                            <Card style={{ marginBottom: spacing.md }}>
                                <Text style={styles.sectionTitle}>Clubs</Text>
                                {(profile.clubs ?? []).map((club) => (
                                    <Pressable
                                        key={club.id}
                                        onPress={() => router.push(`/club/${club.id}`)}
                                        style={styles.linkRow}
                                    >
                                        <Text style={styles.linkText}>{club.name}</Text>
                                        {club.role && club.role !== 'member' ? (
                                            <Text style={styles.linkMeta}>{club.role}</Text>
                                        ) : null}
                                    </Pressable>
                                ))}
                            </Card>
                        ) : null}

                        <Card>
                            <Text style={styles.sectionTitle}>Recent games</Text>
                            {(profile.recentGames ?? []).length === 0 ? (
                                <Text style={styles.meta}>No finished games yet.</Text>
                            ) : (
                                (profile.recentGames ?? []).map((game, index) => (
                                    <View
                                        key={game.gameId ?? String(index)}
                                        style={styles.gameRow}
                                    >
                                        <Text
                                            style={[
                                                styles.gameResult,
                                                { color: game.won ? '#7ed494' : '#ff8f93' }
                                            ]}
                                        >
                                            {game.won ? 'W' : 'L'}
                                        </Text>
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.gameOpponent} numberOfLines={1}>
                                                vs {game.opponent ?? 'unknown'}
                                            </Text>
                                            {game.deckName ? (
                                                <Text style={styles.linkMeta} numberOfLines={1}>
                                                    {game.deckName}
                                                </Text>
                                            ) : null}
                                        </View>
                                        <Text style={styles.gameKeys}>
                                            {game.keys ?? 0}–{game.opponentKeys ?? 0}
                                        </Text>
                                    </View>
                                ))
                            )}
                        </Card>
                    </>
                ) : !loading && !error ? (
                    <EmptyState
                        title='No such player'
                        subtitle='Check the spelling and try again.'
                    />
                ) : null}
            </ScrollView>

            {reporting && username ? (
                <ReportPlayerSheet
                    visible
                    username={String(username)}
                    onClose={() => setReporting(false)}
                />
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    identity: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg
    },
    avatar: {
        width: 64,
        height: 64,
        borderRadius: 32,
        borderWidth: 2,
        borderColor: colors.border,
        backgroundColor: colors.bgElevated
    },
    avatarEmpty: {
        alignItems: 'center',
        justifyContent: 'center'
    },
    avatarInitial: {
        color: colors.textDim,
        fontSize: 26,
        fontWeight: '800'
    },
    username: {
        color: colors.text,
        fontSize: 20,
        fontWeight: '800'
    },
    tier: {
        color: colors.brand,
        fontSize: 12,
        fontWeight: '700',
        marginTop: 2
    },
    meta: {
        color: colors.textFaint,
        fontSize: 12,
        marginTop: 2
    },
    bio: {
        color: colors.textDim,
        fontSize: 14,
        lineHeight: 20,
        marginTop: spacing.md
    },
    actions: {
        flexDirection: 'row',
        gap: spacing.sm,
        marginTop: spacing.md
    },
    notice: {
        color: '#7ed494',
        fontSize: 12,
        marginTop: spacing.sm
    },
    sectionTitle: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
        marginBottom: spacing.sm
    },
    statRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.lg
    },
    stat: {
        alignItems: 'flex-start'
    },
    statValue: {
        color: colors.text,
        fontSize: 19,
        fontWeight: '800'
    },
    statLabel: {
        color: colors.textFaint,
        fontSize: 10,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.4
    },
    linkRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 7,
        borderTopColor: colors.border,
        borderTopWidth: StyleSheet.hairlineWidth
    },
    linkText: {
        color: colors.accent,
        fontSize: 14,
        fontWeight: '600'
    },
    linkMeta: {
        color: colors.textFaint,
        fontSize: 11
    },
    gameRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: 7,
        borderTopColor: colors.border,
        borderTopWidth: StyleSheet.hairlineWidth
    },
    gameResult: {
        fontSize: 15,
        fontWeight: '800',
        width: 18
    },
    gameOpponent: {
        color: colors.text,
        fontSize: 14
    },
    gameKeys: {
        color: colors.textDim,
        fontSize: 13,
        fontWeight: '700',
        fontVariant: ['tabular-nums']
    },
    empty: {
        color: colors.textFaint,
        fontSize: 13
    }
});
