import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ORDERED_EXPANSIONS } from '../decks/expansions';
import { colors, radius, spacing } from '../theme';

/**
 * ARCHON: the set filter the intelligence screen shares.
 *
 * A row of toggles rather than a dropdown, and for the same reason the web
 * version uses one: the filter IS the question — "how do I do in Æmber Skies" —
 * and the answer above it changes meaning entirely depending on what is
 * selected, so which sets are on has to be readable without opening anything.
 *
 * Horizontally scrolling because there are twenty sets and a phone is narrow;
 * wrapping them would push the actual numbers off the first screen.
 *
 * "All sets" is a real state rather than zero selections dressed up. Sending no
 * filter and sending an empty one mean opposite things to the server, and a
 * control that cannot tell them apart eventually sends the wrong one — so the
 * screen omits the parameter entirely when nothing is selected.
 */
export function SetFilter(props: {
    selected: number[];
    onChange: (sets: number[]) => void;
    disabled?: boolean;
}) {
    const { selected, onChange, disabled } = props;
    const all = selected.length === 0;

    const toggle = (id: number) =>
        onChange(selected.includes(id) ? selected.filter((set) => set !== id) : [...selected, id]);

    const chip = (on: boolean, key: string | number, label: string, onPress: () => void) => (
        <Pressable
            disabled={disabled}
            key={key}
            onPress={onPress}
            style={[styles.chip, on ? styles.chipOn : null, disabled ? { opacity: 0.4 } : null]}
        >
            <Text style={[styles.chipText, on ? styles.chipTextOn : null]}>{label}</Text>
        </Pressable>
    );

    return (
        <View>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.row}
            >
                {chip(all, 'all', 'All sets', () => onChange([]))}
                <View style={styles.divider} />
                {ORDERED_EXPANSIONS.map((set) =>
                    chip(selected.includes(set.id), set.id, set.label, () => toggle(set.id))
                )}
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        paddingVertical: 2
    },
    divider: {
        width: 1,
        height: 16,
        backgroundColor: colors.border,
        marginHorizontal: 2
    },
    chip: {
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgElevated,
        borderRadius: radius.pill,
        paddingHorizontal: spacing.md,
        paddingVertical: 5
    },
    chipOn: {
        borderColor: colors.accent,
        backgroundColor: 'rgba(79,142,247,0.18)'
    },
    chipText: {
        color: colors.text,
        fontSize: 12
    },
    chipTextOn: {
        color: colors.accent,
        fontWeight: '600'
    }
});

export default SetFilter;
