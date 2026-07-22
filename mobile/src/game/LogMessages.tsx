import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ChatMessage, MessageFragment } from '../api/types';
import type { CardSummary } from './types';
import { colors, spacing } from '../theme';

/**
 * Renders one game-log entry. The server sends each entry as an object/array
 * of fragments: plain strings, card references ({image, label}), player
 * references ({name, argType: 'player'}), nested {message} wrappers and
 * {alert: {type, message}} wrappers (see client/Components/GameBoard/Messages.jsx
 * in the web client).
 */

const KEYWORD_REPLACEMENTS: Record<string, string> = {
    amber: 'Æmber',
    'amber.': 'Æmber.',
    forgedkeyblue: 'blue key',
    unforgedkeyblue: 'blue key',
    forgedkeyred: 'red key',
    unforgedkeyred: 'red key',
    forgedkeyyellow: 'yellow key',
    unforgedkeyyellow: 'yellow key',
    tide: 'tide'
};

function replaceKeywords(text: string): string {
    return text
        .split(' ')
        .map((word) => KEYWORD_REPLACEMENTS[word.toLowerCase()] ?? word)
        .join(' ');
}

function renderFragments(
    fragment: MessageFragment | Record<string, MessageFragment>,
    onCardPress: (card: CardSummary) => void,
    keyPrefix: string
): React.ReactNode[] {
    if (fragment === null || fragment === undefined) {
        return [];
    }

    if (typeof fragment === 'string' || typeof fragment === 'number') {
        return [
            <Text key={keyPrefix} style={styles.text}>
                {replaceKeywords(String(fragment))}
            </Text>
        ];
    }

    // Both arrays and objects of fragments are iterated by entry.
    const nodes: React.ReactNode[] = [];
    let index = 0;

    for (const [key, part] of Object.entries(fragment)) {
        const nodeKey = `${keyPrefix}.${index++}`;
        if (part === null || part === undefined) {
            continue;
        }

        if (typeof part === 'string' || typeof part === 'number') {
            nodes.push(
                <Text key={nodeKey} style={styles.text}>
                    {replaceKeywords(String(part))}
                </Text>
            );
            continue;
        }

        if (Array.isArray(part)) {
            nodes.push(...renderFragments(part, onCardPress, nodeKey));
            continue;
        }

        const obj = part as Record<string, unknown>;

        if (key === 'alert' && obj.type && obj.message !== undefined) {
            const inner = renderFragments(
                obj.message as MessageFragment,
                onCardPress,
                `${nodeKey}.alert`
            );
            nodes.push(
                <Text key={nodeKey} style={[styles.text, alertStyle(String(obj.type))]}>
                    {inner}
                </Text>
            );
            continue;
        }

        if (obj.message !== undefined) {
            nodes.push(
                ...renderFragments(obj.message as MessageFragment, onCardPress, nodeKey)
            );
            continue;
        }

        if (obj.link && obj.label) {
            nodes.push(
                <Text key={nodeKey} style={[styles.text, styles.link]}>
                    {String(obj.label)}
                </Text>
            );
            continue;
        }

        if (obj.image && obj.label) {
            const card = obj as unknown as CardSummary;
            nodes.push(
                <Text
                    key={nodeKey}
                    style={[styles.text, styles.cardRef]}
                    onPress={() => onCardPress({ ...card, uuid: String(card.uuid ?? card.image) })}
                >
                    {String(obj.label)}
                </Text>
            );
            continue;
        }

        if (obj.name && (obj.argType === 'player' || obj.argType === 'nonAvatarPlayer')) {
            nodes.push(
                <Text key={nodeKey} style={[styles.text, styles.player]}>
                    {String(obj.name)}
                </Text>
            );
            continue;
        }

        if (obj.name) {
            nodes.push(
                <Text key={nodeKey} style={[styles.text, styles.player]}>
                    {String(obj.name)}
                </Text>
            );
            continue;
        }

        // Unknown fragment shape: render nothing rather than "[object Object]".
    }

    return nodes;
}

function alertStyle(type: string) {
    switch (type) {
        case 'danger':
            return { color: '#ff8f93', fontWeight: '700' as const };
        case 'warning':
            return { color: colors.warning, fontWeight: '700' as const };
        case 'success':
            return { color: '#7ed494', fontWeight: '700' as const };
        case 'bell':
        case 'info':
            return { color: colors.accent, fontWeight: '600' as const };
        case 'endofturn':
        case 'startofturn':
        case 'phasestart':
            return { color: colors.brand, fontWeight: '700' as const };
        default:
            return {};
    }
}

export function isTurnSeparator(message: ChatMessage): boolean {
    const fragments = message.message;
    if (!fragments || typeof fragments !== 'object') {
        return false;
    }
    return Object.values(fragments).some(
        (fragment) =>
            fragment &&
            typeof fragment === 'object' &&
            !Array.isArray(fragment) &&
            ['startofturn', 'endofturn', 'phasestart'].includes(
                String((fragment as { type?: string }).type ?? '')
            )
    );
}

export function LogLine(props: {
    message: ChatMessage;
    onCardPress: (card: CardSummary) => void;
}) {
    const nodes = renderFragments(
        props.message.message as MessageFragment,
        props.onCardPress,
        'root'
    );
    return (
        <View style={[styles.line, isTurnSeparator(props.message) && styles.separatorLine]}>
            <Text style={styles.text}>{nodes}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    line: {
        paddingVertical: 3,
        paddingHorizontal: spacing.md
    },
    separatorLine: {
        borderTopColor: colors.border,
        borderTopWidth: StyleSheet.hairlineWidth,
        marginTop: 4,
        paddingTop: 6
    },
    text: {
        color: colors.textDim,
        fontSize: 13,
        lineHeight: 19
    },
    link: {
        color: colors.accent,
        textDecorationLine: 'underline'
    },
    cardRef: {
        color: '#5fd4a0',
        fontWeight: '600'
    },
    player: {
        color: colors.text,
        fontWeight: '700'
    }
});
