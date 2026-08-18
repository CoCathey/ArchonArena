import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
    fetchAercAnalytics,
    type AercBand,
    type AercFinding,
    type AercTrait
} from '../api/premium';
import BarList, { type BarItem } from '../ui/BarList';
import { colors, radius, spacing } from '../theme';

/**
 * ARCHON (N12): AERC analytics — your record read in AERC terms.
 *
 * Two questions, and they are not the same one asked twice: which kind of deck
 * do you play well (your own trait bands), and which kind beats you (the
 * opponent's). The website draws both plus a house cross-tab, a meta profile
 * and a per-card table; at 390 points wide those last three are unreadable, so
 * this carries the two band charts and the findings — the part that says
 * something in a sentence.
 *
 * Bands come from site-wide quartiles, so "High" means high against every deck
 * on the platform rather than against this player's own collection.
 */

function bandItems(bands: AercBand[] | undefined, minConfident: number): BarItem[] {
    return (bands ?? []).map((band) => ({
        key: band.band,
        label: band.band,
        // Percentages, to match BarList's default 0–100 scale.
        value: band.winRate === null || band.winRate === undefined ? null : band.winRate * 100,
        // A band with two games is drawn but marked: the number is real and
        // means nothing.
        sub: band.confident
            ? `${band.wins}–${band.losses}`
            : `${band.wins}–${band.losses} · under ${minConfident} games`,
        display:
            band.winRate === null || band.winRate === undefined
                ? '—'
                : `${Math.round(band.winRate * 100)}%`
    }));
}

function FindingLine(props: { finding: AercFinding }) {
    const { finding } = props;
    const gap = Math.round(finding.gap * 100);

    return (
        <View style={styles.finding}>
            <Text style={styles.findingText}>
                {finding.side === 'own'
                    ? `Your own ${finding.label}: `
                    : `Against ${finding.label}: `}
                <Text style={styles.findingStrong}>
                    {Math.round((finding.best.winRate ?? 0) * 100)}% in the {finding.best.band}{' '}
                    band
                </Text>{' '}
                against {Math.round((finding.worst.winRate ?? 0) * 100)}% in {finding.worst.band}.
            </Text>
            <Text style={styles.findingMeta}>
                {gap} point spread over {finding.games} games
            </Text>
        </View>
    );
}

export default function AercSection() {
    const [traits, setTraits] = useState<AercTrait[]>([]);
    const [trait, setTrait] = useState('amberControl');
    const [own, setOwn] = useState<AercBand[] | undefined>();
    const [opponent, setOpponent] = useState<AercBand[] | undefined>();
    const [findings, setFindings] = useState<AercFinding[]>([]);
    const [minConfident, setMinConfident] = useState(10);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const load = useCallback(async (wanted: string) => {
        setLoading(true);
        setError(undefined);
        try {
            const result = await fetchAercAnalytics(wanted);
            if (result.traits?.length) {
                setTraits(result.traits);
            }
            setOwn(result.own?.bands);
            setOpponent(result.opponent?.bands);
            setFindings(result.findings ?? []);
            if (result.minConfidentGames) {
                setMinConfident(result.minConfidentGames);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load AERC analytics');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load(trait);
    }, [load, trait]);

    const ownItems = bandItems(own, minConfident);
    const opponentItems = bandItems(opponent, minConfident);

    return (
        <View>
            <Text style={styles.hint}>
                Your record split by one AERC trait. Bands are cut at the site-wide quartiles, so
                “High” means high across the platform rather than across your own decks.
            </Text>

            <View style={styles.chipRow}>
                {(traits.length ? traits : [{ key: trait, label: trait, short: '' }]).map(
                    (entry) => (
                        <Pressable
                            key={entry.key}
                            onPress={() => setTrait(entry.key)}
                            style={[styles.chip, trait === entry.key && styles.chipActive]}
                        >
                            <Text
                                style={[
                                    styles.chipText,
                                    trait === entry.key && styles.chipTextActive
                                ]}
                            >
                                {entry.label}
                            </Text>
                        </Pressable>
                    )
                )}
            </View>

            {error ? <Text style={styles.error}>{error}</Text> : null}
            {loading ? <ActivityIndicator color={colors.brand} style={{ marginTop: 12 }} /> : null}

            {ownItems.length > 0 ? (
                <View style={styles.block}>
                    <Text style={styles.blockTitle}>With your own decks</Text>
                    <BarList items={ownItems} marker={50} />
                </View>
            ) : null}

            {opponentItems.length > 0 ? (
                <View style={styles.block}>
                    <Text style={styles.blockTitle}>Against decks like that</Text>
                    <BarList items={opponentItems} marker={50} />
                </View>
            ) : null}

            {findings.length > 0 ? (
                <View style={styles.block}>
                    <Text style={styles.blockTitle}>What stands out</Text>
                    {findings.slice(0, 4).map((finding) => (
                        <FindingLine key={`${finding.side}-${finding.trait}`} finding={finding} />
                    ))}
                </View>
            ) : null}

            {!loading && ownItems.length === 0 && opponentItems.length === 0 && !error ? (
                <Text style={styles.hint}>
                    Not enough rated games with SAS-rated decks yet for this to say anything.
                </Text>
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
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: 10,
        paddingVertical: 5,
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
    block: {
        marginTop: spacing.lg
    },
    blockTitle: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '700',
        marginBottom: 6
    },
    finding: {
        paddingVertical: 6,
        borderTopColor: colors.border,
        borderTopWidth: StyleSheet.hairlineWidth
    },
    findingText: {
        color: colors.textDim,
        fontSize: 13,
        lineHeight: 19
    },
    findingStrong: {
        color: colors.text,
        fontWeight: '700'
    },
    findingMeta: {
        color: colors.textFaint,
        fontSize: 11,
        marginTop: 2
    },
    error: {
        color: '#ff8f93',
        fontSize: 12,
        marginTop: spacing.sm
    }
});
