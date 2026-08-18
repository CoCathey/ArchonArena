import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { fetchDeckComparison, type ComparedDeck } from '../api/premium';
import type { DeckRanking } from '../api/types';
import { colors, radius, spacing } from '../theme';

/**
 * ARCHON (N12): deck comparison — the same decks' records read side by side.
 *
 * Distinct from the Tournament Lab, which asks "which of these should I bring
 * to an event" and answers with rating swing and recent form. This asks the
 * plainer question: what do these decks actually do, in columns.
 *
 * At 390 points wide four columns of numbers do not fit, so the comparison is
 * transposed — one row per statistic, one column per deck — and scrolls
 * sideways. That keeps a like-for-like comparison readable, which a stack of
 * per-deck cards would not.
 */

const MAX_COMPARED = 4;

function percent(value?: number | null): string {
    return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

/** The rows, in the order somebody reads them: record first, detail after. */
const ROWS: { label: string; value: (deck: ComparedDeck) => string }[] = [
    { label: 'Games', value: (deck) => String(deck.overview?.games ?? 0) },
    {
        label: 'Record',
        value: (deck) => `${deck.overview?.wins ?? 0}–${deck.overview?.losses ?? 0}`
    },
    { label: 'Win rate', value: (deck) => percent(deck.overview?.winRate as number | null) },
    { label: 'SAS', value: (deck) => (deck.sas ? String(Math.round(deck.sas)) : '—') },
    { label: 'Set', value: (deck) => deck.set?.label ?? '—' }
];

export default function DeckComparisonSection(props: { decks: DeckRanking[] }) {
    const [selected, setSelected] = useState<number[]>([]);
    const [compared, setCompared] = useState<ComparedDeck[]>([]);
    const [minConfident, setMinConfident] = useState(10);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const toggle = (deckId: number) =>
        setSelected((current) =>
            current.includes(deckId)
                ? current.filter((id) => id !== deckId)
                : current.length >= MAX_COMPARED
                ? current
                : [...current, deckId]
        );

    const load = useCallback(async (deckIds: number[]) => {
        if (deckIds.length < 2) {
            setCompared([]);

            return;
        }

        setLoading(true);
        setError(undefined);
        try {
            const result = await fetchDeckComparison(deckIds);
            setCompared(result.decks ?? []);
            if (result.minConfidentGames) {
                setMinConfident(result.minConfidentGames);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not compare those decks');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load(selected);
    }, [load, selected]);

    return (
        <View>
            <Text style={styles.hint}>
                Pick two to {MAX_COMPARED} of your decks. Everything here is your own record with
                them, not what a rating service predicts.
            </Text>

            <View style={styles.chipRow}>
                {props.decks.slice(0, 16).map((deck) => {
                    const active = selected.includes(deck.deckId);
                    const full = !active && selected.length >= MAX_COMPARED;

                    return (
                        <Pressable
                            key={deck.deckId}
                            onPress={() => toggle(deck.deckId)}
                            disabled={full}
                            style={[
                                styles.chip,
                                active && styles.chipActive,
                                full && { opacity: 0.35 }
                            ]}
                        >
                            <Text
                                numberOfLines={1}
                                style={[styles.chipText, active && styles.chipTextActive]}
                            >
                                {deck.deckName}
                            </Text>
                            <Text style={styles.chipGames}>{deck.games}g</Text>
                        </Pressable>
                    );
                })}
            </View>

            {error ? <Text style={styles.error}>{error}</Text> : null}
            {loading ? <ActivityIndicator color={colors.brand} style={{ marginTop: 12 }} /> : null}

            {compared.length >= 2 ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.table}>
                    <View>
                        <View style={styles.headerRow}>
                            <View style={styles.labelCell} />
                            {compared.map((deck) => (
                                <View key={deck.deckId} style={styles.cell}>
                                    <Text style={styles.deckName} numberOfLines={2}>
                                        {deck.deckName}
                                    </Text>
                                    {deck.confident === false ? (
                                        <Text style={styles.thin}>
                                            under {minConfident} games
                                        </Text>
                                    ) : null}
                                </View>
                            ))}
                        </View>

                        {ROWS.map((row) => (
                            <View key={row.label} style={styles.row}>
                                <View style={styles.labelCell}>
                                    <Text style={styles.rowLabel}>{row.label}</Text>
                                </View>
                                {compared.map((deck) => (
                                    <View key={deck.deckId} style={styles.cell}>
                                        <Text style={styles.value}>{row.value(deck)}</Text>
                                    </View>
                                ))}
                            </View>
                        ))}
                    </View>
                </ScrollView>
            ) : selected.length === 1 ? (
                <Text style={styles.hint}>Pick one more deck to compare.</Text>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    hint: {
        color: colors.textFaint,
        fontSize: 12,
        lineHeight: 17,
        marginBottom: spacing.sm
    },
    chipRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: 10,
        paddingVertical: 5,
        backgroundColor: colors.bgElevated,
        maxWidth: 190
    },
    chipActive: {
        borderColor: colors.brand,
        backgroundColor: colors.surfaceHover
    },
    chipText: {
        color: colors.textDim,
        fontSize: 12,
        fontWeight: '600',
        flexShrink: 1
    },
    chipTextActive: {
        color: colors.brand
    },
    chipGames: {
        color: colors.textFaint,
        fontSize: 10
    },
    table: {
        marginTop: spacing.md
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        borderBottomColor: colors.border,
        borderBottomWidth: 1,
        paddingBottom: 6
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 7,
        borderBottomColor: colors.border,
        borderBottomWidth: StyleSheet.hairlineWidth
    },
    labelCell: {
        width: 84
    },
    cell: {
        width: 112,
        paddingHorizontal: 4
    },
    deckName: {
        color: colors.text,
        fontSize: 12,
        fontWeight: '700'
    },
    thin: {
        color: colors.warning,
        fontSize: 9,
        marginTop: 2
    },
    rowLabel: {
        color: colors.textFaint,
        fontSize: 11,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.3
    },
    value: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '700'
    },
    error: {
        color: '#ff8f93',
        fontSize: 12,
        marginTop: spacing.sm
    }
});
