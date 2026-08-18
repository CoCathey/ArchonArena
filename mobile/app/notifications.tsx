import React, { useCallback, useEffect } from 'react';
import { router } from 'expo-router';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useNotificationsStore } from '../src/stores/notificationsStore';
import { routeForNotification } from '../src/push';
import { colors, radius, spacing } from '../src/theme';
import { Button, EmptyState, ErrorBanner } from '../src/ui/primitives';
import type { NotificationRow } from '../src/api/client';

/**
 * ARCHON: notification history — the app half of the website's bell.
 *
 * Opening the screen does NOT mark everything read: a list that clears itself
 * the moment you glance at it is how a pairing notice gets lost. Tapping a row
 * marks that row (and follows it, when it names somewhere to go); "Mark all
 * read" is an explicit button.
 */

function relativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) {
        return '';
    }

    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 60) {
        return 'just now';
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours}h ago`;
    }
    const days = Math.floor(hours / 24);
    if (days < 7) {
        return `${days}d ago`;
    }

    return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function NotificationCard(props: { row: NotificationRow; onPress: (row: NotificationRow) => void }) {
    const { row } = props;

    return (
        <Pressable
            onPress={() => props.onPress(row)}
            style={({ pressed }) => [
                styles.row,
                !row.read && styles.rowUnread,
                pressed && { opacity: 0.7 }
            ]}
        >
            <View style={styles.rowHeader}>
                {!row.read ? <View style={styles.dot} /> : null}
                <Text style={styles.title} numberOfLines={2}>
                    {row.title}
                </Text>
                <Text style={styles.when}>{relativeTime(row.createdAt)}</Text>
            </View>
            {row.body ? (
                <Text style={styles.body} numberOfLines={4}>
                    {row.body}
                </Text>
            ) : null}
        </Pressable>
    );
}

export default function NotificationsScreen() {
    const rows = useNotificationsStore((state) => state.rows);
    const unread = useNotificationsStore((state) => state.unread);
    const loading = useNotificationsStore((state) => state.loading);
    const error = useNotificationsStore((state) => state.error);
    const load = useNotificationsStore((state) => state.load);
    const markRead = useNotificationsStore((state) => state.markRead);

    useEffect(() => {
        load();
    }, [load]);

    const onPress = useCallback(
        (row: NotificationRow) => {
            if (!row.read) {
                markRead([row.id]);
            }

            const route = routeForNotification({ ...(row.data ?? {}), url: row.url });
            if (route) {
                router.push(route);
            }
        },
        [markRead]
    );

    return (
        <View style={styles.container}>
            <FlatList
                data={rows}
                keyExtractor={(row) => String(row.id)}
                contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xl }}
                refreshControl={
                    <RefreshControl
                        refreshing={loading}
                        onRefresh={() => load()}
                        tintColor={colors.brand}
                    />
                }
                ListHeaderComponent={
                    <View>
                        <ErrorBanner message={error} />
                        {unread > 0 ? (
                            <Button
                                small
                                variant='secondary'
                                title={`Mark all read (${unread})`}
                                onPress={() => markRead()}
                                style={{ alignSelf: 'flex-end', marginBottom: spacing.sm }}
                            />
                        ) : null}
                    </View>
                }
                renderItem={({ item }) => <NotificationCard row={item} onPress={onPress} />}
                ListEmptyComponent={
                    loading ? null : (
                        <EmptyState
                            title='Nothing yet'
                            subtitle='Pairings, match times, friend requests and results land here.'
                        />
                    )
                }
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    row: {
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        padding: spacing.md,
        marginBottom: spacing.sm
    },
    rowUnread: {
        borderColor: colors.brandDark,
        backgroundColor: '#1d2436'
    },
    rowHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm
    },
    dot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: colors.brand
    },
    title: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
        flex: 1
    },
    when: {
        color: colors.textFaint,
        fontSize: 11
    },
    body: {
        color: colors.textDim,
        fontSize: 13,
        lineHeight: 18,
        marginTop: 4
    }
});
