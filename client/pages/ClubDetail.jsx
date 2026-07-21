import React from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, toast } from '@heroui/react';
import { useNavigate, useParams } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import { countryName } from '../geo';
import { useClubActionMutation, useGetClubQuery } from '../redux/api';

/**
 * ARCHON: club page (Phase 9): description, members, join/leave, owner
 * controls.
 */
const ClubDetail = () => {
    const { t } = useTranslation();
    const { id } = useParams();
    const navigate = useNavigate();
    const user = useSelector((state) => state.account.user);
    const { data, refetch } = useGetClubQuery(id);
    const [clubAction] = useClubActionMutation();

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

    const { club, members } = data;

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
                toast.error(result.message || t('Action failed'));
            }
        } catch {
            toast.error(t('Action failed'));
        }
    };

    return (
        <div className='mx-auto w-full max-w-3xl space-y-4'>
            <Panel title={club.name}>
                <div className='flex flex-wrap items-center gap-2'>
                    <span className='text-sm text-muted'>
                        {t('{{count}} members', { count: members.length })}
                    </span>
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
                            ) : (
                                <HeroButton
                                    size='sm'
                                    variant='primary'
                                    onPress={() => act('join', {}, t('Welcome to the club!'))}
                                >
                                    {t('Join Club')}
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
            </Panel>

            <Panel title={t('Members')}>
                <div className='space-y-1'>
                    {members.map((member) => (
                        <div
                            key={member.userId}
                            className='flex items-center gap-2 rounded bg-surface-secondary/50 px-2 py-1.5 text-sm'
                        >
                            <span className='font-semibold text-foreground'>{member.username}</span>
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
                                <HeroButton
                                    size='sm'
                                    variant='tertiary'
                                    className='ml-auto !h-6 !px-2 text-xs'
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
