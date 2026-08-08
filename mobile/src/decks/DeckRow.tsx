import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Deck } from '../api/types';
import { colors, radius, spacing } from '../theme';
import HouseIcon from '../ui/HouseIcon';
import { expansionLabel } from './expansions';

/** SAS bands, so a number that means little on its own reads at a glance. */
function sasColor(sas: number): string {
    if (sas >= 85) {
        return '#7ed494';
    }
    if (sas >= 70) {
        return colors.brand;
    }
    if (sas >= 55) {
        return colors.textDim;
    }
    return colors.textFaint;
}

/**
 * One deck in a list. Used by both the Decks tab and the in-game deck picker so
 * the same information shows up wherever a deck is chosen.
 */
export default function DeckRow(props: {
    deck: Deck;
    onPress?: () => void;
    /** Rendered at the trailing edge — a Select button in the picker. */
    accessory?: React.ReactNode;
    selected?: boolean;
}) {
    const { deck } = props;
    const sas = typeof deck.sasRating === 'number' ? Math.round(deck.sasRating) : undefined;
    const set = expansionLabel(deck.expansion);
    const games = (deck.wins ?? 0) + (deck.losses ?? 0);

    return (
        <Pressable
            onPress={props.onPress}
            disabled={!props.onPress}
            style={({ pressed }) => [
                styles.row,
                props.selected && { borderColor: colors.brand },
                pressed && props.onPress ? { opacity: 0.7 } : null
            ]}
        >
            <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={2}>
                    {deck.name}
                </Text>

                <View style={styles.metaRow}>
                    <View style={styles.houseRow}>
                        {(deck.houses ?? []).map((house) => (
                            <HouseIcon key={house} house={house} size={20} />
                        ))}
                    </View>
                    {sas !== undefined ? (
                        <View style={styles.sasChip}>
                            <Text style={[styles.sasValue, { color: sasColor(sas) }]}>{sas}</Text>
                            <Text style={styles.sasLabel}>SAS</Text>
                        </View>
                    ) : (
                        // Absent SAS is normal — DoK may not know this deck yet.
                        <Text style={styles.sasMissing}>SAS —</Text>
                    )}
                    {set ? <Text style={styles.set}>{set}</Text> : null}
                </View>

                {games > 0 || deck.verified || deck.isAlliance ? (
                    <View style={styles.metaRow}>
                        {games > 0 ? (
                            <Text style={styles.record}>
                                {deck.wins ?? 0}W · {deck.losses ?? 0}L
                                {typeof deck.winRate === 'number'
                                    ? ` · ${Math.round(deck.winRate)}%`
                                    : ''}
                            </Text>
                        ) : null}
                        {deck.isAlliance ? <Text style={styles.alliance}>alliance</Text> : null}
                        {deck.verified ? <Text style={styles.verified}>✓ verified</Text> : null}
                    </View>
                ) : null}
            </View>

            {props.accessory}
        </Pressable>
    );
}

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.lg,
        padding: spacing.md,
        marginBottom: spacing.sm
    },
    name: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700'
    },
    metaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        marginTop: 7
    },
    houseRow: {
        flexDirection: 'row',
        gap: 5
    },
    sasChip: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: 3
    },
    sasValue: {
        fontSize: 15,
        fontWeight: '800',
        fontVariant: ['tabular-nums']
    },
    sasLabel: {
        color: colors.textFaint,
        fontSize: 10,
        fontWeight: '700'
    },
    sasMissing: {
        color: colors.textFaint,
        fontSize: 11,
        fontWeight: '600'
    },
    set: {
        color: colors.textFaint,
        fontSize: 11,
        fontWeight: '700'
    },
    record: {
        color: colors.textDim,
        fontSize: 11
    },
    alliance: {
        color: colors.accent,
        fontSize: 11,
        fontWeight: '700'
    },
    verified: {
        color: '#7ed494',
        fontSize: 11
    }
});
