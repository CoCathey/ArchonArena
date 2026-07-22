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
import type { ChatMessage } from '../api/types';
import { colors, radius, spacing } from '../theme';
import { LogLine } from './LogMessages';
import type { CardSummary } from './types';

/** Slide-up game log + chat input. */
export default function LogSheet(props: {
    visible: boolean;
    messages: ChatMessage[];
    onClose: () => void;
    onSend: (text: string) => void;
    onCardPress: (card: CardSummary) => void;
}) {
    const [text, setText] = useState('');
    const listRef = useRef<FlatList<ChatMessage>>(null);

    useEffect(() => {
        if (props.visible) {
            const timer = setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 60);
            return () => clearTimeout(timer);
        }
        return undefined;
    }, [props.visible, props.messages.length]);

    const send = () => {
        if (text.trim()) {
            props.onSend(text.trim());
            setText('');
        }
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
                            <Text style={styles.title}>Game log</Text>
                            <Pressable onPress={props.onClose} hitSlop={12}>
                                <Text style={styles.closeText}>Close</Text>
                            </Pressable>
                        </View>
                        <FlatList
                            ref={listRef}
                            data={props.messages}
                            keyExtractor={(_, index) => String(index)}
                            renderItem={({ item }) => (
                                <LogLine message={item} onCardPress={props.onCardPress} />
                            )}
                            style={styles.list}
                            onContentSizeChange={() =>
                                listRef.current?.scrollToEnd({ animated: false })
                            }
                        />
                        <View style={styles.inputRow}>
                            <TextInput
                                value={text}
                                onChangeText={setText}
                                placeholder='Message your opponent…'
                                placeholderTextColor={colors.textFaint}
                                style={styles.input}
                                onSubmitEditing={send}
                                returnKeyType='send'
                            />
                            <Pressable onPress={send} style={styles.sendButton}>
                                <Text style={styles.sendText}>Send</Text>
                            </Pressable>
                        </View>
                    </View>
                </KeyboardAvoidingView>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(4, 8, 16, 0.5)'
    },
    sheet: {
        backgroundColor: colors.bgElevated,
        borderTopLeftRadius: radius.lg,
        borderTopRightRadius: radius.lg,
        borderColor: colors.border,
        borderWidth: 1,
        height: 440,
        paddingBottom: 24
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md
    },
    title: {
        color: colors.text,
        fontSize: 16,
        fontWeight: '800'
    },
    closeText: {
        color: colors.accent,
        fontWeight: '700',
        fontSize: 14
    },
    list: {
        flex: 1
    },
    inputRow: {
        flexDirection: 'row',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        paddingTop: spacing.sm,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.border
    },
    input: {
        flex: 1,
        backgroundColor: colors.bg,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        color: colors.text,
        paddingHorizontal: spacing.md,
        paddingVertical: 9,
        fontSize: 14
    },
    sendButton: {
        backgroundColor: colors.brand,
        borderRadius: radius.md,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 16
    },
    sendText: {
        color: '#161006',
        fontWeight: '800',
        fontSize: 14
    }
});
