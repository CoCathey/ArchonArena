import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radius, spacing } from '../theme';
import HouseIcon, { HOUSES, houseLabel } from '../ui/HouseIcon';
import { DECK_SORTS, type DeckSortOption } from './useDeckLibrary';

function Chip(props: { label: string; active?: boolean; onPress: () => void }) {
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

/**
 * Search + sort + house filter for a deck list. Everything here feeds
 * server-side query parameters, so it narrows the whole collection rather than
 * the page currently on screen.
 */
export default function DeckFilterBar(props: {
    search: string;
    onSearchChange: (value: string) => void;
    sort: DeckSortOption;
    onSortChange: (sort: DeckSortOption) => void;
    houses: string[];
    onToggleHouse: (house: string) => void;
    onClear: () => void;
    /** Result count line, e.g. "12 of 340 decks". */
    summary?: string;
}) {
    const [housesOpen, setHousesOpen] = useState(false);
    const anyFilter = props.search.length > 0 || props.houses.length > 0;

    return (
        <View style={styles.container}>
            <View style={styles.searchRow}>
                <TextInput
                    value={props.search}
                    onChangeText={props.onSearchChange}
                    placeholder='Search decks by name'
                    placeholderTextColor={colors.textFaint}
                    autoCapitalize='none'
                    autoCorrect={false}
                    returnKeyType='search'
                    clearButtonMode='while-editing'
                    style={styles.search}
                />
                <Pressable
                    onPress={() => setHousesOpen((open) => !open)}
                    style={({ pressed }) => [
                        styles.houseToggle,
                        (housesOpen || props.houses.length > 0) && styles.houseToggleActive,
                        pressed && { opacity: 0.7 }
                    ]}
                >
                    {props.houses.length > 0 ? (
                        <View style={styles.houseToggleIcons}>
                            {props.houses.slice(0, 3).map((house) => (
                                <HouseIcon key={house} house={house} size={18} />
                            ))}
                        </View>
                    ) : (
                        <Text style={styles.houseToggleText}>Houses</Text>
                    )}
                </Pressable>
            </View>

            {housesOpen ? (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.houseStrip}
                    keyboardShouldPersistTaps='handled'
                >
                    {HOUSES.map((house) => {
                        const active = props.houses.includes(house);
                        return (
                            <Pressable
                                key={house}
                                onPress={() => props.onToggleHouse(house)}
                                style={({ pressed }) => [
                                    styles.housePick,
                                    active && styles.housePickActive,
                                    pressed && { opacity: 0.7 }
                                ]}
                            >
                                <HouseIcon house={house} size={26} dimmed={!active} />
                                <Text
                                    style={[
                                        styles.housePickText,
                                        active && { color: colors.text }
                                    ]}
                                    numberOfLines={1}
                                >
                                    {houseLabel(house)}
                                </Text>
                            </Pressable>
                        );
                    })}
                </ScrollView>
            ) : null}

            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.sortRow}
                keyboardShouldPersistTaps='handled'
            >
                {DECK_SORTS.map((option) => (
                    <Chip
                        key={option.key}
                        label={option.label}
                        active={props.sort.key === option.key}
                        onPress={() => props.onSortChange(option)}
                    />
                ))}
                {anyFilter ? <Chip label='Clear ✕' onPress={props.onClear} /> : null}
            </ScrollView>

            {props.summary ? <Text style={styles.summary}>{props.summary}</Text> : null}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        paddingHorizontal: spacing.md,
        paddingTop: spacing.sm,
        gap: spacing.sm
    },
    searchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm
    },
    search: {
        flex: 1,
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        color: colors.text,
        fontSize: 15,
        paddingHorizontal: spacing.md,
        paddingVertical: 10
    },
    houseToggle: {
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        paddingHorizontal: spacing.md,
        minHeight: 42,
        justifyContent: 'center'
    },
    houseToggleActive: {
        borderColor: colors.brand
    },
    houseToggleText: {
        color: colors.textDim,
        fontSize: 13,
        fontWeight: '700'
    },
    houseToggleIcons: {
        flexDirection: 'row',
        gap: 3
    },
    houseStrip: {
        gap: spacing.sm,
        paddingVertical: 2,
        paddingRight: spacing.md
    },
    housePick: {
        alignItems: 'center',
        gap: 3,
        width: 62
    },
    housePickActive: {
        opacity: 1
    },
    housePickText: {
        color: colors.textFaint,
        fontSize: 10,
        fontWeight: '600'
    },
    sortRow: {
        gap: spacing.sm,
        paddingRight: spacing.md
    },
    chip: {
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: 14,
        paddingVertical: 7
    },
    chipActive: {
        backgroundColor: colors.brand,
        borderColor: colors.brand
    },
    chipText: {
        color: colors.textDim,
        fontSize: 12,
        fontWeight: '700'
    },
    chipTextActive: {
        color: '#161006'
    },
    summary: {
        color: colors.textFaint,
        fontSize: 11,
        fontWeight: '600'
    }
});
