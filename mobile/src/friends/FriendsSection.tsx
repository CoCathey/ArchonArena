import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, Keyboard, StyleSheet, Text, View } from 'react-native';
import type { Friend, GameSummary } from '../api/types';
import { removeFriend, respondToFriendRequest, sendFriendRequest } from '../api/client';
import { lobby } from '../net/lobbySocket';
import { useAuthStore } from '../stores/authStore';
import { useFriendsStore } from '../stores/friendsStore';
import { useLobbyStore } from '../stores/lobbyStore';
import { colors, radius, spacing } from '../theme';
import { Button, Card, EmptyState, ErrorBanner, TextField } from '../ui/primitives';
import { ReportPlayerButton } from '../safety/ReportPlayerSheet';

/**
 * ARCHON: friends, as a section of the Profile tab rather than a tab of its own.
 *
 * It was a sixth tab, and a phone tab bar only reads at about five - the labels
 * were already truncating. Friends is also the least frequent of the six: you
 * add somebody once and then glance at who is online, which is a thing you do
 * while you are already looking at your own account.
 *
 * Written as a section, not a screen: it renders bare Cards and lets whatever
 * hosts it own the ScrollView. Profile already has one, and nesting a second
 * scroller inside it would fight the outer one for every drag.
 */

/** What a friend is up to right now, derived from the live lobby lists. */
interface Presence {
    online: boolean;
    game?: GameSummary;
    /** They are in a game we could sit down in. */
    joinable?: boolean;
    /** They are in a running game we could spectate. */
    watchable?: boolean;
}

function Dot(props: { online: boolean }) {
    return (
        <View
            style={[styles.dot, { backgroundColor: props.online ? colors.success : colors.border }]}
        />
    );
}

function SectionLabel(props: { children: string }) {
    return <Text style={styles.sectionLabel}>{props.children}</Text>;
}

function FriendRow(props: {
    friend: Friend;
    presence: Presence;
    removing: boolean;
    onOpenGame: (presence: Presence) => void;
    onRemove: (friend: Friend) => void;
}) {
    const { friend, presence } = props;
    return (
        <View style={styles.row}>
            <Dot online={presence.online} />
            <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={1}>
                    {friend.username}
                </Text>
                <Text style={styles.status} numberOfLines={1}>
                    {presence.game
                        ? presence.game.started
                            ? `Playing · ${presence.game.name}`
                            : `Waiting in · ${presence.game.name}`
                        : presence.online
                        ? 'In the lobby'
                        : 'Offline'}
                </Text>
            </View>
            {presence.joinable ? (
                <Button small title='Join' onPress={() => props.onOpenGame(presence)} />
            ) : presence.watchable ? (
                <Button
                    small
                    variant='secondary'
                    title='Watch'
                    onPress={() => props.onOpenGame(presence)}
                />
            ) : null}
            <Button
                small
                variant='ghost'
                title='Remove'
                loading={props.removing}
                onPress={() => props.onRemove(friend)}
            />
            {/* Guideline 1.2: reporting and blocking have to be reachable from
                wherever you can see another player, not buried in settings. */}
            <ReportPlayerButton username={friend.username} />
        </View>
    );
}

export function FriendsSection() {
    const username = useAuthStore((state) => state.user?.username);
    const friends = useFriendsStore((state) => state.friends);
    const incoming = useFriendsStore((state) => state.incoming);
    const outgoing = useFriendsStore((state) => state.outgoing);
    const loading = useFriendsStore((state) => state.loading);
    const loaded = useFriendsStore((state) => state.loaded);
    const loadError = useFriendsStore((state) => state.error);
    const load = useFriendsStore((state) => state.load);

    const onlineUsers = useLobbyStore((state) => state.users);
    const games = useLobbyStore((state) => state.games);

    const [addName, setAddName] = useState('');
    const [busy, setBusy] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [notice, setNotice] = useState<string | undefined>();

    useEffect(() => {
        load();
    }, [load]);

    // Presence and "what game are they in" both come from the lobby socket the
    // app already holds open, so this costs nothing extra.
    const presenceFor = useMemo(() => {
        const online = new Set((onlineUsers ?? []).map((entry) => entry.name));
        const byPlayer = new Map<string, GameSummary>();
        for (const game of games ?? []) {
            for (const player of Object.values(game.players ?? {})) {
                byPlayer.set(player.name, game);
            }
        }

        return (name: string): Presence => {
            const game = byPlayer.get(name);
            if (!game) {
                return { online: online.has(name) };
            }
            const players = Object.values(game.players ?? {});
            const iAmIn = players.some((player) => player.name === username);
            return {
                online: online.has(name),
                game,
                joinable: !game.started && players.length < 2 && !iAmIn,
                watchable: !!game.started && !!game.allowSpectators && !iAmIn
            };
        };
    }, [games, onlineUsers, username]);

    /**
     * Run one friend action, then refresh so the three lists stay in step.
     * Resolves to whether it worked, since the caller may want to clear a
     * field only on success.
     */
    const act = useCallback(
        async (
            key: string,
            action: () => Promise<{ success: boolean; message?: string }>,
            success?: string
        ): Promise<boolean> => {
            setBusy(key);
            setError(undefined);
            setNotice(undefined);
            try {
                const result = await action();
                if (!result.success) {
                    setError(result.message ?? 'That did not work. Try again.');
                    return false;
                }
                if (success) {
                    setNotice(success);
                }
                await load();
                return true;
            } catch (err) {
                setError(err instanceof Error ? err.message : 'That did not work. Try again.');
                return false;
            } finally {
                setBusy(undefined);
            }
        },
        [load]
    );

    const add = async () => {
        const name = addName.trim();
        if (!name) {
            return;
        }
        Keyboard.dismiss();
        // Keep what they typed if the name was wrong — retyping a username to
        // fix one letter is a needless annoyance.
        if (await act('add', () => sendFriendRequest(name), `Request sent to ${name}`)) {
            setAddName('');
        }
    };

    /**
     * Sit down at (or spectate) the game a friend is in. The lobby answers
     * with a game state or a handoff, and the Play tab — which stays mounted
     * as the initial route — owns the move to the pending screen or the board,
     * exactly as it does for a join from the lobby list. Navigating from here
     * as well would push the screen twice.
     */
    const openGame = (presence: Presence) => {
        if (!presence.game) {
            return;
        }
        if (presence.game.needsPassword) {
            // The password prompt lives on the Play tab; send them there
            // rather than asking for a password in two places.
            router.push('/(tabs)');
            return;
        }
        if (presence.joinable) {
            lobby.joinGame(presence.game.id);
        } else if (presence.watchable) {
            lobby.watchGame(presence.game.id);
        }
    };

    const onRemoveFriend = (friend: Friend) =>
        act(
            `remove-${friend.userId}`,
            () => removeFriend(friend.userId),
            `Removed ${friend.username}`
        );

    return (
        <>
            <Card style={{ marginBottom: spacing.md }}>
                <Text style={styles.cardTitle}>Add a friend</Text>
                <View style={styles.addRow}>
                    <TextField
                        placeholder='Their username'
                        value={addName}
                        onChangeText={setAddName}
                        containerStyle={{ flex: 1, marginBottom: 0 }}
                        onSubmitEditing={add}
                        returnKeyType='send'
                    />
                    <Button small title='Send' onPress={add} loading={busy === 'add'} />
                </View>
                <ErrorBanner message={error ?? loadError} />
                {notice ? <Text style={styles.notice}>{notice}</Text> : null}
            </Card>

            {incoming.length > 0 ? (
                <Card style={{ marginBottom: spacing.md }}>
                    <SectionLabel>Wants to be friends</SectionLabel>
                    {incoming.map((request) => {
                        const accept = `accept-${request.userId}`;
                        const decline = `decline-${request.userId}`;
                        return (
                            <View key={request.userId} style={styles.row}>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.name} numberOfLines={1}>
                                        {request.username}
                                    </Text>
                                </View>
                                <Button
                                    small
                                    title='Accept'
                                    loading={busy === accept}
                                    onPress={() =>
                                        act(
                                            accept,
                                            () => respondToFriendRequest(request.userId, true),
                                            `${request.username} is now a friend`
                                        )
                                    }
                                />
                                <Button
                                    small
                                    variant='ghost'
                                    title='Decline'
                                    loading={busy === decline}
                                    onPress={() =>
                                        act(decline, () =>
                                            respondToFriendRequest(request.userId, false)
                                        )
                                    }
                                />
                            </View>
                        );
                    })}
                </Card>
            ) : null}

            {outgoing.length > 0 ? (
                <Card style={{ marginBottom: spacing.md }}>
                    <SectionLabel>Waiting on them</SectionLabel>
                    {outgoing.map((request) => {
                        const key = `cancel-${request.userId}`;
                        return (
                            <View key={request.userId} style={styles.row}>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.name} numberOfLines={1}>
                                        {request.username}
                                    </Text>
                                    <Text style={styles.status}>Request sent</Text>
                                </View>
                                <Button
                                    small
                                    variant='ghost'
                                    title='Cancel'
                                    loading={busy === key}
                                    onPress={() => act(key, () => removeFriend(request.userId))}
                                />
                            </View>
                        );
                    })}
                </Card>
            ) : null}

            <Card>
                <SectionLabel>{`Friends (${friends.length})`}</SectionLabel>
                {friends.map((friend) => (
                    <FriendRow
                        key={friend.userId}
                        friend={friend}
                        presence={presenceFor(friend.username)}
                        removing={busy === `remove-${friend.userId}`}
                        onOpenGame={openGame}
                        onRemove={onRemoveFriend}
                    />
                ))}
                {friends.length === 0 ? (
                    loading && !loaded ? (
                        <ActivityIndicator color={colors.brand} style={{ marginVertical: 24 }} />
                    ) : (
                        <EmptyState
                            title='No friends yet'
                            subtitle='Add someone by username above. Once you are friends you can see when they are online and drop straight into their game.'
                        />
                    )
                ) : null}
            </Card>
        </>
    );
}

const styles = StyleSheet.create({
    cardTitle: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
        marginBottom: spacing.sm
    },
    addRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginBottom: spacing.sm
    },
    sectionLabel: {
        color: colors.textFaint,
        fontSize: 11,
        fontWeight: '800',
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        marginBottom: 4
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingVertical: 8,
        borderTopColor: 'rgba(42, 54, 80, 0.5)',
        borderTopWidth: StyleSheet.hairlineWidth
    },
    dot: {
        width: 9,
        height: 9,
        borderRadius: radius.pill
    },
    name: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700'
    },
    status: {
        color: colors.textFaint,
        fontSize: 11,
        marginTop: 2
    },
    notice: {
        color: '#7ed494',
        fontSize: 13
    }
});

export default FriendsSection;
