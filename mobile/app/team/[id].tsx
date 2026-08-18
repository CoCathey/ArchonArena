import React, { useCallback, useEffect, useState } from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import {
    ActivityIndicator,
    Alert,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    View
} from 'react-native';
import {
    fetchTeam,
    leaveTeam,
    type TeamDetail,
    type TeamMember
} from '../../src/api/community';
import PlayerName from '../../src/community/PlayerBadge';
import { colors, radius, spacing } from '../../src/theme';
import { Button, Card, ErrorBanner } from '../../src/ui/primitives';

/**
 * ARCHON (N7): one team — a roster that enters events as a unit and carries
 * its own rating per pool.
 *
 * Joining is by code only, which is the server's rule and not a shortcut: a
 * team is assembled by its captain rather than browsed into. The code lives
 * here for the captain to read out.
 */
export default function TeamDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();

    const [team, setTeam] = useState<TeamDetail | undefined>();
    const [members, setMembers] = useState<TeamMember[]>([]);
    const [ratings, setRatings] = useState<
        { pool: string; rating: number; gamesPlayed?: number }[]
    >([]);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const load = useCallback(async () => {
        if (!id) {
            return;
        }
        setLoading(true);
        setError(undefined);
        try {
            const result = await fetchTeam(id);
            if (!result.team) {
                setError(result.message ?? 'No such team');
            } else {
                setTeam(result.team);
                setMembers(result.members ?? []);
                setRatings(result.ratings ?? []);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load this team');
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        load();
    }, [load]);

    const confirmLeave = () => {
        if (!team) {
            return;
        }
        Alert.alert('Leave team', `Leave ${team.name}?`, [
            { text: 'Stay', style: 'cancel' },
            {
                text: 'Leave',
                style: 'destructive',
                onPress: async () => {
                    setBusy(true);
                    try {
                        const result = await leaveTeam(team.id);
                        if (!result.success) {
                            setError(result.message ?? 'Could not leave this team');
                            return;
                        }
                        await load();
                    } catch (err) {
                        setError(
                            err instanceof Error ? err.message : 'Could not leave this team'
                        );
                    } finally {
                        setBusy(false);
                    }
                }
            }
        ]);
    };

    return (
        <View style={styles.container}>
            <Stack.Screen options={{ title: team?.name ?? 'Team' }} />
            <ScrollView
                contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
                refreshControl={
                    <RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.brand} />
                }
            >
                <ErrorBanner message={error} />

                {!team && loading ? (
                    <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.xl }} />
                ) : null}

                {team ? (
                    <>
                        <Card style={{ marginBottom: spacing.md }}>
                            <Text style={styles.name}>{team.name}</Text>
                            {team.description ? (
                                <Text style={styles.description}>{team.description}</Text>
                            ) : null}
                            <Text style={styles.meta}>
                                {[
                                    team.captain ? `captained by ${team.captain}` : undefined,
                                    team.clubName,
                                    `${members.length} member${members.length === 1 ? '' : 's'}`
                                ]
                                    .filter(Boolean)
                                    .join(' · ')}
                            </Text>

                            {ratings.length > 0 ? (
                                <View style={styles.ratingRow}>
                                    {ratings.map((rating) => (
                                        <View key={rating.pool} style={styles.rating}>
                                            <Text style={styles.ratingValue}>
                                                {Math.round(rating.rating)}
                                            </Text>
                                            <Text style={styles.ratingLabel}>{rating.pool}</Text>
                                        </View>
                                    ))}
                                </View>
                            ) : null}

                            {team.joinCode ? (
                                <View style={styles.codeBox}>
                                    <Text style={styles.codeLabel}>Join code</Text>
                                    <Text selectable style={styles.code}>
                                        {team.joinCode}
                                    </Text>
                                </View>
                            ) : null}

                            {team.isMember && !team.isCaptain ? (
                                <Button
                                    variant='secondary'
                                    title='Leave team'
                                    loading={busy}
                                    onPress={confirmLeave}
                                    style={{ marginTop: spacing.md }}
                                />
                            ) : null}
                            {team.isCaptain ? (
                                <Text style={styles.captainNote}>
                                    You captain this team. Removing members, transferring the
                                    captaincy and disbanding are on the website.
                                </Text>
                            ) : null}
                        </Card>

                        <Card>
                            <Text style={styles.sectionTitle}>Roster</Text>
                            {members.length === 0 ? (
                                <Text style={styles.meta}>Nobody has joined yet.</Text>
                            ) : (
                                members.map((member) => (
                                    <View key={member.userId} style={styles.row}>
                                        <View style={{ flex: 1 }}>
                                            <PlayerName username={member.username} />
                                        </View>
                                        {member.role && member.role !== 'member' ? (
                                            <Text style={styles.role}>{member.role}</Text>
                                        ) : null}
                                    </View>
                                ))
                            )}
                        </Card>
                    </>
                ) : null}
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    name: {
        color: colors.text,
        fontSize: 19,
        fontWeight: '800'
    },
    description: {
        color: colors.textDim,
        fontSize: 14,
        lineHeight: 20,
        marginTop: 6
    },
    meta: {
        color: colors.textFaint,
        fontSize: 12,
        marginTop: 6
    },
    ratingRow: {
        flexDirection: 'row',
        gap: spacing.lg,
        marginTop: spacing.md
    },
    rating: {
        alignItems: 'flex-start'
    },
    ratingValue: {
        color: colors.brand,
        fontSize: 18,
        fontWeight: '800'
    },
    ratingLabel: {
        color: colors.textFaint,
        fontSize: 10,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.4
    },
    codeBox: {
        marginTop: spacing.md,
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        padding: spacing.md
    },
    codeLabel: {
        color: colors.textFaint,
        fontSize: 10,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.5
    },
    code: {
        color: colors.brand,
        fontSize: 18,
        fontWeight: '800',
        letterSpacing: 1,
        marginTop: 3
    },
    captainNote: {
        color: colors.textFaint,
        fontSize: 11,
        lineHeight: 16,
        marginTop: spacing.sm
    },
    sectionTitle: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
        marginBottom: spacing.sm
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: 7,
        borderTopColor: colors.border,
        borderTopWidth: StyleSheet.hairlineWidth
    },
    role: {
        color: colors.textFaint,
        fontSize: 11,
        textTransform: 'uppercase',
        fontWeight: '700'
    }
});
