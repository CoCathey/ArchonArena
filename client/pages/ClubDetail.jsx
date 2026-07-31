import React, { useState } from 'react';
import Link from '../Components/Navigation/Link';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, toast } from '@heroui/react';
import { useNavigate, useParams } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import AmberValue from '../Components/Site/AmberValue';
import { countryName } from '../geo';
import {
    useClubActionMutation,
    useDecideClubJoinRequestMutation,
    useGetClubInPersonGamesQuery,
    useGetClubLeaderboardQuery,
    useGetClubQuery
} from '../redux/api';

const POOLS = ['archon', 'sealed', 'alliance'];

/**
 * ARCHON: club page (Phase 9): description, members, join/leave, owner
 * controls. ARCHON (N7): the club board, the owner's approval queue and
 * ownership transfer. ARCHON (N13): paper games played at the club.
 */
const ClubDetail = () => {
    const { t } = useTranslation();
    const { id } = useParams();
    const navigate = useNavigate();
    const user = useSelector((state) => state.account.user);
    const { data, refetch } = useGetClubQuery(id);
    const [clubAction] = useClubActionMutation();
    const [decideRequest] = useDecideClubJoinRequestMutation();
    const [pool, setPool] = useState('archon');
    const { data: board } = useGetClubLeaderboardQuery({ id, pool });
    const { data: paperGames } = useGetClubInPersonGamesQuery({ id, limit: 10 });

    if (!data?.success) {
        return (
            <div className='mx-auto w-full max-w-3xl'>
                <Panel title={t('Club')}>
                    <div className='text-sm text-muted'>
                        {data ? t('No such club') : t('Loading...')}
                    </div>
                </Panel>
            </div>
        );
    }

    const { club, members, pendingMembers = [] } = data;

    const decide = async (userId, approve) => {
        try {
            const result = await decideRequest({ id, userId, approve }).unwrap();

            if (result.success) {
                toast.success(approve ? t('Request approved') : t('Request declined'));
                refetch();
            } else {
                toast.danger(result.message || t('Action failed'));
            }
        } catch {
            toast.danger(t('Action failed'));
        }
    };

    const act = async (action, body, successMessage, navigateAway) => {
        try {
            const result = await clubAction({ id, action, body }).unwrap();

            if (result.success) {
                if (successMessage) {
                    toast.success(successMessage);
                }
                if (navigateAway) {
                    navigate('/community/clubs');
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
            <Panel title={club.name}>
                <div className='flex flex-wrap items-center gap-2'>
                    <span className='text-sm text-muted'>
                        {t('{{count}} members', { count: members.length })}
                    </span>
                    {club.joinPolicy === 'approval' && (
                        <span className='rounded bg-surface-secondary/70 px-1.5 text-xs text-muted'>
                            {t('Joins need approval')}
                        </span>
                    )}
                    <span className='ml-auto flex gap-2'>
                        {user &&
                            (club.isMember ? (
                                !club.isOwner && (
                                    <HeroButton
                                        size='sm'
                                        variant='tertiary'
                                        onPress={() => act('leave', {}, t('You left the club'))}
                                    >
                                        {t('Leave Club')}
                                    </HeroButton>
                                )
                            ) : club.isPending ? (
                                <span className='text-xs text-muted'>
                                    {t('Your request is waiting for the owner')}
                                </span>
                            ) : (
                                <HeroButton
                                    size='sm'
                                    variant='primary'
                                    onPress={() =>
                                        act(
                                            'join',
                                            {},
                                            club.joinPolicy === 'approval'
                                                ? t('Request sent to the club owner')
                                                : t('Welcome to the club!')
                                        )
                                    }
                                >
                                    {club.joinPolicy === 'approval'
                                        ? t('Ask to Join')
                                        : t('Join Club')}
                                </HeroButton>
                            ))}
                        {club.isOwner && (
                            <HeroButton
                                size='sm'
                                variant='tertiary'
                                onPress={() => {
                                    if (
                                        window.confirm(
                                            t('Disband this club? This cannot be undone.')
                                        )
                                    ) {
                                        act('disband', {}, t('Club disbanded'), true);
                                    }
                                }}
                            >
                                {t('Disband')}
                            </HeroButton>
                        )}
                    </span>
                </div>
                {club.description && (
                    <p className='mt-3 whitespace-pre-wrap text-sm text-muted'>
                        {club.description}
                    </p>
                )}
                {club.isOwner && club.joinCode && (
                    <div className='mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-surface-secondary/50 px-3 py-2 text-sm'>
                        <span className='text-muted'>{t('Invite code:')}</span>
                        <code className='font-mono font-bold tracking-widest text-amber-300'>
                            {club.joinCode}
                        </code>
                        <HeroButton
                            size='sm'
                            variant='tertiary'
                            className='!h-6 !px-2 text-xs'
                            onPress={() => {
                                navigator.clipboard?.writeText(club.joinCode);
                                toast.success(t('Copied'));
                            }}
                        >
                            {t('Copy')}
                        </HeroButton>
                        <span className='w-full text-xs text-muted'>
                            {t(
                                'Share this code so players can join instantly - even during sign-up.'
                            )}
                        </span>
                    </div>
                )}
            </Panel>

            {/* ARCHON (N7): the owner's approval queue. Only the owner sees
                it - publishing who was turned down would be a different and
                much worse feature. */}
            {club.isOwner && pendingMembers.length > 0 && (
                <Panel title={t('Join requests ({{count}})', { count: pendingMembers.length })}>
                    <div className='space-y-1'>
                        {pendingMembers.map((member) => (
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
                                {member.country && (
                                    <span className='text-xs text-muted'>
                                        {countryName(member.country)}
                                    </span>
                                )}
                                <span className='ml-auto flex gap-1'>
                                    <HeroButton
                                        size='sm'
                                        variant='primary'
                                        className='!h-6 !px-2 text-xs'
                                        onPress={() => decide(member.userId, true)}
                                    >
                                        {t('Approve')}
                                    </HeroButton>
                                    <HeroButton
                                        size='sm'
                                        variant='tertiary'
                                        className='!h-6 !px-2 text-xs'
                                        onPress={() => decide(member.userId, false)}
                                    >
                                        {t('Decline')}
                                    </HeroButton>
                                </span>
                            </div>
                        ))}
                    </div>
                </Panel>
            )}

            {/* ARCHON (N7): the club board. Every rated member is listed, not
                only those who qualify for the site board - see
                RatingService.getClubLeaderboard for why. */}
            {board?.entries?.length > 0 && (
                <Panel title={t('Club standings')}>
                    <div className='mb-2 flex gap-1'>
                        {POOLS.map((option) => (
                            <HeroButton
                                key={option}
                                size='sm'
                                variant={option === pool ? 'primary' : 'tertiary'}
                                className='!h-6 !px-2 text-xs capitalize'
                                onPress={() => setPool(option)}
                            >
                                {t(option)}
                            </HeroButton>
                        ))}
                    </div>
                    <table className='w-full text-sm'>
                        <thead>
                            <tr className='text-left text-xs uppercase text-muted'>
                                <th className='py-1'>{t('#')}</th>
                                <th>{t('Player')}</th>
                                <th className='text-right'>{t('Amber')}</th>
                                <th className='text-right'>{t('W-L')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {board.entries.map((entry) => (
                                <tr key={entry.username} className='border-t border-border/40'>
                                    <td className='py-1 text-muted'>{entry.rank}</td>
                                    <td>
                                        <Link
                                            href={`/players/${encodeURIComponent(entry.username)}`}
                                            className='font-semibold text-foreground hover:text-amber-300 hover:underline'
                                        >
                                            {entry.username}
                                        </Link>
                                        {entry.provisional && (
                                            <span className='ml-1 text-xs text-muted'>
                                                {t('(provisional)')}
                                            </span>
                                        )}
                                        {!entry.rankedSiteWide && (
                                            <span
                                                className='ml-1 text-xs text-muted'
                                                title={t(
                                                    'Not enough games to appear on the site-wide board yet'
                                                )}
                                            >
                                                {t('(club only)')}
                                            </span>
                                        )}
                                    </td>
                                    <td className='text-right'>
                                        <AmberValue value={entry.rating} />
                                    </td>
                                    <td className='text-right text-muted'>
                                        {entry.wins}-{entry.losses}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </Panel>
            )}

            {/* ARCHON (N13): paper games recorded at this club. */}
            {paperGames?.games?.length > 0 && (
                <Panel title={t('Recent in-person games')}>
                    <div className='space-y-1'>
                        {paperGames.games.map((game) => (
                            <div
                                key={game.id}
                                className='flex items-center gap-2 rounded bg-surface-secondary/50 px-2 py-1.5 text-sm'
                            >
                                <span className='text-foreground'>
                                    {game.player1} {t('vs')} {game.player2}
                                </span>
                                <span className='text-xs capitalize text-muted'>
                                    {game.gameFormat}
                                </span>
                                {game.rated && (
                                    <span className='rounded bg-accent/20 px-1.5 text-xs text-amber-300'>
                                        {t('Rated')}
                                    </span>
                                )}
                                <span className='ml-auto text-xs text-muted'>
                                    {game.playedAt
                                        ? new Date(game.playedAt).toLocaleDateString()
                                        : ''}
                                </span>
                            </div>
                        ))}
                    </div>
                </Panel>
            )}

            <Panel title={t('Members')}>
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
                            {member.role === 'owner' && (
                                <span className='rounded bg-accent/20 px-1.5 text-xs text-amber-300'>
                                    {t('Owner')}
                                </span>
                            )}
                            {member.country && (
                                <span className='text-xs text-muted'>
                                    {countryName(member.country)}
                                </span>
                            )}
                            {club.isOwner && member.role !== 'owner' && (
                                <span className='ml-auto flex gap-1'>
                                    {/* ARCHON (N7): ownership transfer. An
                                        owner who has moved on should be able
                                        to hand the club over rather than
                                        disband a live scene. */}
                                    <HeroButton
                                        size='sm'
                                        variant='tertiary'
                                        className='!h-6 !px-2 text-xs'
                                        onPress={() => {
                                            if (
                                                window.confirm(
                                                    t(
                                                        'Make {{username}} the owner? You will stay on as a member.',
                                                        { username: member.username }
                                                    )
                                                )
                                            ) {
                                                act(
                                                    'transfer',
                                                    { userId: member.userId },
                                                    t('Club transferred')
                                                );
                                            }
                                        }}
                                    >
                                        {t('Make owner')}
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
        </div>
    );
};

ClubDetail.displayName = 'ClubDetail';

export default ClubDetail;
