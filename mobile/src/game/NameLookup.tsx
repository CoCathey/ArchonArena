import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radius, spacing } from '../theme';
import { useCardsStore } from '../stores/cardsStore';

/**
 * ARCHON: the "name a card" / "name a trait" prompts, on a phone.
 *
 * A handful of cards (Etan's Jar, Dark Discovery, Varghast's Vengeance;
 * Harvest Time and Congregate for traits) ask the player to name something
 * rather than pick it off the board. The engine sends these as a prompt
 * carrying a `card-name` / `trait-name` control and NO buttons — so an app
 * that renders only buttons showed an empty prompt and the game could not
 * proceed. That is the one class of bug that looks to a player like the app
 * has frozen, because it has: nothing they can tap advances the turn.
 *
 * The web client uses a dropdown typeahead (`CardNameLookup.jsx`). At 390
 * points wide a dropdown over ~1500 card names is unusable, so this is a
 * search field over a bounded result list: type a few letters, tap the name.
 * Tapping IS the answer — there is no second "Done" step, because the list
 * only ever shows exact candidates and a confirm button on a phone is one
 * more tap between the player and their turn.
 *
 * The names come from the card dictionary the app already caches
 * (stores/cardsStore), so this ships no card data of its own.
 */

/** Never render more than this many rows — the rest are one more letter away. */
const MAX_RESULTS = 40;

/** Below this many characters, show the (alphabetical) head of the list. */
const MIN_QUERY = 1;

export function useCardNames(): string[] {
    const cards = useCardsStore((state) => state.cards);

    return useMemo(() => {
        const names = new Set<string>();
        for (const card of Object.values(cards ?? {})) {
            if (card?.name) {
                names.add(card.name);
            }
        }

        return [...names].sort((a, b) => a.localeCompare(b));
    }, [cards]);
}

export function useTraitNames(): string[] {
    const cards = useCardsStore((state) => state.cards);

    return useMemo(() => {
        const traits = new Set<string>();
        for (const card of Object.values(cards ?? {})) {
            for (const trait of card?.traits ?? []) {
                const clean = String(trait).trim();
                if (clean) {
                    traits.add(clean);
                }
            }
        }

        return [...traits].sort((a, b) => a.localeCompare(b));
    }, [cards]);
}

/**
 * Search field over `values`, with the matches as tappable rows.
 *
 * `loading` covers the window where the card dictionary is still being
 * fetched: an empty list with no explanation reads as "there is nothing to
 * name", which is never true here.
 */
export default function NameLookup(props: {
    values: string[];
    placeholder: string;
    loading?: boolean;
    onSelect: (value: string) => void;
}) {
    const [query, setQuery] = useState('');

    const matches = useMemo(() => {
        const term = query.trim().toLowerCase();
        if (term.length < MIN_QUERY) {
            return props.values.slice(0, MAX_RESULTS);
        }

        // Names that START with the term first — someone typing "dark" wants
        // Dark Discovery before Into the Dark — then anything else containing
        // it, so a half-remembered middle word still finds the card.
        const starts: string[] = [];
        const contains: string[] = [];
        for (const value of props.values) {
            const lower = value.toLowerCase();
            if (lower.startsWith(term)) {
                starts.push(value);
            } else if (lower.includes(term)) {
                contains.push(value);
            }
            if (starts.length >= MAX_RESULTS) {
                break;
            }
        }

        return [...starts, ...contains].slice(0, MAX_RESULTS);
    }, [props.values, query]);

    return (
        <View style={styles.container}>
            <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder={props.placeholder}
                placeholderTextColor={colors.textFaint}
                autoCapitalize='none'
                autoCorrect={false}
                style={styles.input}
            />
            {props.loading && props.values.length === 0 ? (
                <Text style={styles.hint}>Loading card names…</Text>
            ) : matches.length === 0 ? (
                <Text style={styles.hint}>Nothing matches “{query.trim()}”.</Text>
            ) : (
                <ScrollView
                    style={styles.list}
                    keyboardShouldPersistTaps='handled'
                    nestedScrollEnabled
                >
                    {matches.map((value) => (
                        <Pressable
                            key={value}
                            onPress={() => props.onSelect(value)}
                            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                        >
                            <Text style={styles.rowText}>{value}</Text>
                        </Pressable>
                    ))}
                </ScrollView>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        marginTop: spacing.sm
    },
    input: {
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        color: colors.text,
        fontSize: 15,
        paddingHorizontal: spacing.md,
        paddingVertical: 9
    },
    list: {
        marginTop: spacing.sm,
        maxHeight: 190,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        backgroundColor: colors.bgElevated
    },
    row: {
        paddingHorizontal: spacing.md,
        paddingVertical: 10,
        borderBottomColor: colors.border,
        borderBottomWidth: StyleSheet.hairlineWidth
    },
    rowPressed: {
        backgroundColor: colors.surfaceHover
    },
    rowText: {
        color: colors.text,
        fontSize: 15
    },
    hint: {
        color: colors.textFaint,
        fontSize: 12,
        marginTop: spacing.sm
    }
});
