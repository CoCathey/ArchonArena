import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * ARCHON: live round clock. Counts down from the round start against
 * the event's timer; turns amber under five minutes and red at zero
 * (rounds do not end themselves - the TO decides how to close them).
 */
const RoundTimer = ({ roundStartedAt, roundTimerMinutes }) => {
    const { t } = useTranslation();
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 1000);

        return () => clearInterval(interval);
    }, []);

    if (!roundStartedAt || !roundTimerMinutes) {
        return null;
    }

    const startedAt = new Date(
        roundStartedAt.endsWith && !roundStartedAt.endsWith('Z')
            ? `${roundStartedAt}Z`
            : roundStartedAt
    ).getTime();

    if (Number.isNaN(startedAt)) {
        return null;
    }

    const remainingMs = startedAt + roundTimerMinutes * 60 * 1000 - now;
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
