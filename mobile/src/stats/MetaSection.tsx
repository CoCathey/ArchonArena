import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { fetchMetaStats } from '../api/client';
import type { MetaStats } from '../api/types';
import { colors, spacing } from '../theme';
import BarList, { type BarItem } from '../ui/BarList';
import HouseIcon from '../ui/HouseIcon';
import { Card, EmptyState, ErrorBanner } from '../ui/primitives';

function percent(value?: number | null): string {
    return typeof value === 'number' ? `${value.toFixed(0)}%` : '—';
}

function StatTile(props: { label: string; value: string; hint?: string }) {
    return (
        <View style={styles.tile}>
            <Text style={styles.tileValue}>{props.value}</Text>
            <Text style={styles.tileLabel}>{props.label}</Text>
            {props.hint ? <Text style={styles.tileHint}>{props.hint}</Text> : null}
        </View>
    );
}

/**
 * Platform-wide numbers: how often each house, set and deck-power band actually
 * wins. The web page charts these; on a phone they read better as ranked bars
 * with a 50% reference line.
 */
export default function MetaSection() {
    const [stats, setStats] = useState<MetaStats | undefined>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const load = useCallback(async () => {
        setLoading(true);
        setError(undefined);
        try {
            const result = await fetchMetaStats();
            setStats(result.stats);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load platform statistics');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const totals = stats?.totals;
    const avgMinutes = totals?.avgDurationSec
        ? `${Math.max(1, Math.round(totals.avgDurationSec / 60))} min`
        : '—';

    const houseItems: BarItem[] = (stats?.houses ?? []).map((house) => ({
        key: house.house,
        label: house.house,
        value: house.winRate,
        display: percent(house.winRate),
        sub: `${house.games} games`,
        icon: <HouseIcon house={house.house.toLowerCase()} size={15} />
    }));

    const bandItems: BarItem[] = (stats?.sasBands ?? []).map((band) => ({
        key: band.band,
        label: band.band,
        value: band.winRate,
        display: percent(band.winRate),
        sub: `${band.games} games`
    }));

    const setItems: BarItem[] = (stats?.sets ?? []).map((set) => ({
        key: `${set.expansionId ?? set.set}`,
        label: set.set,
        value: set.winRate,
        display: percent(set.winRate),
        sub: `${set.games} games`
    }));

    const formatItems: BarItem[] = (stats?.formats ?? []).map((format) => ({
        key: format.format,
        label: format.format,
        value: format.share,
        display: typeof format.share === 'number' ? `${format.share.toFixed(0)}%` : '—',
        sub: `${format.games} games`
    }));

    return (
        <ScrollView
            contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
            refreshControl={
                <RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.textDim} />
            }
        >
            <ErrorBanner message={error} />

            {loading && !stats ? (
                <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.xl }} />
            ) : null}

            {totals ? (
                <Card style={{ marginBottom: spacing.sm }}>
                    <View style={styles.tileGrid}>
                        <StatTile
                            label='games played'
                            value={totals.finishedGames.toLocaleString()}
                        />
                        <StatTile
                            label='decided'
                            value={totals.decidedGames.toLocaleString()}
                            hint='with a winner'
                        />
                        <StatTile label='avg length' value={avgMinutes} />
                        <StatTile
                            label='avg keys'
                            value={
                                typeof totals.avgKeys === 'number' ? totals.avgKeys.toFixed(1) : '—'
                            }
                            hint='per player'
                        />
                    </View>
                </Card>
            ) : null}

            {houseItems.length > 0 ? (
                <Card style={{ marginBottom: spacing.sm }}>
                    <Text style={styles.sectionTitle}>Win rate by house</Text>
                    <BarList items={houseItems} marker={50} />
                </Card>
            ) : null}

            {bandItems.length > 0 ? (
                <Card style={{ marginBottom: spacing.sm }}>
                    <Text style={styles.sectionTitle}>Win rate by deck power</Text>
                    <Text style={styles.sectionHint}>
                        How often decks in each SAS band win. The line marks an even 50%.
                    </Text>
                    <BarList items={bandItems} marker={50} />
                </Card>
            ) : null}

            {setItems.length > 0 ? (
                <Card style={{ marginBottom: spacing.sm }}>
                    <Text style={styles.sectionTitle}>Win rate by set</Text>
                    <BarList items={setItems} marker={50} />
                </Card>
            ) : null}

            {formatItems.length > 0 ? (
                <Card style={{ marginBottom: spacing.sm }}>
                    <Text style={styles.sectionTitle}>Format popularity</Text>
                    <Text style={styles.sectionHint}>
                        Share of finished games played in each format.
                    </Text>
                    <BarList items={formatItems} />
                </Card>
            ) : null}

            {stats?.generatedAt ? (
                <Text style={styles.footnote}>
                    Updated {new Date(stats.generatedAt).toLocaleString()}
                </Text>
            ) : null}

            {!loading && !stats && !error ? (
                <EmptyState
                    title='No platform statistics yet'
                    subtitle='These appear once games have been played on the site.'
                />
            ) : null}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    tileGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        rowGap: spacing.md
    },
    tile: {
        width: '50%'
    },
    tileValue: {
        color: colors.text,
        fontSize: 20,
        fontWeight: '800'
    },
    tileLabel: {
        color: colors.textDim,
        fontSize: 11,
        marginTop: 2
    },
    tileHint: {
        color: colors.textFaint,
        fontSize: 10
    },
    sectionTitle: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '800',
        marginBottom: 4
    },
    sectionHint: {
        color: colors.textFaint,
        fontSize: 11,
        marginBottom: spacing.sm,
        lineHeight: 15
    },
    footnote: {
        color: colors.textFaint,
        fontSize: 10,
        textAlign: 'center',
        marginTop: spacing.sm
    }
});
