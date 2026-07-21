import React from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, toast } from '@heroui/react';
import { useParams } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import { useGetEventDetailQuery, useTournamentActionMutation } from '../redux/api';

/**
 * ARCHON: tournament page (Phase 7): registration, per-round pairings
 * with result reporting, standings, and organizer controls.
 */
const TournamentDetail = () => {
    const { t } = useTranslation();
    const { id } = useParams();
    const user = useSelector((state) => state.account.user);
    const { data, refetch } = useGetEventDetailQuery(id, { pollingInterval: 15000 });
    const [runAction, actionState] = useTournamentActionMutation();

    if (!data?.success) {
        return (
            <div className='mx-auto w-full max-w-4xl'>
                <Panel title={t('Tournament')}>
                    <div className='text-sm text-muted'>
                        {data ? t('No such tournament') : t('Loading...')}
                    </div>
                </Panel>
            </div>
        );
    }

    const { tournament, players, matches, standings } = data;
    const activePlayers = players.filter((player) => !player.dropped);

    const act = async (action, body, successMessage) => {
        try {
            const result = await runAction({ id, action, body }).unwrap();

            if (result.success) {
                if (successMessage) {
                    toast.success(successMessage);
                }
                refetch();
            } else {
                toast.error(result.message || t('Action failed'));
            }
        } catch {
            toast.error(t('Action failed'));
        }
    };

    const rounds = [];
    for (const match of matches) {
        (rounds[match.round] = rounds[match.round] || []).push(match);
    }

    const statusLabel =
        tournament.status === 'registration'
            ? t('Open Registration')
            : tournament.status === 'active'
            ? t('Round {{round}} of {{total}}', {
                  round: tournament.currentRound,
                  total: tournament.roundCount || '?'
              })
            : t(tournament.status);

    return (
        <div className='mx-auto w-full max-w-5xl space-y-4'>
            <Panel title={tournament.name}>
                <div className='flex flex-wrap items-center gap-x-4 gap-y-2 text-sm'>
                    <span className='text-amber-300'>
                        {tournament.format === 'swiss' ? t('Swiss') : t('Single Elimination')}
                        {' - '}
                        {tournament.gameFormat}
                        {' - '}
                        {tournament.mode === 'irl' ? t('In Person') : t('Online')}
                    </span>
                    <span className='text-muted'>{statusLabel}</span>
                    <span className='text-muted'>
                        {t('Organized by {{organizer}}', { organizer: tournament.organizer })}
                    </span>
                    <span className='ml-auto flex flex-wrap gap-2'>
                        {user &&
                            tournament.status === 'registration' &&
                            (tournament.isRegistered ? (
                                <HeroButton
                                    size='sm'
                                    variant='tertiary'
                                    onPress={() => act('drop', {}, t('You are unregistered'))}
                                >
                                    {t('Unregister')}
                                </HeroButton>
                            ) : (
                                <HeroButton
                                    size='sm'
                                    variant='primary'
                                    onPress={() => act('register', {}, t('You are registered'))}
                                >
                                    {t('Register')}
                                </HeroButton>
                            ))}
                        {user && tournament.status === 'active' && tournament.isRegistered && (
                            <HeroButton
                                size='sm'
                                variant='tertiary'
                                onPress={() => act('drop', {}, t('You dropped from the event'))}
                            >
                                {t('Drop')}
                            </HeroButton>
                        )}
                        {tournament.canManage && tournament.status === 'registration' && (
                            <HeroButton
                                size='sm'
                                variant='primary'
                                isPending={actionState.isLoading}
                                onPress={() => act('start', {}, t('Tournament started'))}
                            >
                                {t('Start Tournament')}
                            </HeroButton>
                        )}
                        {tournament.canManage && tournament.status === 'active' && (
                            <>
                                <HeroButton
                                    size='sm'
                                    variant='primary'
                                    isPending={actionState.isLoading}
                                    onPress={() => act('next-round', {}, t('Next round paired'))}
                                >
                                    {t('Pair Next Round')}
                                </HeroButton>
                                <HeroButton
                                    size='sm'
                                    variant='tertiary'
                                    onPress={() => act('finish', {}, t('Tournament complete'))}
                                >
                                    {t('Finish')}
                                </HeroButton>
                            </>
                        )}
                        {tournament.canManage &&
                            ['registration', 'active'].includes(tournament.status) && (
                                <HeroButton
                                    size='sm'
                                    variant='tertiary'
                                    onPress={() => act('cancel', {}, t('Tournament cancelled'))}
                                >
                                    {t('Cancel')}
                                </HeroButton>
                            )}
                    </span>
                </div>
                {tournament.description && (
                    <p className='mt-2 whitespace-pre-wrap text-sm text-muted'>
                        {tournament.description}
                    </p>
                )}
            </Panel>

            <div className='grid gap-4 lg:grid-cols-2'>
                <Panel
                    title={
                        tournament.status === 'registration'
                            ? t('Players ({{count}})', { count: activePlayers.length })
                            : t('Standings')
                    }
                >
                    {tournament.status === 'registration' ? (
                        activePlayers.length === 0 ? (
                            <div className='text-sm text-muted'>{t('No players yet')}</div>
                        ) : (
                            <ul className='space-y-1 text-sm'>
                                {activePlayers.map((player) => (
                                    <li
                                        key={player.userId}
                                        className='flex items-center justify-between rounded bg-surface-secondary/50 px-2 py-1'
                                    >
                                        <span className='text-foreground'>{player.username}</span>
                                        {tournament.canManage && (
                                            <HeroButton
                                                size='sm'
                                                variant='tertiary'
                                                className='!h-6 !px-2 text-xs'
                                                onPress={() =>
                                                    act(
                                                        'drop',
                                                        { userId: player.userId },
                                                        t('Player removed')
                                                    )
                                                }
                                            >
                                                {t('Remove')}
                                            </HeroButton>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )
                    ) : (
                        <table className='w-full text-sm'>
                            <thead>
                                <tr className='border-b border-border/70 text-left text-xs uppercase tracking-wide text-muted'>
                                    <th className='px-2 py-1.5 w-10'>#</th>
                                    <th className='px-2 py-1.5'>{t('Player')}</th>
                                    <th className='px-2 py-1.5 text-right'>{t('Points')}</th>
                                    <th className='px-2 py-1.5 text-right'>{t('SOS')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {standings.map((entry) => (
                                    <tr
                                        key={entry.id}
                                        className={`border-b border-border/40 ${
                                            entry.username === user?.username ? 'bg-accent/15' : ''
                                        }`}
                                    >
                                        <td className='px-2 py-1.5 text-muted'>{entry.rank}</td>
                                        <td className='px-2 py-1.5 font-semibold text-foreground'>
                                            {entry.username}
                                            {entry.dropped && (
                                                <span className='ml-1 text-xs text-muted'>
                                                    ({t('dropped')})
                                                </span>
                                            )}
                                        </td>
                                        <td className='px-2 py-1.5 text-right font-bold text-amber-300'>
                                            {entry.points}
                                        </td>
                                        <td className='px-2 py-1.5 text-right text-muted'>
                                            {entry.sos}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </Panel>

                <Panel title={t('Rounds')}>
                    {rounds.filter(Boolean).length === 0 ? (
                        <div className='text-sm text-muted'>
                            {t('Pairings appear when the tournament starts')}
                        </div>
                    ) : (
                        <div className='space-y-3'>
                            {rounds.map(
                                (roundMatches, roundNumber) =>
                                    roundMatches && (
                                        <div key={roundNumber}>
                                            <div className='mb-1 text-xs uppercase tracking-wide text-muted'>
                                                {t('Round {{round}}', { round: roundNumber })}
                                            </div>
                                            <div className='space-y-1'>
                                                {roundMatches.map((match) => {
                                                    const canReport =
                                                        tournament.status === 'active' &&
                                                        match.player2Id &&
                                                        (tournament.canManage ||
                                                            (!match.winnerId &&
                                                                (user?.id === match.player1Id ||
                                                                    user?.id === match.player2Id)));

                                                    return (
                                                        <div
                                                            key={match.id}
                                                            className='flex flex-wrap items-center gap-2 rounded bg-surface-secondary/50 px-2 py-1.5 text-sm'
                                                        >
                                                            {match.table && (
                                                                <span className='text-xs text-muted'>
                                                                    {t('Table {{table}}', {
                                                                        table: match.table
                                                                    })}
                                                                </span>
                                                            )}
                                                            {match.player2 ? (
                                                                <span className='text-foreground'>
                                                                    {[
                                                                        match.player1,
                                                                        match.player2
                                                                    ].map((name, index) => (
                                                                        <span key={name}>
                                                                            {index === 1 && ' vs '}
                                                                            <span
                                                                                className={
                                                                                    match.winnerId &&
                                                                                    ((index === 0 &&
                                                                                        match.winnerId ===
                                                                                            match.player1Id) ||
                                                                                        (index ===
                                                                                            1 &&
                                                                                            match.winnerId ===
                                                                                                match.player2Id))
                                                                                        ? 'font-bold text-amber-300'
                                                                                        : ''
                                                                                }
                                                                            >
                                                                                {name}
                                                                            </span>
                                                                        </span>
                                                                    ))}
                                                                </span>
                                                            ) : (
                                                                <span className='text-foreground'>
                                                                    {match.player1}{' '}
                                                                    <span className='text-xs text-muted'>
                                                                        ({t('bye')})
                                                                    </span>
                                                                </span>
                                                            )}
                                                            {canReport && (
                                                                <span className='ml-auto flex gap-1'>
                                                                    {[
                                                                        [
                                                                            match.player1Id,
                                                                            match.player1
                                                                        ],
                                                                        [
                                                                            match.player2Id,
                                                                            match.player2
                                                                        ]
                                                                    ].map(([playerId, name]) => (
                                                                        <HeroButton
                                                                            key={playerId}
                                                                            size='sm'
                                                                            variant='tertiary'
                                                                            className='!h-6 !px-2 text-xs'
                                                                            onPress={() =>
                                                                                act(
                                                                                    `matches/${match.id}/result`,
                                                                                    {
                                                                                        winnerId:
                                                                                            playerId
                                                                                    },
                                                                                    t(
                                                                                        'Result recorded'
                                                                                    )
                                                                                )
                                                                            }
                                                                        >
                                                                            {t('{{name}} won', {
                                                                                name
                                                                            })}
                                                                        </HeroButton>
                                                                    ))}
                                                                </span>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )
                            )}
                        </div>
                    )}
                </Panel>
            </div>
        </div>
    );
};

TournamentDetail.displayName = 'TournamentDetail';

export default TournamentDetail;
