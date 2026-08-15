import React, { useState } from 'react';
import PlayerName from '../Components/Site/PlayerName';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, toast } from '@heroui/react';
import { useNavigate, useParams } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import AmberValue from '../Components/Site/AmberValue';
// ARCHON (N5): reporting
import ReportButton from '../Components/Site/ReportButton';
import { countryName } from '../geo';
import {
    useClubActionMutation,
    useDecideClubJoinRequestMutation,
    useGetClubInPersonGamesQuery,
    useGetClubLeaderboardQuery,
    useGetClubQuery,
    useGetFriendsQuery,
    useInviteToClubMutation,
    useRespondToClubInvitationMutation
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
    const [inviteToClub, inviteState] = useInviteToClubMutation();
    const [respondToInvitation] = useRespondToClubInvitationMutation();
    const [inviteName, setInviteName] = useState('');
    const { data: friendData } = useGetFriendsQuery(undefined, { skip: !user });
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

    const { club, members, pendingMembers = [], invitedMembers = [] } = data;

    // Friends worth offering: not already in the club, not already invited, not
    // already waiting on approval. Offering any of those only produces an error
    // the owner has to read to understand.
    const alreadyKnown = new Set(
        [...members, ...pendingMembers, ...invitedMembers].map((member) => member.username)
    );
    const invitableFriends = (friendData?.friends || []).filter(
        (friend) => !alreadyKnown.has(friend.username)
    );

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

    const invite = async (username) => {
        const name = (username || '').trim();

        if (!name) {
            return;
        }

        try {
            const result = await inviteToClub({ id, username: name }).unwrap();

            if (result.success) {
                toast.success(t('Invited {{name}}', { name: result.username }));
                setInviteName('');
                refetch();
            } else {
                toast.danger(result.message || t('Could not send that invitation'));
            }
        } catch (err) {
            // The server's reason is the useful part here - "No player by that
            // name", "already in this club" - so it is shown rather than a
            // generic failure.
            toast.danger(err?.data?.message || t('Could not send that invitation'));
        }
    };

    const answerInvitation = async (accept) => {
        try {
            const result = await respondToInvitation({ id, accept }).unwrap();

            if (result.success) {
                toast.success(
                    accept
                        ? t('Welcome to {{name}}', { name: result.name })
                        : t('Invitation declined')
                );

                if (accept) {
                    refetch();
                } else {
                    navigate('/community/clubs');
                }
            } else {
                toast.danger(result.message || t('Action failed'));
            }
        } catch (err) {
            toast.danger(err?.data?.message || t('Action failed'));
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
                            ) : club.isInvited ? (
                                <>
                                    <span className='text-xs text-muted'>
                                        {t('You have been invited')}
                                    </span>
                                    <HeroButton
                                        size='sm'
                                        variant='primary'
                                        onPress={() => answerInvitation(true)}
                                    >
                                        {t('Accept')}
                                    </HeroButton>
                                    <HeroButton
                                        size='sm'
                                        variant='tertiary'
                                        onPress={() => answerInvitation(false)}
                                    >
                                        {t('Decline')}
                                    </HeroButton>
                                </>
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
                {/* ARCHON (N5): a club name or description is a surface that
                    can carry abuse like any other. */}
                {!club.isOwner && (
                    <div className='mt-2'>
                        <ReportButton targetType='club' targetId={club.id} />
                    </div>
                )}
                {/* ARCHON: an invitation addressed to one player, as opposed
                    to the code above which is for anyone who has it. The
                    friends list is here because "invite my friends" is the
                    common case and nobody remembers how a username is spelled. */}
                {club.isOwner && (
                    <div className='mt-3 rounded-md border border-border/60 bg-surface-secondary/50 px-3 py-2'>
                        <div className='flex flex-wrap items-center gap-2'>
                            <span className='text-sm text-muted'>{t('Invite a player:')}</span>
                            <input
                                className='min-w-40 flex-1 rounded-md border border-border/65 bg-surface-secondary/55 px-2 py-1 text-sm text-foreground focus:border-border/90 focus:outline-none'
                                aria-label={t('Username to invite')}
                                placeholder={t('Username')}
                                value={inviteName}
                                onChange={(event) => setInviteName(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                        invite(inviteName);
                                    }
                                }}
                            />
                            <HeroButton
                                size='sm'
                                variant='primary'
                                isDisabled={!inviteName.trim()}
                                isPending={inviteState.isLoading}
                                onPress={() => invite(inviteName)}
                            >
                                {t('Invite')}
                            </HeroButton>
                        </div>
                        {invitableFriends.length > 0 && (
                            <div className='mt-2 flex flex-wrap items-center gap-1'>
                                <span className='mr-1 text-xs text-muted'>{t('Friends:')}</span>
                                {invitableFriends.map((friend) => (
                                    <HeroButton
                                        key={friend.userId}
                                        size='sm'
                                        variant='tertiary'
                                        className='!h-6 !px-2 text-xs'
                                        onPress={() => invite(friend.username)}
                                    >
                                        {friend.username}
                                    </HeroButton>
                                ))}
                            </div>
                        )}
                        {invitedMembers.length > 0 && (
                            <div className='mt-2 text-xs text-muted'>
                                {t('Waiting on:')}{' '}
                                {invitedMembers.map((member) => member.username).join(', ')}
                            </div>
                        )}
                    </div>
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
                        {/* "Instantly" is only true for an open club: with an
                            approval policy a code produces a request, not a
                            member, and the owner should know that is what they
                            are handing out. */}
                        <span className='w-full text-xs text-muted'>
                            {club.joinPolicy === 'approval'
                                ? t(
                                      'Share this code and players can apply from the Clubs page or during sign-up - you still approve each one.'
                                  )
                                : t(
                                      'Share this code so players can join instantly, from the Clubs page or during sign-up.'
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
                                <PlayerName
                                    className='hover:text-amber-300'
                                    link
                                    username={member.username}
                                />
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
                                        <PlayerName
                                            className='hover:text-amber-300'
                                            link
                                            username={entry.username}
                                        />
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
                            <PlayerName
                                className='hover:text-amber-300'
                                link
                                username={member.username}
                            />
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
