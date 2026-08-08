import React, { useEffect, useRef, useState } from 'react';
import {
    FlatList,
    Keyboard,
    KeyboardAvoidingView,
    Modal,
    NativeScrollEvent,
    NativeSyntheticEvent,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ChatMessage } from '../api/types';
import { colors, radius, spacing } from '../theme';
import { useVerticalSwipe } from './gestures';
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
    const [keyboardOpen, setKeyboardOpen] = useState(false);
    const listRef = useRef<FlatList<ChatMessage>>(null);
    const insets = useSafeAreaInsets();
    // Swiping the handle back down returns to the board — the mirror of the
    // swipe up that opened the sheet.
    const dismissHandlers = useVerticalSwipe({ onDown: props.onClose });

    // Shrink the sheet while typing so it (and its Close button) stay on-screen
    // above the keyboard on small devices.
    useEffect(() => {
        const show = Keyboard.addListener('keyboardWillShow', () => setKeyboardOpen(true));
        const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboardOpen(false));
        return () => {
            show.remove();
            hide.remove();
        };
    }, []);
    // Only auto-scroll to the newest line when the user is already near the
    // bottom, so scrolling up to read history isn't yanked away.
    const atBottom = useRef(true);

    // Jump to the latest line whenever the sheet is (re)opened.
    useEffect(() => {
        if (props.visible) {
            atBottom.current = true;
            const timer = setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 60);
            return () => clearTimeout(timer);
        }
        return undefined;
    }, [props.visible]);

    const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
        atBottom.current = distanceFromBottom < 60;
    };

    const send = () => {
        if (text.trim()) {
            props.onSend(text.trim());
            setText('');
            atBottom.current = true;
            requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
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
                    <View style={[styles.sheet, { height: keyboardOpen ? '52%' : '75%' }]}>
                        {/* Grab area: the handle and the title row both dismiss
                            on a downward swipe. */}
                        <View {...dismissHandlers}>
                            <Pressable
                                onPress={props.onClose}
                                style={styles.grabArea}
                                hitSlop={8}
                                accessibilityLabel='Close the game log'
                                accessibilityRole='button'
                            >
                                <View style={styles.grabber} />
                            </Pressable>
                            <View style={styles.header}>
                                <Text style={styles.title}>Game log</Text>
                                <Pressable onPress={props.onClose} hitSlop={12}>
                                    <Text style={styles.closeText}>Swipe down ⌄</Text>
                                </Pressable>
                            </View>
                        </View>
                        <FlatList
                            ref={listRef}
                            data={props.messages}
                            keyExtractor={(_, index) => String(index)}
                            renderItem={({ item }) => (
                                <LogLine message={item} onCardPress={props.onCardPress} />
                            )}
                            style={styles.list}
                            onScroll={onScroll}
                            scrollEventThrottle={100}
                            onContentSizeChange={() => {
                                if (atBottom.current) {
                                    listRef.current?.scrollToEnd({ animated: false });
                                }
                            }}
                        />
                        <View
                            style={[
                                styles.inputRow,
                                { paddingBottom: Math.max(insets.bottom, spacing.sm) }
                            ]}
                        >
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
        borderWidth: 1
    },
    grabArea: {
        alignItems: 'center',
        paddingTop: spacing.sm,
        paddingBottom: 2
    },
    grabber: {
        width: 40,
        height: 4,
        borderRadius: 2,
        backgroundColor: colors.borderLight
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.sm,
        paddingBottom: spacing.md
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
