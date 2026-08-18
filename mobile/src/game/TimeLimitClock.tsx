import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../theme';

/**
 * ARCHON: the game time limit, counting down on the board.
 *
 * The app has always let a player CREATE a timed game — the option is on the
 * new-game form and the fields ride along in every game state — but the board
 * never drew the clock, so the one number the format is built around was
 * invisible on a phone. Mirrors client/Components/GameBoard/TimeLimitClock.jsx.
 *
 * Ticks locally off the server's start timestamp rather than off a countdown
 * the server pushes: state updates arrive when something happens, and nothing
 * happening is exactly when a clock has to keep moving.
 */

function formatTime(totalSeconds: number): string {
    if (totalSeconds <= 0) {
        return '00:00';
    }

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Under this many seconds the clock turns red — the last-minute warning. */
const WARN_SECONDS = 60;

export default function TimeLimitClock(props: {
    /** Length of the limit in minutes, as the game was created. */
    timeLimit?: number;
    /** Whether the clock is running (the engine starts it on the first turn). */
    started?: boolean;
    /** When it started, as an ISO string or epoch millis. */
    startedAt?: number | string;
    /** Freeze the display — the game is over. */
    paused?: boolean;
}) {
    const { timeLimit, started, startedAt, paused } = props;

    const [remaining, setRemaining] = useState<number | undefined>(() =>
        timeLimit ? timeLimit * 60 : undefined
    );

    useEffect(() => {
        if (!timeLimit || paused) {
            return undefined;
        }

        if (!started) {
            // Started-at with the clock stopped means it ran out; no
            // started-at at all means it has not begun yet.
            setRemaining(startedAt ? 0 : timeLimit * 60);
            return undefined;
        }

        const endsAt = new Date(startedAt ?? Date.now()).getTime() + timeLimit * 60000;
        const tick = () =>
            setRemaining(Math.max(0, Math.floor((endsAt - Date.now()) / 1000)));

        tick();
        const timer = setInterval(tick, 1000);

        return () => clearInterval(timer);
    }, [timeLimit, started, startedAt, paused]);

    if (!timeLimit || remaining === undefined) {
        return null;
    }

    const low = started && remaining <= WARN_SECONDS;

    return (
        <View style={[styles.container, low && styles.containerLow]}>
            <Text style={styles.label}>{started ? 'Time left' : 'Time limit'}</Text>
            <Text style={[styles.clock, low && styles.clockLow]}>{formatTime(remaining)}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'center',
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: spacing.md,
        paddingVertical: 3,
        marginTop: 4
    },
    containerLow: {
        borderColor: colors.danger
    },
    label: {
        color: colors.textFaint,
        fontSize: 10,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.5
    },
    clock: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '800',
        fontVariant: ['tabular-nums']
    },
    clockLow: {
        color: colors.danger
    }
});
