import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../theme';
import HouseIcon from '../ui/HouseIcon';
import type { PlayerState, PromptButton } from './types';

function promptText(value: PlayerState['menuTitle']): string | undefined {
    if (!value) {
        return undefined;
    }
    if (typeof value === 'string') {
        return value;
    }
    let text = value.text ?? '';
    const values = value.values ?? {};
    for (const [key, replacement] of Object.entries(values)) {
        text = text.split(`{{${key}}}`).join(String(replacement));
    }
    return text;
}

/**
 * The active-player prompt: current prompt title plus its buttons. House
 * choices arrive as regular buttons carrying an `icon`, and house-select
 * targeting controls reuse the buttons with house names.
 */
export default function PromptPanel(props: {
    me?: PlayerState;
    onButton: (button: PromptButton) => void;
}) {
    const { me } = props;
    if (!me) {
        return null;
    }

    const buttons = me.buttons ?? [];
    const hasHouseSelectControl = (me.controls ?? []).some(
        (control) => control.type === 'house-select'
    );
    const houseButtons = buttons.filter((button) => button.icon);
    const plainButtons = buttons.filter((button) => !button.icon);
    const title = promptText(me.menuTitle);

    if (!title && buttons.length === 0) {
        return null;
    }

    return (
        <View style={styles.container}>
            {title ? <Text style={styles.title}>{title}</Text> : null}

            {houseButtons.length > 0 || hasHouseSelectControl ? (
                <View style={styles.houseRow}>
                    {(houseButtons.length > 0
                        ? houseButtons
                        : buttons
                    ).map((button, index) => (
                        <Pressable
                            key={`${String(button.arg)}-${index}`}
                            onPress={() => props.onButton(button)}
                            disabled={!!button.disabled}
                            style={({ pressed }) => [
                                styles.houseButton,
                                pressed && { opacity: 0.7 },
                                button.disabled && { opacity: 0.35 }
                            ]}
                        >
                            <HouseIcon
                                house={String(button.icon ?? button.text ?? '')}
                                size={40}
                            />
                            <Text style={styles.houseLabel}>
                                {String(button.text ?? button.icon ?? '')}
                            </Text>
                        </Pressable>
                    ))}
                </View>
            ) : null}

            {plainButtons.length > 0 && houseButtons.length === 0 && !hasHouseSelectControl ? (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.buttonRow}
                >
                    {plainButtons.map((button, index) => (
                        <Pressable
                            key={`${String(button.arg)}-${index}`}
                            onPress={() => props.onButton(button)}
                            disabled={!!button.disabled}
                            style={({ pressed }) => [
                                styles.promptButton,
                                pressed && { opacity: 0.7 },
                                button.disabled && { opacity: 0.35 }
                            ]}
                        >
                            <Text style={styles.promptButtonText}>{String(button.text ?? '')}</Text>
                        </Pressable>
                    ))}
                </ScrollView>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        backgroundColor: 'rgba(18, 24, 38, 0.96)',
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        marginHorizontal: spacing.sm,
        marginVertical: 6,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.sm
    },
    title: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '600',
        textAlign: 'center',
        marginBottom: 6
    },
    buttonRow: {
        gap: spacing.sm,
        paddingHorizontal: 2
    },
    promptButton: {
        backgroundColor: colors.brand,
        borderRadius: radius.sm,
        paddingHorizontal: 14,
        paddingVertical: 9
    },
    promptButtonText: {
        color: '#161006',
        fontWeight: '700',
        fontSize: 14
    },
    houseRow: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: spacing.lg,
        flexWrap: 'wrap'
    },
    houseButton: {
        alignItems: 'center',
        gap: 4
    },
    houseLabel: {
        color: colors.textDim,
        fontSize: 11,
        fontWeight: '600',
        textTransform: 'capitalize'
    }
});
