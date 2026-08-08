import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../theme';

export interface BarItem {
    key: string;
    label: string;
    /** Bar length, as a percentage of `max`. */
    value: number | null | undefined;
    /** Rendered at the trailing edge, e.g. "54%" or "12 games". */
    display?: string;
    sub?: string;
    icon?: React.ReactNode;
    highlight?: boolean;
}

/**
 * A compact horizontal bar chart. Phones have no room for axes and gridlines,
 * so each row carries its own number and the optional 50% marker does the work
 * a baseline would.
 */
export default function BarList(props: {
    items: BarItem[];
    /** Bar scale; defaults to 100 (percentages). */
    max?: number;
    /** Draw a reference line at this value — 50 for win rates. */
    marker?: number;
    emptyText?: string;
}) {
    const max = props.max ?? 100;

    if (props.items.length === 0) {
        return <Text style={styles.empty}>{props.emptyText ?? 'Nothing to show yet.'}</Text>;
    }

    return (
        <View>
            {props.items.map((item) => {
                const value = item.value ?? 0;
                const width = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
                const missing = item.value === null || item.value === undefined;
                return (
                    <View key={item.key} style={styles.row}>
                        <View style={styles.labelCell}>
                            {item.icon}
                            <Text style={styles.label} numberOfLines={1}>
                                {item.label}
                            </Text>
                        </View>
                        <View style={styles.trackCell}>
                            <View style={styles.track}>
                                {missing ? null : (
                                    <View
                                        style={[
                                            styles.fill,
                                            { width: `${width}%` },
                                            item.highlight && { backgroundColor: colors.brand }
                                        ]}
                                    />
                                )}
                                {props.marker !== undefined && max > 0 ? (
                                    <View
                                        style={[
                                            styles.marker,
                                            { left: `${(props.marker / max) * 100}%` }
                                        ]}
                                    />
                                ) : null}
                            </View>
                            {item.sub ? <Text style={styles.sub}>{item.sub}</Text> : null}
                        </View>
                        <Text style={styles.value}>{missing ? '—' : item.display ?? value}</Text>
                    </View>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingVertical: 5
    },
    labelCell: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        width: 96
    },
    label: {
        color: colors.textDim,
        fontSize: 11,
        flexShrink: 1,
        textTransform: 'capitalize'
    },
    trackCell: {
        flex: 1
    },
    track: {
        height: 8,
        borderRadius: 4,
        backgroundColor: colors.bgElevated,
        overflow: 'hidden'
    },
    fill: {
        height: '100%',
        backgroundColor: colors.accent,
        borderRadius: 4
    },
    marker: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: 1,
        backgroundColor: colors.borderLight
    },
    sub: {
        color: colors.textFaint,
        fontSize: 9,
        marginTop: 2
    },
    value: {
        color: colors.text,
        fontSize: 11,
        fontWeight: '800',
        fontVariant: ['tabular-nums'],
        width: 44,
        textAlign: 'right'
    },
    empty: {
        color: colors.textFaint,
        fontSize: 12,
        paddingVertical: spacing.md
    }
});
