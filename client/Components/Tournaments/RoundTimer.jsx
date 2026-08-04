import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Timestamps come back from Postgres without a zone; they are UTC. */
const asUtc = (value) => {
    if (!value) {
        return NaN;
    }

    const text = typeof value === 'string' ? value : String(value);

    return new Date(text.endsWith('Z') ? text : `${text}Z`).getTime();
};

/**
 * ARCHON: live round clock. Counts down to the round's deadline; turns
 * amber under five minutes and red at zero (rounds do not end themselves
 * - the TO decides how to close them, and can extend the clock).
 *
 * `roundEndsAt` is the event's stored deadline and wins when it is set,
 * so an extension shows up here rather than every client insisting on
 * start + timer. The derived value remains as the fallback for events
 * paired before deadlines were recorded.
 */
const RoundTimer = ({ roundStartedAt, roundTimerMinutes, roundEndsAt }) => {
    const { t } = useTranslation();
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 1000);

        return () => clearInterval(interval);
    }, []);

    const deadline = roundEndsAt
        ? asUtc(roundEndsAt)
        : roundStartedAt && roundTimerMinutes
        ? asUtc(roundStartedAt) + roundTimerMinutes * 60 * 1000
        : NaN;

    if (Number.isNaN(deadline)) {
        return null;
    }

    const remainingMs = deadline - now;
    const overtime = remainingMs <= 0;
    const absolute = Math.abs(remainingMs);
    const minutes = Math.floor(absolute / 60000);
    const seconds = Math.floor((absolute % 60000) / 1000);
    const display = `${overtime ? '+' : ''}${minutes}:${String(seconds).padStart(2, '0')}`;

    const tone = overtime
        ? 'border-red-500/60 bg-red-500/10 text-red-400'
        : remainingMs < 5 * 60 * 1000
        ? 'border-amber-400/60 bg-amber-400/10 text-amber-300'
        : 'border-border/70 bg-surface-secondary/60 text-foreground';

    return (
        <span
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-sm font-bold ${tone}`}
            title={t('Round timer')}
        >
            <svg viewBox='0 0 24 24' className='h-3.5 w-3.5' fill='none' aria-hidden='true'>
                <circle cx='12' cy='13' r='8' stroke='currentColor' strokeWidth='2' />
                <path d='M12 9v4l2.5 2.5M9 2h6' stroke='currentColor' strokeWidth='2' />
            </svg>
            {display}
            {overtime && <span className='text-xs font-normal'>{t('overtime')}</span>}
        </span>
    );
};

RoundTimer.displayName = 'RoundTimer';

export default RoundTimer;
