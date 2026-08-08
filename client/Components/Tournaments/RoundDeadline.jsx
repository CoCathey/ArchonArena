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
 * ARCHON (N14): the deadline of an asynchronous round.
 *
 * Distinct from RoundTimer, which counts a live round down in minutes and
 * seconds. A round measured in days needs the opposite emphasis: the date it
 * ends on, and how many days are left - a ticking mm:ss on a three-day window
 * is noise, and the same component trying to serve both would be a component
 * that reads badly in both.
 *
 * Ticks once a minute, which is all that a day-scale countdown can show.
 */
const RoundDeadline = ({ roundEndsAt }) => {
    const { t } = useTranslation();
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 60 * 1000);

        return () => clearInterval(interval);
    }, []);

    const deadline = asUtc(roundEndsAt);

    if (Number.isNaN(deadline)) {
        return null;
    }

    const remainingMs = deadline - now;
    const overdue = remainingMs <= 0;
    const absolute = Math.abs(remainingMs);
    const days = Math.floor(absolute / (24 * 60 * 60 * 1000));
    const hours = Math.floor((absolute % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const minutes = Math.floor((absolute % (60 * 60 * 1000)) / (60 * 1000));

    const amount =
        days > 0
            ? t('{{days}}d {{hours}}h', { days, hours })
            : hours > 0
            ? t('{{hours}}h {{minutes}}m', { hours, minutes })
            : t('{{minutes}}m', { minutes });

    const tone = overdue
        ? 'border-red-500/60 bg-red-500/10 text-red-400'
        : remainingMs < 24 * 60 * 60 * 1000
        ? 'border-amber-400/60 bg-amber-400/10 text-amber-300'
        : 'border-border/70 bg-surface-secondary/60 text-foreground';

    return (
        <span
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-sm font-semibold ${tone}`}
            title={t('Round deadline: {{time}}', {
                time: new Date(deadline).toLocaleString()
            })}
        >
            <svg viewBox='0 0 24 24' className='h-3.5 w-3.5' fill='none' aria-hidden='true'>
                <rect
                    x='3'
                    y='5'
                    width='18'
                    height='16'
                    rx='2'
                    stroke='currentColor'
                    strokeWidth='2'
                />
                <path d='M3 10h18M8 3v4M16 3v4' stroke='currentColor' strokeWidth='2' />
            </svg>
            {overdue
                ? t('Round overdue by {{amount}}', { amount })
                : t('{{amount}} left in round', { amount })}
        </span>
    );
};

RoundDeadline.displayName = 'RoundDeadline';

export default RoundDeadline;
