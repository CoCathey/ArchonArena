import React, { useCallback } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { DirectConversation } from '../../src/api/messages';
import { useMessagesStore } from '../../src/stores/messagesStore';
import { colors, radius, spacing } from '../../src/theme';
import { EmptyState, ErrorBanner } from '../../src/ui/primitives';

/**
 * ARCHON: the message inbox — one row per person, newest conversation first.
 *
 * Deliberately plain, like the website's: a tournament pairs two people who
 * have to agree on when to play, and this is the conversation around the
 * scheduler, not a chat product. The list is the only navigation it needs.
 */

function whenLabel(sentAt: string): string {
    // Postgres hands these back without a zone; they are UTC.
    const stamped = /[Zz]|[+-]\d\d:\d\d$/.test(sentAt) ? sentAt : `${sentAt}Z`;
    const then = new Date(stamped).getTime();

    if (!Number.isFinite(then)) {
        return '';
    }

    const minutes = Math.floor((Date.now() - then) / 60000);
    if (minutes < 1) {
        return 'just now';
    }
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    if (minutes < 60 * 24) {
        return `${Math.floor(minutes / 60)}h ago`;
    }
    if (minutes < 60 * 24 * 7) {
        return `${Math.floor(minutes / (60 * 24))}d ago`;
    }

    return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function ConversationRow(props: { conversation: DirectConversation }) {
    const { conversation } = props;
    const unread = conversation.unread > 0;

    return (
        <Pressable
            onPress={() =>
                router.push(`/messages/${encodeURIComponent(conversation.username)}`)
            }
            style={({ pressed }) => [
                styles.row,
                unread && styles.rowUnread,
                pressed && { opacity: 0.7 }
            ]}
        >
            <View style={styles.rowHeader}>
                {unread ? <View style={styles.dot} /> : null}
                <Text style={styles.username} numberOfLines={1}>
                    {conversation.username}
                </Text>
                <Text style={styles.when}>{whenLabel(conversation.lastMessage.sentAt)}</Text>
            </View>
            <Text style={[styles.preview, unread && styles.previewUnread]} numberOfLines={2}>
                {conversation.lastMessage.fromMe ? 'You: ' : ''}
                {conversation.lastMessage.text}
            </Text>
        </Pressable>
    );
}

export default function MessagesScreen() {
    const conversations = useMessagesStore((state) => state.conversations);
    const loading = useMessagesStore((state) => state.loadingConversations);
    const loaded = useMessagesStore((state) => state.conversationsLoaded);
    const error = useMessagesStore((state) => state.error);
    const load = useMessagesStore((state) => state.loadConversations);

    // On focus, so coming back from a thread shows it read rather than the
    // unread state the list was built with. Quiet once there is a list on
    // screen: that refresh must not replace it with a spinner.
    useFocusEffect(
        useCallback(() => {
            load({ quiet: useMessagesStore.getState().conversationsLoaded });
        }, [load])
    );

    return (
        <View style={styles.container}>
            <FlatList
                data={conversations}
                keyExtractor={(conversation) => String(conversation.userId)}
                contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xl }}
                refreshControl={
                    <RefreshControl
                        refreshing={loading}
                        onRefresh={() => load()}
                        tintColor={colors.brand}
                    />
                }
                ListHeaderComponent={<ErrorBanner message={error} />}
                renderItem={({ item }) => <ConversationRow conversation={item} />}
                ListEmptyComponent={
                    loaded && !loading ? (
                        <EmptyState
                            title='No messages yet'
                            subtitle='Open a player from the community or your pairing and write to them.'
                        />
                    ) : null
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
        borderColor: colors.brandDark
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
    username: {
        flex: 1,
        color: colors.text,
        fontSize: 15,
        fontWeight: '700'
    },
    when: {
        color: colors.textFaint,
        fontSize: 11
    },
    preview: {
        color: colors.textDim,
        fontSize: 13,
        marginTop: 4
    },
    previewUnread: {
        color: colors.text
    }
});
