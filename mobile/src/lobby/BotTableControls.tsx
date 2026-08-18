import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { GameSummary } from '../api/types';
import { lobby } from '../net/lobbySocket';
import { colors, radius, spacing } from '../theme';

/**
 * ARCHON (F9/N31): the practice table's two settings, on the phone.
 *
 * The lobby hosts bot tables and anyone may join one; the joiner picks how the
 * bot plays (its sparring style — one learned brain wearing a different plan)
 * and what it brings (the ARI band its deck is drawn from). The app could
 * always JOIN a practice table and could never set either, so every practice
 * game on a phone was a Medium table against whatever style the rotation
 * happened to be on.
 *
 * This is the only screen where the choice can be made: picking a deck starts
 * the game.
 */

/** The bands, mirroring server/services/botgames/difficulty.js. */
const DIFFICULTIES = [
    { key: 'easy', label: 'Easy', range: 'ARI 45–65' },
    { key: 'medium', label: 'Medium', range: 'ARI 66–89' },
    { key: 'hard', label: 'Hard', range: 'ARI 90–125' }
];

function Chip(props: { label: string; active: boolean; onPress: () => void }) {
    return (
        <Pressable
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.chip,
                props.active && styles.chipActive,
                pressed && { opacity: 0.7 }
            ]}
        >
            <Text style={[styles.chipText, props.active && styles.chipTextActive]}>
                {props.label}
            </Text>
        </Pressable>
    );
}

export default function BotTableControls(props: { game: GameSummary; seated: boolean }) {
    const { game, seated } = props;

    if (!game.botGame || game.started || !seated) {
        return null;
    }

    const difficulty = game.botDifficulty ?? 'medium';
    const band = DIFFICULTIES.find((entry) => entry.key === difficulty);
    const styles_ = game.botStyles ?? [];

    return (
        <View style={styles.container}>
            <Text style={styles.heading}>Practice table</Text>

            {styles_.length > 0 ? (
                <View style={styles.block}>
                    <Text style={styles.label}>Opponent style</Text>
                    <View style={styles.chipRow}>
                        {/* An empty key is "no style": the champion playing its
                            own game, which is what every table offered before
                            the personas existed. */}
                        {[{ key: '', label: 'Its own game', description: undefined }, ...styles_].map(
                            (style) => (
                                <Chip
                                    key={style.key || 'none'}
                                    label={style.label}
                                    active={(game.botStyle ?? '') === style.key}
                                    onPress={() => lobby.selectBotStyle(game.id, style.key)}
                                />
                            )
                        )}
                    </View>
                    {game.botStyleLabel ? (
                        <Text style={styles.hint}>
                            {
                                styles_.find((style) => style.key === game.botStyle)
                                    ?.description ?? `Playing as ${game.botStyleLabel}.`
                            }
                        </Text>
                    ) : null}
                </View>
            ) : null}

            <View style={styles.block}>
                <Text style={styles.label}>Difficulty</Text>
                <View style={styles.chipRow}>
                    {DIFFICULTIES.map((entry) => (
                        <Chip
                            key={entry.key}
                            label={entry.label}
                            active={difficulty === entry.key}
                            onPress={() => lobby.setBotDifficulty(game.id, entry.key)}
                        />
                    ))}
                </View>
                <Text style={styles.hint}>
                    {band ? `The bot brings a deck rated ${band.range}.` : ''} Practice games are
                    never rated.
                </Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.lg,
        padding: spacing.md,
        marginBottom: spacing.md
    },
    heading: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '800',
        marginBottom: spacing.sm
    },
    block: {
        marginBottom: spacing.sm
    },
    label: {
        color: colors.textFaint,
        fontSize: 10,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 5
    },
    chipRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6
    },
    chip: {
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: spacing.md,
        paddingVertical: 6,
        backgroundColor: colors.bgElevated
    },
    chipActive: {
        borderColor: colors.brand,
        backgroundColor: colors.surfaceHover
    },
    chipText: {
        color: colors.textDim,
        fontSize: 12,
        fontWeight: '600'
    },
    chipTextActive: {
        color: colors.brand
    },
    hint: {
        color: colors.textFaint,
        fontSize: 11,
        lineHeight: 16,
        marginTop: 5
    }
});
