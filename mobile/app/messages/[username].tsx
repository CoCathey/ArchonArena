import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
    ActivityIndicator,
    FlatList,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DirectMessage } from '../../src/api/messages';
import { useMessagesStore } from '../../src/stores/messagesStore';
import { colors, radius, spacing } from '../../src/theme';
import { EmptyState, ErrorBanner } from '../../src/ui/primitives';

/**
 * ARCHON: one conversation, oldest at the top and the box at the bottom.
 *
 * Opening it is what marks it read, exactly as on the website — a thread you
 * are looking at is a thread you have read, and a badge that survives that is
 * a badge nobody trusts. Live lines arrive over the lobby socket; the store
 * re-reads the thread when one lands, so this screen only renders.
 */

/** The server sends 2000; matching it here means the refusal never happens. */
const MAX_LENGTH = 2000;

function timeLabel(sentAt: string): string {
    // Postgres hands these back without a zone; they are UTC.
    const stamped = /[Zz]|[+-]\d\d:\d\d$/.test(sentAt) ? sentAt : `${sentAt}Z`;
    const when = new Date(stamped);

    return Number.isFinite(when.getTime())
        ? when.toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit'
          })
        : '';
}

function MessageBubble(props: { message: DirectMessage }) {
    const { message } = props;

    return (
        <View style={[styles.bubbleRow, message.fromMe && styles.bubbleRowMine]}>
            <View style={[styles.bubble, message.fromMe && styles.bubbleMine]}>
                <Text style={styles.bubbleText}>{message.text}</Text>
                <Text style={styles.bubbleTime}>{timeLabel(message.sentAt)}</Text>
            </View>
        </View>
    );
}

export default function MessageThreadScreen() {
    const { username } = useLocalSearchParams<{ username: string }>();
    const name = String(username ?? '');

    const thread = useMessagesStore((state) => state.thread);
    const sending = useMessagesStore((state) => state.sending);
    const loadThread = useMessagesStore((state) => state.loadThread);
    const markRead = useMessagesStore((state) => state.markRead);
    const setViewing = useMessagesStore((state) => state.setViewing);
    const loadEarlier = useMessagesStore((state) => state.loadEarlier);
    const send = useMessagesStore((state) => state.send);

    const [draft, setDraft] = useState('');
    const listRef = useRef<FlatList<DirectMessage>>(null);
    const insets = useSafeAreaInsets();

    // Claiming the thread stops a message arriving in it from also interrupting
    // the player with a notice about a conversation they are already reading.
    // On focus rather than on mount: this screen stays mounted underneath
    // anything pushed on top of it, and a thread nobody is looking at has no
    // business swallowing the notice about it.
    useFocusEffect(
        useCallback(() => {
            if (!name) {
                return undefined;
            }

            setViewing(name);
            loadThread(name);
            markRead(name);

            return () => setViewing(undefined);
        }, [loadThread, markRead, name, setViewing])
    );

    // Only this thread's state is on screen; while another one is still
    // loading, showing its messages would be showing the wrong person's mail.
    const showing =
        thread && thread.username.toLowerCase() === name.toLowerCase() ? thread : undefined;
    const messages = showing?.messages ?? [];
    const lastId = messages.length ? messages[messages.length - 1].id : undefined;

    // Newest at the bottom, and keep it in view as more arrive.
    useEffect(() => {
        if (lastId !== undefined) {
            const timer = setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 60);

            return () => clearTimeout(timer);
        }

        return undefined;
    }, [lastId]);

    const submit = async () => {
        const body = draft.trim();
        if (!body || sending) {
            return;
        }

        // Cleared optimistically: the send is retried by the player, not by the
        // app, and a box that keeps its text after a successful send is the
        // easiest way to send the same line twice.
        setDraft('');
        const sent = await send(name, body);

        if (!sent) {
            setDraft(body);
        }
    };

    return (
        <View style={styles.container}>
            <Stack.Screen options={{ title: name || 'Conversation' }} />
            <KeyboardAvoidingView
                style={{ flex: 1 }}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                keyboardVerticalOffset={insets.top + 44}
            >
                <FlatList
                    ref={listRef}
                    data={messages}
                    keyExtractor={(message) => String(message.id)}
                    contentContainerStyle={{ padding: spacing.md }}
                    renderItem={({ item }) => <MessageBubble message={item} />}
                    ListHeaderComponent={
                        showing?.hasMore ? (
                            // Deliberately not scrolled to the end afterwards:
                            // "load earlier" that snaps back to the newest
                            // message is a button that undoes itself.
                            <Pressable onPress={loadEarlier} style={styles.earlier}>
                                <Text style={styles.earlierText}>Load earlier messages</Text>
                            </Pressable>
                        ) : null
                    }
                    ListEmptyComponent={
                        showing?.loading ? (
                            <ActivityIndicator color={colors.brand} style={{ marginTop: 40 }} />
                        ) : (
                            <EmptyState
                                title={`No messages with ${name} yet`}
                                subtitle='Say when you can play.'
                            />
                        )
                    }
                />

                <View
                    style={[
                        styles.composer,
                        { paddingBottom: Math.max(insets.bottom, spacing.sm) }
                    ]}
                >
                    <ErrorBanner message={showing?.error} />
                    {showing && !showing.canMessage ? (
                        <Text style={styles.closed}>
                            You cannot message this player.
                        </Text>
                    ) : (
                        <View style={styles.inputRow}>
                            <TextInput
                                value={draft}
                                onChangeText={setDraft}
                                placeholder={`Message ${name}`}
                                placeholderTextColor={colors.textFaint}
                                style={styles.input}
                                maxLength={MAX_LENGTH}
                                multiline
                            />
                            <Pressable
                                onPress={submit}
                                disabled={sending || !draft.trim()}
                                hitSlop={8}
                                style={styles.sendButton}
                            >
                                <Text
                                    style={[
                                        styles.sendText,
                                        (sending || !draft.trim()) && { opacity: 0.4 }
                                    ]}
                                >
                                    Send
                                </Text>
                            </Pressable>
                        </View>
                    )}
                </View>
            </KeyboardAvoidingView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    bubbleRow: {
        flexDirection: 'row',
        marginBottom: spacing.sm
    },
    bubbleRowMine: {
        justifyContent: 'flex-end'
    },
    bubble: {
        maxWidth: '82%',
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm
    },
    bubbleMine: {
        backgroundColor: colors.bgElevated,
        borderColor: colors.borderLight
    },
    bubbleText: {
        color: colors.text,
        fontSize: 15,
        lineHeight: 20
    },
    bubbleTime: {
        color: colors.textFaint,
        fontSize: 10,
        marginTop: 4
    },
    earlier: {
        alignItems: 'center',
        paddingVertical: spacing.sm
    },
    earlierText: {
        color: colors.accent,
        fontSize: 13,
        fontWeight: '600'
    },
    composer: {
        borderTopColor: colors.border,
        borderTopWidth: 1,
        paddingHorizontal: spacing.md,
        paddingTop: spacing.sm
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: spacing.sm
    },
    input: {
        flex: 1,
        maxHeight: 120,
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        color: colors.text,
        fontSize: 15,
        paddingHorizontal: spacing.md,
        paddingVertical: 9
    },
    sendButton: {
        paddingHorizontal: spacing.sm,
        paddingVertical: 11
    },
    sendText: {
        color: colors.brand,
        fontSize: 15,
        fontWeight: '700'
    },
    closed: {
        color: colors.textDim,
        fontSize: 13,
        paddingVertical: spacing.sm,
        textAlign: 'center'
    }
});
