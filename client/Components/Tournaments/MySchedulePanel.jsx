import React from 'react';
import { useTranslation } from 'react-i18next';

import Panel from '../Site/Panel';
import Link from '../Navigation/Link';
import { useGetMyTournamentMatchesQuery } from '../../redux/api';

/** Timestamps come back from Postgres without a zone; they are UTC. */
const asUtc = (value) => {
    if (!value) {
        return null;
    }

    const text = typeof value === 'string' ? value : String(value);
    const time = new Date(text.endsWith('Z') ? text : `${text}Z`);

    return Number.isNaN(time.getTime()) ? null : time;
};

const shortWhen = (date) =>
    date
        ? date.toLocaleString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit'
          })
        : '';

/**
 * ARCHON (N14): every tournament match the player currently owes, across all
 * their events.
 *
 * The reason this is not just another section of the event page: an
 * asynchronous league runs for weeks, and a player in three events has three
 * pages each holding a third of the answer to "what do I owe anyone this
 * week". This is the whole answer, sorted by which deadline bites first, and
 * it is where a player who has been away for two days should land.
 */
const MySchedulePanel = () => {
    const { t } = useTranslation();
    // Deadlines move in days; a minute of staleness costs nothing and the
    // request is cheap enough to refresh when the page is opened again.
    const { data } = useGetMyTournamentMatchesQuery(undefined, { pollingInterval: 60000 });

    const matches = data?.matches || [];

    if (matches.length === 0) {
        return null;
    }

    const actionTone = {
        respond: 'border-amber-400/50 bg-amber-400/10 text-amber-300',
        propose: 'border-border/60 bg-surface-secondary/50 text-muted',
        waiting: 'border-border/60 bg-surface-secondary/50 text-muted',
        play: 'border-sky-500/40 bg-sky-500/10 text-sky-300'
    };

    const actionLabel = {
        respond: t('Answer their proposal'),
        propose: t('Propose a time'),
        waiting: t('Waiting on them'),
        play: t('Scheduled')
    };

    return (
        <Panel title={t('Your Matches')}>
            <div className='space-y-1.5'>
                {matches.map((match) => {
                    const scheduled = asUtc(match.scheduledAt);
                    const proposed = asUtc(match.proposedTime);
                    const deadline = asUtc(match.roundEndsAt);
                    const overdue = deadline && deadline.getTime() < Date.now();

                    return (
                        <Link
                            key={match.matchId}
                            href={`/tournaments/${match.tournamentId}`}
                            className='flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/55 bg-surface-secondary/40 px-3 py-2 text-sm transition hover:border-amber-300/50'
                        >
                            <span className='font-semibold text-foreground'>
                                {match.tournamentName}
                            </span>
                            <span className='text-xs text-muted'>
                                {t('Round {{round}}', { round: match.round })}
                                {match.bestOf > 1 && ` - ${t('Bo{{n}}', { n: match.bestOf })}`}
                            </span>
                            <span className='text-foreground/90'>
                                {t('vs')}{' '}
                                <span className='font-semibold'>{match.opponent || t('TBD')}</span>
                            </span>
                            <span
                                className={`rounded border px-1.5 py-0.5 text-xs ${
                                    actionTone[match.needsAction] || actionTone.propose
                                }`}
                            >
                                {actionLabel[match.needsAction] || ''}
                                {match.needsAction === 'play' &&
                                    scheduled &&
                                    ` ${shortWhen(scheduled)}`}
                                {match.needsAction === 'respond' &&
                                    proposed &&
                                    ` - ${shortWhen(proposed)}`}
                            </span>
                            {deadline && (
                                <span
                                    className={`ml-auto text-xs ${
                                        overdue ? 'font-semibold text-red-400' : 'text-muted'
                                    }`}
                                >
                                    {overdue
                                        ? t('Deadline passed')
                                        : t('Due {{time}}', { time: shortWhen(deadline) })}
                                </span>
                            )}
                        </Link>
                    );
                })}
            </div>
        </Panel>
    );
};

MySchedulePanel.displayName = 'MySchedulePanel';

export default MySchedulePanel;
