import React from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, toast } from '@heroui/react';
import { useNavigate, useParams } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import { countryName } from '../geo';
import { useGetTeamQuery, useTeamActionMutation } from '../redux/api';

/**
 * ARCHON (N7): a team's page - roster, ratings per pool, and the event
 * results those ratings came from.
 */
const TeamDetail = () => {
    const { t } = useTranslation();
    const { id } = useParams();
    const navigate = useNavigate();
    const user = useSelector((state) => state.account.user);
    const { data, refetch } = useGetTeamQuery(id);
    const [teamAction] = useTeamActionMutation();

    if (!data?.success) {
        return (
            <div className='mx-auto w-full max-w-3xl'>
                <Panel title={t('Team')}>
                    <div className='text-sm text-muted'>
                        {data ? t('No such team') : t('Loading...')}
                    </div>
                </Panel>
            </div>
        );
    }

    const { team, members, ratings, results } = data;

    const act = async (action, body, successMessage, navigateAway) => {
        try {
            const result = await teamAction({ id, action, body }).unwrap();

            if (result.success) {
                if (successMessage) {
                    toast.success(successMessage);
                }

                if (navigateAway) {
                    navigate('/community/teams');
                } else {
                    refetch();
                }
            } else {
                toast.danger(result.message || t('Action failed'));
            }
        } catch {
            toast.danger(t('Action failed'));
        }
    };

    return (
        <div className='mx-auto w-full max-w-3xl space-y-4'>
            <Panel title={team.name}>
                <div className='flex flex-wrap items-center gap-2'>
                    <span className='text-sm text-muted'>
                        {t('{{count}} members', { count: members.length })}
                    </span>
                    <span className='ml-auto flex gap-2'>
                        {user && team.isMember && !team.isCaptain && (
                            <HeroButton
                                size='sm'
                                variant='tertiary'
                                onPress={() => act('leave', {}, t('You left the team'))}
                            >
                                {t('Leave Team')}
                            </HeroButton>
                        )}
                        {team.isCaptain && (
                            <HeroButton
                                size='sm'
                                variant='tertiary'
                                onPress={() => {
                                    if (
                                        window.confirm(
                                            t('Disband this team? This cannot be undone.')
                                        )
                                    ) {
                                        act('disband', {}, t('Team disbanded'), true);
                                    }
                                }}
                            >
                                {t('Disband')}
                            </HeroButton>
                        )}
                    </span>
                </div>
                {team.description && (
                    <p className='mt-3 whitespace-pre-wrap text-sm text-muted'>
                        {team.description}
                    </p>
                )}
                {team.isCaptain && team.joinCode && (
                    <div className='mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-surface-secondary/50 px-3 py-2 text-sm'>
                        <span className='text-muted'>{t('Join code:')}</span>
                        <code className='font-mono font-bold tracking-widest text-amber-300'>
                            {team.joinCode}
                        </code>
                        <HeroButton
                            size='sm'
                            variant='tertiary'
                            className='!h-6 !px-2 text-xs'
                            onPress={() => {
                                navigator.clipboard?.writeText(team.joinCode);
                                toast.success(t('Copied'));
                            }}
                        >
                            {t('Copy')}
                        </HeroButton>
                    </div>
                )}
            </Panel>

            {ratings.length > 0 && (
                <Panel title={t('Team rating')}>
                    <div className='flex flex-wrap gap-3'>
                        {ratings.map((rating) => (
                            <div
                                key={rating.pool}
                                className='rounded-md border border-border/60 bg-surface-secondary/50 px-3 py-2'
                            >
                                <div className='text-xs uppercase text-muted'>{rating.pool}</div>
                                <div className='text-lg font-semibold text-amber-300'>
                                    {rating.rating}
                                </div>
                                <div className='text-xs text-muted'>
                                    {t('{{count}} events', { count: rating.eventsPlayed })}
                                </div>
                            </div>
                        ))}
                    </div>
                </Panel>
            )}

            <Panel title={t('Roster')}>
                <div className='space-y-1'>
                    {members.map((member) => (
                        <div
                            key={member.userId}
                            className='flex items-center gap-2 rounded bg-surface-secondary/50 px-2 py-1.5 text-sm'
                        >
                            <Link
                                href={`/players/${encodeURIComponent(member.username)}`}
                                className='font-semibold text-foreground hover:text-amber-300 hover:underline'
                            >
                                {member.username}
                            </Link>
                            {member.role === 'captain' && (
                                <span className='rounded bg-accent/20 px-1.5 text-xs text-amber-300'>
                                    {t('Captain')}
                                </span>
                            )}
                            {member.country && (
                                <span className='text-xs text-muted'>
                                    {countryName(member.country)}
                                </span>
                            )}
                            {team.isCaptain && member.role !== 'captain' && (
                                <span className='ml-auto flex gap-1'>
                                    <HeroButton
                                        size='sm'
                                        variant='tertiary'
                                        className='!h-6 !px-2 text-xs'
                                        onPress={() => {
                                            if (
                                                window.confirm(
                                                    t('Hand the team to {{username}}?', {
                                                        username: member.username
                                                    })
                                                )
                                            ) {
                                                act(
                                                    'transfer',
                                                    { userId: member.userId },
                                                    t('Team handed on')
                                                );
                                            }
                                        }}
                                    >
                                        {t('Make captain')}
                                    </HeroButton>
                                    <HeroButton
                                        size='sm'
                                        variant='tertiary'
                                        className='!h-6 !px-2 text-xs'
                                        onPress={() =>
                                            act(
                                                'remove',
                                                { userId: member.userId },
                                                t('Member removed')
                                            )
                                        }
                                    >
                                        {t('Remove')}
                                    </HeroButton>
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            </Panel>

            {results.length > 0 && (
                <Panel title={t('Event results')}>
                    <table className='w-full text-sm'>
                        <thead>
                            <tr className='text-left text-xs uppercase text-muted'>
                                <th className='py-1'>{t('Event')}</th>
                                <th className='text-right'>{t('Finish')}</th>
                                <th className='text-right'>{t('Record')}</th>
                                <th className='text-right'>{t('Rating')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {results.map((result) => (
                                <tr key={result.tournamentId} className='border-t border-border/40'>
                                    <td className='py-1'>
                                        <Link
                                            href={`/tournaments/${result.tournamentId}`}
                                            className='text-foreground hover:text-amber-300 hover:underline'
                                        >
                                            {result.tournamentName}
                                        </Link>
                                    </td>
                                    <td className='text-right text-muted'>
                                        {result.rank ? `#${result.rank}` : '-'}
                                    </td>
                                    <td className='text-right text-muted'>
                                        {result.matchWins}-{result.matchLosses}
                                    </td>
                                    <td className='text-right'>
                                        <span className='text-amber-300'>{result.ratingAfter}</span>
                                        <span
                                            className={
                                                result.ratingDelta >= 0
                                                    ? 'ml-1 text-xs text-green-400'
                                                    : 'ml-1 text-xs text-red-400'
                                            }
                                        >
                                            {result.ratingDelta >= 0 ? '+' : ''}
                                            {result.ratingDelta}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </Panel>
            )}
        </div>
    );
};

TeamDetail.displayName = 'TeamDetail';

export default TeamDetail;
