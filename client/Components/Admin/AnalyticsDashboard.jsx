import React from 'react';
import { useTranslation } from 'react-i18next';

import Panel from '../Site/Panel';
import { useGetAnalyticsQuery } from '../../redux/api';

/** A number with its label. `null` renders as a dash, never as zero. */
const Stat = ({ label, value, suffix, hint }) => {
    const { t } = useTranslation();

    return (
        <div className='rounded-md border border-border/60 bg-surface-secondary/50 px-3 py-2'>
            <div className='text-xs uppercase text-muted'>{t(label)}</div>
            <div className='text-xl font-semibold text-foreground'>
                {value === null || value === undefined ? (
                    <span className='text-muted'>—</span>
                ) : (
                    <>
                        {value}
                        {suffix && <span className='text-sm text-muted'>{suffix}</span>}
                    </>
                )}
            </div>
            {hint && <div className='text-xs text-muted'>{t(hint)}</div>}
        </div>
    );
};

/** One funnel step as a labelled bar. */
const FunnelStep = ({ label, step, of }) => {
    const { t } = useTranslation();
    const width = of > 0 ? Math.round((step.count / of) * 100) : 0;

    return (
        <div className='space-y-0.5'>
            <div className='flex items-baseline gap-2 text-sm'>
                <span className='text-foreground'>{t(label)}</span>
                <span className='text-muted'>{step.count}</span>
                {step.percent !== null && (
                    <span className='ml-auto text-xs text-muted'>{step.percent}%</span>
                )}
            </div>
            <div className='h-2 w-full overflow-hidden rounded bg-surface-secondary/70'>
                <div className='h-full bg-amber-400/70' style={{ width: `${width}%` }} />
            </div>
        </div>
    );
};

/**
 * Games per day as a bare sparkline. Deliberately no chart library: the
 * dashboard needs a shape, not a plotting toolkit, and adding one to the
 * bundle for a single strip of bars would be a poor trade.
 */
const Sparkline = ({ points, valueOf, label }) => {
    const { t } = useTranslation();
    const max = points.reduce((best, point) => Math.max(best, valueOf(point)), 0);

    if (points.length === 0) {
        return <div className='text-sm text-muted'>{t('No activity yet.')}</div>;
    }

    return (
        <div>
            <div className='flex h-24 items-end gap-0.5'>
                {points.map((point) => {
                    const value = valueOf(point);
                    const height = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 2;

                    return (
                        <div
                            key={point.day}
                            className='flex-1 rounded-t bg-amber-400/60'
                            style={{ height: `${height}%` }}
                            title={`${new Date(point.day).toLocaleDateString()}: ${value}`}
                        />
                    );
                })}
            </div>
            <div className='mt-1 flex justify-between text-xs text-muted'>
                <span>{new Date(points[0].day).toLocaleDateString()}</span>
                <span>
                    {t(label)} — {t('peak')} {max}
                </span>
                <span>{new Date(points[points.length - 1].day).toLocaleDateString()}</span>
            </div>
        </div>
    );
};

/**
 * ARCHON (N8): the operations dashboard.
 *
 * Every number is derived from tables the platform already writes, so it can
 * be recomputed and audited rather than trusted. Where a figure has no
 * meaningful value - stickiness with no monthly activity, a completion rate
 * with no settled events - it renders as a dash instead of a zero, because
 * "0%" is a claim and "no data" is not.
 */
const AnalyticsDashboard = () => {
    const { t } = useTranslation();
    const { data, isLoading } = useGetAnalyticsQuery({ days: 30 });

    if (isLoading) {
        return (
            <Panel title={t('Site analytics')}>
                <div className='text-sm text-muted'>{t('Loading...')}</div>
            </Panel>
        );
    }

    if (!data?.success) {
        return (
            <Panel title={t('Site analytics')}>
                <div className='text-sm text-muted'>
                    {data?.message || t('Could not load analytics')}
                </div>
            </Panel>
        );
    }

    const { activity, gamesPerDay, funnel, tournaments, matchmaking, registrations } = data;

    return (
        <>
            <Panel title={t('Site analytics')}>
                <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
                    <Stat label='Active today' value={activity.dau} hint='Played a game' />
                    <Stat label='Active this month' value={activity.mau} />
                    <Stat
                        label='Stickiness'
                        value={activity.stickiness}
                        suffix='%'
                        hint='Daily over monthly'
                    />
                    <Stat label='Games today' value={activity.gamesToday} />
                </div>
                <div className='mt-4'>
                    <Sparkline
                        points={gamesPerDay}
                        valueOf={(point) => point.games}
                        label='Games per day'
                    />
                </div>
            </Panel>

            <Panel title={t('New player funnel ({{days}} days)', { days: funnel.windowDays })}>
                <p className='mb-3 text-xs text-muted'>
                    {t(
                        'Accounts registered in the window, and how far each got. The second game is the step that matters - one game is curiosity, two is a returning player.'
                    )}
                </p>
                <div className='space-y-2'>
                    <FunnelStep
                        label='Registered'
                        step={funnel.registered}
                        of={funnel.registered.count}
                    />
                    <FunnelStep
                        label='Completed onboarding'
                        step={funnel.onboarded}
                        of={funnel.registered.count}
                    />
                    <FunnelStep
                        label='Imported a deck'
                        step={funnel.firstDeck}
                        of={funnel.registered.count}
                    />
                    <FunnelStep
                        label='Played a game'
                        step={funnel.firstGame}
                        of={funnel.registered.count}
                    />
                    <FunnelStep
                        label='Played a second game'
                        step={funnel.secondGame}
                        of={funnel.registered.count}
                    />
                </div>
            </Panel>

            <Panel title={t('Tournaments ({{days}} days)', { days: tournaments.windowDays })}>
                <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
                    <Stat
                        label='Completion rate'
                        value={tournaments.completionRate}
                        suffix='%'
                        hint='Of events that settled'
                    />
                    <Stat label='Complete' value={tournaments.complete} />
                    <Stat label='In progress' value={tournaments.active} />
                    <Stat label='Average length' value={tournaments.averageMinutes} suffix=' min' />
                </div>
            </Panel>

            <Panel title={t('Matchmaking ({{days}} days)', { days: matchmaking.windowDays })}>
                <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
                    <Stat label='Matches made' value={matchmaking.matches} />
                    <Stat label='Average wait' value={matchmaking.averageWaitSeconds} suffix='s' />
                    <Stat
                        label='90th percentile wait'
                        value={matchmaking.p90WaitSeconds}
                        suffix='s'
                        hint='The experience worth acting on'
                    />
                    <Stat label='Peak queue depth' value={matchmaking.peakDepth} />
                </div>
            </Panel>

            <Panel title={t('Registrations')}>
                <Sparkline
                    points={registrations}
                    valueOf={(point) => point.count}
                    label='Registrations per day'
                />
            </Panel>
        </>
    );
};

AnalyticsDashboard.displayName = 'AnalyticsDashboard';

export default AnalyticsDashboard;
