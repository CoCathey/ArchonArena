import React, { useEffect, useRef, useState } from 'react';
import {
    FlatList,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { LobbyMessage } from '../api/types';
import { lobby } from '../net/lobbySocket';
import { useLobbyStore } from '../stores/lobbyStore';
import { ReportPlayerSheet } from '../safety/ReportPlayerSheet';
import { colors, radius, spacing } from '../theme';

/**
 * ARCHON: site-wide lobby chat, which the app has never had.
 *
 * The protocol is the website's exactly: the server sends the backlog as
 * `lobbymessages` on connect, each new line as `lobbychat`, and refuses one
 * with `nochat` — carrying the reason, because a message that silently
 * vanishes is indistinguishable from a broken app and the player just says it
 * again.
 *
 * Long-pressing a line opens the report/block sheet. Guideline 1.2 wants
 * reporting reachable where the content is, and adding a chat surface without
 * it would be adding UGC with no way to answer it.
 */

function timeLabel(time?: string): string {
    if (!time) {
        return '';
    }
    const when = new Date(time);

    return Number.isFinite(when.getTime())
        ? when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        : '';
}

function ChatLine(props: { message: LobbyMessage; onReport: (username: string) => void }) {
    const author = props.message.user?.username;

    return (
        <Pressable
            onLongPress={author ? () => props.onReport(author) : undefined}
            delayLongPress={400}
            style={styles.line}
        >
            <View style={styles.lineHeader}>
                <Text style={styles.author}>{author ?? 'unknown'}</Text>
                <Text style={styles.time}>{timeLabel(props.message.time)}</Text>
            </View>
            <Text style={styles.text}>{props.message.message}</Text>
        </Pressable>
    );
}

export default function LobbyChatSheet(props: { visible: boolean; onClose: () => void }) {
    const chat = useLobbyStore((state) => state.chat);
    const refusal = useLobbyStore((state) => state.chatRefusal);
    const [text, setText] = useState('');
    const [reporting, setReporting] = useState<string | undefined>();
    const listRef = useRef<FlatList<LobbyMessage>>(null);
    const insets = useSafeAreaInsets();

    useEffect(() => {
        if (props.visible) {
            const timer = setTimeout(
                () => listRef.current?.scrollToEnd({ animated: false }),
                60
            );

            return () => clearTimeout(timer);
        }

        return undefined;
    }, [props.visible]);

    const send = () => {
        const body = text.trim();
        if (!body) {
            return;
        }
        lobby.lobbyChat(body);
        setText('');
    };

    return (
        <Modal
            visible={props.visible}
            transparent
            animationType='slide'
            onRequestClose={props.onClose}
        >
            <View style={styles.backdrop}>
                <Pressable style={{ flex: 1 }} onPress={props.onClose} />
                <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                    <View style={styles.sheet}>
                        <View style={styles.header}>
                            <Text style={styles.title}>Lobby chat</Text>
                            <Pressable onPress={props.onClose} hitSlop={12}>
                                <Text style={styles.close}>Close</Text>
                            </Pressable>
                        </View>

                        <FlatList
                            ref={listRef}
                            data={chat}
                            keyExtractor={(message, index) => String(message.id ?? index)}
                            renderItem={({ item }) => (
                                <ChatLine message={item} onReport={setReporting} />
                            )}
                            style={styles.list}
                            onContentSizeChange={() =>
                                listRef.current?.scrollToEnd({ animated: false })
                            }
                            ListEmptyComponent={
                                <Text style={styles.empty}>
                                    Nobody has said anything yet.
                                </Text>
                            }
                        />

                        {refusal ? <Text style={styles.refusal}>{refusal}</Text> : null}

                        <View
                            style={[
                                styles.inputRow,
                                { paddingBottom: Math.max(insets.bottom, spacing.sm) }
                            ]}
                        >
                            <TextInput
                                value={text}
                                onChangeText={setText}
                                placeholder='Say something'
                                placeholderTextColor={colors.textFaint}
                                style={styles.input}
                                maxLength={512}
                                returnKeyType='send'
                                onSubmitEditing={send}
                                blurOnSubmit={false}
                            />
                            <Pressable onPress={send} hitSlop={8} style={styles.sendButton}>
                                <Text style={styles.sendText}>Send</Text>
                            </Pressable>
                        </View>
                        <Text style={styles.hint}>Long-press a message to report its author.</Text>
                    </View>
                </KeyboardAvoidingView>
            </View>

            {reporting ? (
                <ReportPlayerSheet
                    visible
                    username={reporting}
                    onClose={() => setReporting(undefined)}
                />
            ) : null}
        </Modal>
    );
}

const styles = StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: colors.overlay,
        justifyContent: 'flex-end'
    },
    sheet: {
        height: '75%',
        backgroundColor: colors.bgElevated,
        borderTopColor: colors.border,
        borderTopWidth: 1,
        borderTopLeftRadius: radius.lg,
        borderTopRightRadius: radius.lg
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
        paddingBottom: spacing.sm
    },
    title: {
        color: colors.text,
        fontSize: 16,
        fontWeight: '800'
    },
    close: {
        color: colors.accent,
        fontSize: 14,
        fontWeight: '600'
    },
    list: {
        flex: 1,
        paddingHorizontal: spacing.lg
    },
    line: {
        paddingVertical: 5
    },
    lineHeader: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: spacing.sm
    },
    author: {
        color: colors.brand,
        fontSize: 12,
        fontWeight: '700'
    },
    time: {
        color: colors.textFaint,
        fontSize: 10
    },
    text: {
        color: colors.text,
        fontSize: 14,
        lineHeight: 19
    },
    empty: {
        color: colors.textFaint,
        fontSize: 13,
        paddingVertical: spacing.lg,
        textAlign: 'center'
    },
    refusal: {
        color: colors.warning,
        fontSize: 12,
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.sm
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.sm
    },
    input: {
        flex: 1,
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
        paddingHorizontal: spacing.md,
        paddingVertical: 9
    },
    sendText: {
        color: colors.brand,
        fontSize: 15,
        fontWeight: '700'
    },
    hint: {
        color: colors.textFaint,
        fontSize: 10,
        paddingHorizontal: spacing.lg,
        paddingBottom: spacing.sm,
        textAlign: 'center'
    }
});
