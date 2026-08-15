import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { HouseRow, RatingHistoryEntry, SetRow } from '../api/types';
import { colors, radius, spacing } from '../theme';

/**
 * ARCHON (N12): the shared pieces of Archon Intelligence, ported from the web
 * page so both platforms present the same numbers the same way.
 *
 * Nothing here invents a value. Every metric the server could not compute
 * arrives as `available: false` with a reason, and these render an em dash
 * rather than a zero — a fabricated 0% win rate is worse than an obvious gap.
 */

export const pct = (value: number | null | undefined) =>
    value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;

export const num = (value: number | null | undefined, digits = 1) =>
    value === null || value === undefined ? '—' : Number(value).toFixed(digits);

export const duration = (seconds: number | null | undefined) => {
    if (seconds === null || seconds === undefined) {
        return '—';
    }

    return `${Math.round(seconds / 60)} min`;
};

export const signed = (value: number | null | undefined, digits = 0) =>
    value === null || value === undefined
        ? '—'
        : `${value >= 0 ? '+' : ''}${digits ? value.toFixed(digits) : Math.round(value)}`;

/** One headline number. */
export function Stat(props: {
    label: string;
    value: string | number;
    hint?: string;
    tone?: 'good' | 'bad';
}) {
    const toneColor =
        props.tone === 'good' ? colors.success : props.tone === 'bad' ? colors.danger : colors.text;

    return (
        <View style={styles.stat}>
            <Text style={styles.statLabel}>{props.label.toUpperCase()}</Text>
            <Text style={[styles.statValue, { color: toneColor }]}>{String(props.value)}</Text>
            {props.hint ? <Text style={styles.statHint}>{props.hint}</Text> : null}
        </View>
    );
}

/** Two-per-row grid of Stats. Four across is unreadable on a phone. */
export function StatGrid(props: { children: React.ReactNode }) {
    return <View style={styles.statGrid}>{props.children}</View>;
}

/**
 * A house win-rate bar. Green at or above even, red below — the same reading
 * the web page gives, so a player switching devices is not re-learning it.
 */
export function HouseBar(props: { row: HouseRow; showPrevalence?: boolean }) {
    const { row, showPrevalence } = props;
    const value = showPrevalence ? row.prevalence : row.winRate;
    // Prevalence sums to 300% across houses (every deck contributes three), so
    // it is scaled to stay inside the track instead of pinning every bar full.
    const width = Math.max(0, Math.min(100, Math.round((value ?? 0) * 100 * (showPrevalence ? 3 : 1))));
    const fill = showPrevalence
        ? colors.accent
        : (row.winRate ?? 0) >= 0.5
          ? colors.success
          : colors.danger;

    return (
        <View style={styles.barRow}>
            <Text numberOfLines={1} style={styles.barLabel}>
                {row.houseName || row.house}
            </Text>
            <View style={styles.barTrack}>
                <View style={[styles.barFill, { width: `${width}%`, backgroundColor: fill }]} />
            </View>
            <Text style={styles.barValue}>{pct(value)}</Text>
            {showPrevalence ? null : <Text style={styles.barGames}>{row.games}g</Text>}
        </View>
    );
}

/**
 * A set row: name, win rate, and how much of the sample it is.
 *
 * The share is drawn at true scale, unlike the house bar — a deck has three
 * houses but exactly one set, so these really do sum to 100% and can be read as
 * proportions of the whole.
 */
export function SetBar(props: { row: SetRow }) {
    const { row } = props;
    const width = Math.max(0, Math.min(100, Math.round((row.winRate ?? 0) * 100)));

    return (
        <View style={styles.barRow}>
            <Text numberOfLines={1} style={styles.barLabel}>
                {row.set?.name || row.set?.code || '—'}
            </Text>
            <View style={styles.barTrack}>
                <View
                    style={[
                        styles.barFill,
                        {
                            width: `${width}%`,
                            backgroundColor:
                                (row.winRate ?? 0) >= 0.5 ? colors.success : colors.danger
                        }
                    ]}
                />
            </View>
            <Text style={styles.barValue}>{pct(row.winRate)}</Text>
            <Text style={styles.barGames}>{row.games}g</Text>
        </View>
    );
}

/**
 * Rating over time, drawn as a column of bars rather than a line.
 *
 * The web page uses an inline SVG polyline; react-native-svg is not a
 * dependency here and adding one for a single sparkline is not worth it. Bars
 * off the series minimum carry the same information — where it climbed and
 * where it fell — with nothing but views.
 */
export function RatingSparkline(props: { history: RatingHistoryEntry[] }) {
    const history = props.history.slice(-60);

    if (history.length < 2) {
        return null;
    }

    const ratings = history.map((entry) => entry.ratingAfter);
    const min = Math.min(...ratings);
    const max = Math.max(...ratings);
    // A flat series would divide by zero and collapse every bar to nothing.
    const span = max - min || 1;

    return (
        <View style={styles.sparkline}>
            {history.map((entry, index) => (
                <View
                    key={index}
                    style={{
                        flex: 1,
                        marginHorizontal: 0.5,
                        height: `${Math.max(4, ((entry.ratingAfter - min) / span) * 100)}%`,
                        backgroundColor: entry.won ? colors.success : colors.danger,
                        opacity: 0.75,
                        borderRadius: 1
                    }}
                />
            ))}
        </View>
    );
}

/** Recent results, newest last so it reads left to right. */
export function FormStrip(props: { results: { won: boolean }[] }) {
    if (!props.results.length) {
        return <Text style={styles.muted}>—</Text>;
    }

    return (
        <View style={styles.formStrip}>
            {[...props.results].reverse().map((result, index) => (
                <View
                    key={index}
                    style={[
                        styles.formCell,
                        {
                            backgroundColor: result.won ? 'rgba(70,167,88,0.25)' : 'rgba(229,72,77,0.25)'
                        }
                    ]}
                >
                    <Text
                        style={[
                            styles.formCellText,
                            { color: result.won ? colors.success : colors.danger }
                        ]}
                    >
                        {result.won ? 'W' : 'L'}
                    </Text>
                </View>
            ))}
        </View>
    );
}

/** Section heading inside a card. */
export function SectionLabel(props: { children: React.ReactNode }) {
    return <Text style={styles.sectionLabel}>{props.children}</Text>;
}

export function Muted(props: { children: React.ReactNode }) {
    return <Text style={styles.muted}>{props.children}</Text>;
}

const styles = StyleSheet.create({
    stat: {
        flexGrow: 1,
        flexBasis: '47%',
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.sm,
        backgroundColor: colors.bgElevated,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm
    },
    statGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm
    },
    statLabel: {
        color: colors.textFaint,
        fontSize: 10,
        letterSpacing: 0.6,
        fontWeight: '600'
    },
    statValue: {
        fontSize: 18,
        fontWeight: '700',
        marginTop: 2
    },
    statHint: {
        color: colors.textFaint,
        fontSize: 10,
        marginTop: 1
    },
    barRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginBottom: 6
    },
    barLabel: {
        color: colors.text,
        fontSize: 12,
        width: 96
    },
    barTrack: {
        flex: 1,
        height: 8,
        borderRadius: 4,
        backgroundColor: colors.surface,
        overflow: 'hidden'
    },
    barFill: {
        height: '100%',
        borderRadius: 4
    },
    barValue: {
        color: colors.text,
        fontSize: 12,
        width: 40,
        textAlign: 'right'
    },
    barGames: {
        color: colors.textFaint,
        fontSize: 11,
        width: 34,
        textAlign: 'right'
    },
    sparkline: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        height: 64,
        marginTop: spacing.sm
    },
    formStrip: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 2
    },
    formCell: {
        width: 16,
        height: 16,
        borderRadius: 3,
        alignItems: 'center',
        justifyContent: 'center'
    },
    formCellText: {
        fontSize: 9,
        fontWeight: '700'
    },
    sectionLabel: {
        color: colors.textFaint,
        fontSize: 10,
        letterSpacing: 0.6,
        fontWeight: '600',
        marginBottom: spacing.xs,
        textTransform: 'uppercase'
    },
    muted: {
        color: colors.textDim,
        fontSize: 12,
        lineHeight: 17
    }
});
