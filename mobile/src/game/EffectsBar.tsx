import React from 'react';
import { Image } from 'expo-image';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../theme';
import { CARD_ASPECT, cardImageUrl } from './cardImages';
import type { CardSummary, PlayerEffectSummary } from './types';

/**
 * When an effect stops applying, phrased from the reading player's point of
 * view. `pending` effects have been declared but have not started yet.
 */
function durationLabel(effect: PlayerEffectSummary, me?: string): string {
    const controllerIsMe = !!me && effect.controller === me;
    const theirTurn = controllerIsMe ? 'their next turn' : 'your next turn';

    switch (effect.duration) {
        case 'duringOpponentNextTurn':
            return `during ${theirTurn}`;
        case 'untilPlayerTurnEnd':
            return 'this turn';
        case 'untilPhaseEnd':
            return 'this phase';
        case 'untilPlayerNextTurnEnd':
        case 'untilPlayerNextTurnEndInitiated':
            return `until the end of ${controllerIsMe ? 'your' : 'their'} next turn`;
        case 'untilPlayerNextTurnStart':
        case 'untilPlayerNextTurnStartInitiated':
            return `until the start of ${controllerIsMe ? 'your' : 'their'} next turn`;
        case 'consecutiveTurn':
            return 'extra turn';
        default:
            return 'ongoing';
    }
}

/** "affects you" / "affects Bob" / "affects both". */
function targetLabel(effect: PlayerEffectSummary, me?: string): string {
    const targets = effect.targets ?? [];
    if (targets.length > 1) {
        return 'both players';
    }
    const target = targets[0];
    if (!target) {
        return '';
    }
    return me && target === me ? 'you' : target;
}

/**
 * Lasting effects that constrain a player rather than a card — Befuddle and
 * friends. Their source card is normally in a discard pile by the time they
 * matter, so without this the only trace is a log line that has scrolled away.
 */
export default function EffectsBar(props: {
    effects?: PlayerEffectSummary[];
    /** The viewing player, so effects can be phrased as "affects you". */
    me?: string;
    onCardPress?: (card: CardSummary) => void;
}) {
    const effects = props.effects ?? [];
    if (effects.length === 0) {
        return null;
    }

    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.container}
            contentContainerStyle={styles.content}
        >
            {effects.map((effect, index) => {
                const source = effect.source;
                const url = source ? cardImageUrl(source) : undefined;
                const affects = targetLabel(effect, props.me);
                const affectsMe = !!props.me && (effect.targets ?? []).includes(props.me);
                return (
                    <Pressable
                        key={`${source?.id ?? 'effect'}-${index}`}
                        onPress={
                            source && props.onCardPress
                                ? () => props.onCardPress?.(source as CardSummary)
                                : undefined
                        }
                        style={({ pressed }) => [
                            styles.chip,
                            affectsMe && styles.chipOnMe,
                            effect.pending && styles.chipPending,
                            pressed && { opacity: 0.7 }
                        ]}
                    >
                        {url ? (
                            <Image
                                source={{ uri: url }}
                                style={styles.thumb}
                                contentFit='cover'
                                cachePolicy='disk'
                            />
                        ) : null}
                        <View style={styles.chipText}>
                            <Text style={styles.chipName} numberOfLines={1}>
                                {source?.name ?? 'Lasting effect'}
                            </Text>
                            <Text style={styles.chipMeta} numberOfLines={1}>
                                {affects ? `${affects} · ` : ''}
                                {durationLabel(effect, props.me)}
                            </Text>
                        </View>
                    </Pressable>
                );
            })}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        flexGrow: 0,
        maxHeight: 48
    },
    content: {
        gap: spacing.sm,
        paddingHorizontal: spacing.sm,
        paddingVertical: 4,
        alignItems: 'center'
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        backgroundColor: 'rgba(24, 30, 46, 0.96)',
        borderColor: colors.borderLight,
        borderWidth: 1,
        borderRadius: radius.sm,
        paddingRight: 10,
        paddingLeft: 4,
        paddingVertical: 4,
        maxWidth: 220
    },
    // Something is being done *to* the reader — worth the warning colour.
    chipOnMe: {
        borderColor: colors.warning
    },
    chipPending: {
        opacity: 0.75
    },
    thumb: {
        width: 20,
        height: Math.round(20 * CARD_ASPECT),
        borderRadius: 2
    },
    chipText: {
        flexShrink: 1
    },
    chipName: {
        color: colors.text,
        fontSize: 11,
        fontWeight: '800'
    },
    chipMeta: {
        color: colors.textDim,
        fontSize: 10
    }
});
