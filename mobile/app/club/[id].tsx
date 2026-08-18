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
    fetchClub,
    fetchClubLeaderboard,
    joinClub,
    leaveClub,
    type ClubDetail,
    type ClubLeaderboardRow,
    type ClubMember
} from '../../src/api/community';
import PlayerName from '../../src/community/PlayerBadge';
import { colors, radius, spacing } from '../../src/theme';
import { Button, Card, ErrorBanner } from '../../src/ui/primitives';

/**
 * ARCHON (N7): one club — the Grand Alliance Council on the website.
 *
 * Membership actions are the joiner's half only: join, apply, leave, and
 * accepting an invitation. Running a club (approving applicants, inviting,
 * transferring, disbanding) stays on the site — those are desk jobs, and a
 * phone is where you join something somebody told you about.
 */

function joinLabel(club: ClubDetail): string | undefined {
    if (club.isOwner || club.isMember) {
        return undefined;
    }
    if (club.isPending) {
        return 'Application sent';
    }
    if (club.isInvited) {
        return 'Accept invitation';
    }

    return club.joinPolicy === 'request' ? 'Apply to join' : 'Join club';
}

export default function ClubDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();

    const [club, setClub] = useState<ClubDetail | undefined>();
    const [members, setMembers] = useState<ClubMember[]>([]);
    const [leaderboard, setLeaderboard] = useState<ClubLeaderboardRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const load = useCallback(async () => {
        if (!id) {
            return;
        }
        setLoading(true);
        setError(undefined);

        const [detail, board] = await Promise.allSettled([
            fetchClub(id),
            fetchClubLeaderboard(id)
        ]);

        if (detail.status === 'fulfilled') {
            if (detail.value.club) {
                setClub(detail.value.club);
                setMembers(detail.value.members ?? []);
            } else {
                setError(detail.value.message ?? 'No such club');
            }
        } else {
            setError(
                detail.reason instanceof Error ? detail.reason.message : 'Could not load this club'
            );
        }

        // The board is a bonus panel; a club that has played no rated games
        // still has a page.
        if (board.status === 'fulfilled') {
            setLeaderboard(board.value.leaderboard ?? []);
        }

        setLoading(false);
    }, [id]);

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

    const confirmLeave = () => {
        if (!club) {
            return;
        }
        Alert.alert('Leave club', `Leave ${club.name}?`, [
            { text: 'Stay', style: 'cancel' },
            {
                text: 'Leave',
                style: 'destructive',
                onPress: () => act(() => leaveClub(club.id))
            }
        ]);
    };

    const cta = club ? joinLabel(club) : undefined;

    return (
        <View style={styles.container}>
            <Stack.Screen options={{ title: club?.name ?? 'Club' }} />
            <ScrollView
                contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
                refreshControl={
                    <RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.brand} />
                }
            >
                <ErrorBanner message={error} />

                {!club && loading ? (
                    <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.xl }} />
                ) : null}

                {club ? (
                    <>
                        <Card style={{ marginBottom: spacing.md }}>
                            <Text style={styles.name}>{club.name}</Text>
                            {club.description ? (
                                <Text style={styles.description}>{club.description}</Text>
                            ) : null}
                            <Text style={styles.meta}>
                                {[
                                    `${members.length} member${members.length === 1 ? '' : 's'}`,
                                    club.joinPolicy === 'open'
                                        ? 'open to all'
                                        : club.joinPolicy === 'request'
                                        ? 'apply to join'
                                        : 'invite only'
                                ].join(' · ')}
                            </Text>

                            {club.joinCode ? (
                                <View style={styles.codeBox}>
                                    <Text style={styles.codeLabel}>Join code</Text>
                                    <Text selectable style={styles.code}>
                                        {club.joinCode}
                                    </Text>
                                </View>
                            ) : null}

                            <View style={styles.actions}>
                                {cta ? (
                                    <Button
                                        title={cta}
                                        loading={busy}
                                        disabled={club.isPending}
                                        onPress={() => act(() => joinClub(club.id))}
                                        style={{ flex: 1 }}
                                    />
                                ) : null}
                                {club.isMember && !club.isOwner ? (
                                    <Button
                                        variant='secondary'
                                        title='Leave'
                                        loading={busy}
                                        onPress={confirmLeave}
                                        style={{ flex: 1 }}
                                    />
                                ) : null}
                            </View>
                            {club.isOwner ? (
                                <Text style={styles.ownerNote}>
                                    You run this club. Approving applicants, inviting players and
                                    club settings are on the website.
                                </Text>
                            ) : null}
                        </Card>

                        {leaderboard.length > 0 ? (
                            <Card style={{ marginBottom: spacing.md }}>
                                <Text style={styles.sectionTitle}>Club leaderboard</Text>
                                {leaderboard.map((row, index) => (
                                    <View key={row.username} style={styles.row}>
                                        <Text style={styles.rank}>{row.rank ?? index + 1}</Text>
                                        <View style={{ flex: 1 }}>
                                            <PlayerName username={row.username} />
                                        </View>
                                        {typeof row.rating === 'number' ? (
                                            <Text style={styles.value}>
                                                {Math.round(row.rating)}
                                            </Text>
                                        ) : null}
                                    </View>
                                ))}
                            </Card>
                        ) : null}

                        <Card>
                            <Text style={styles.sectionTitle}>Members</Text>
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
    actions: {
        flexDirection: 'row',
        gap: spacing.sm,
        marginTop: spacing.md
    },
    ownerNote: {
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
    rank: {
        color: colors.textFaint,
        fontSize: 12,
        fontWeight: '800',
        width: 22
    },
    value: {
        color: colors.brand,
        fontSize: 14,
        fontWeight: '800'
    },
    role: {
        color: colors.textFaint,
        fontSize: 11,
        textTransform: 'uppercase',
        fontWeight: '700'
    }
});
