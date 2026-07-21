import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Input, toast } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import AlertPanel from '../Components/Site/AlertPanel';
import { useFriendActionMutation, useGetFriendsQuery } from '../redux/api';

/**
 * ARCHON: friends (Phase 9). Online badges come from the lobby presence
 * list the client already receives over the lobby socket.
 */
const Friends = () => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    const onlineUsers = useSelector((state) => state.lobby.users);
    const [username, setUsername] = useState('');

    const { data } = useGetFriendsQuery(undefined, { skip: !user, pollingInterval: 30000 });
    const [friendAction, actionState] = useFriendActionMutation();

    if (!user) {
        return (
            <AlertPanel type='warning' message={t('You need to be logged in to manage friends')} />
        );
    }

    const onlineNames = new Set((onlineUsers || []).map((entry) => entry.name));

    const act = async (action, body, successMessage) => {
        try {
            const result = await friendAction({ action, body }).unwrap();

            if (result.success) {
                if (successMessage) {
                    toast.success(successMessage);
                }
            } else {
                toast.error(result.message || t('Action failed'));
            }
        } catch {
            toast.error(t('Action failed'));
        }
    };

    const onAdd = async () => {
        if (!username.trim()) {
            return;
        }

        await act('request', { username: username.trim() }, t('Friend request sent'));
        setUsername('');
    };

    const friends = data?.friends || [];
    const incoming = data?.incoming || [];
    const outgoing = data?.outgoing || [];

    const onlineBadge = (name) => (
        <span
            className={`inline-block h-2 w-2 rounded-full ${
                onlineNames.has(name) ? 'bg-green-400' : 'bg-border'
            }`}
            title={onlineNames.has(name) ? t('Online') : t('Offline')}
        />
    );

    return (
        <div className='mx-auto w-full max-w-3xl space-y-4'>
            <Panel title={t('Friends')}>
                <form
                    className='mb-4 flex gap-2'
                    onSubmit={(event) => {
                        event.preventDefault();
                        onAdd();
                    }}
                >
                    <Input
                        className='flex-1'
                        placeholder={t('Add a friend by username')}
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                    />
                    <HeroButton
                        type='submit'
                        variant='primary'
                        size='sm'
                        isPending={actionState.isLoading}
                    >
                        {t('Send Request')}
                    </HeroButton>
                </form>

                {incoming.length > 0 && (
                    <div className='mb-4'>
                        <div className='mb-1 text-xs uppercase tracking-wide text-muted'>
                            {t('Incoming requests')}
                        </div>
                        <div className='space-y-1'>
                            {incoming.map((request) => (
                                <div
                                    key={request.userId}
                                    className='flex items-center gap-2 rounded bg-surface-secondary/50 px-2 py-1.5 text-sm'
                                >
                                    <span className='font-semibold text-foreground'>
                                        {request.username}
                                    </span>
                                    <span className='ml-auto flex gap-1'>
                                        <HeroButton
                                            size='sm'
                                            variant='primary'
                                            className='!h-6 !px-2 text-xs'
                                            onPress={() =>
                                                act(
                                                    'respond',
                                                    { userId: request.userId, accept: true },
                                                    t('Friend added')
                                                )
                                            }
                                        >
                                            {t('Accept')}
                                        </HeroButton>
                                        <HeroButton
                                            size='sm'
                                            variant='tertiary'
                                            className='!h-6 !px-2 text-xs'
                                            onPress={() =>
                                                act('respond', {
                                                    userId: request.userId,
                                                    accept: false
                                                })
                                            }
                                        >
                                            {t('Decline')}
                                        </HeroButton>
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {outgoing.length > 0 && (
                    <div className='mb-4'>
                        <div className='mb-1 text-xs uppercase tracking-wide text-muted'>
                            {t('Sent requests')}
                        </div>
                        <div className='space-y-1'>
                            {outgoing.map((request) => (
                                <div
                                    key={request.userId}
                                    className='flex items-center gap-2 rounded bg-surface-secondary/50 px-2 py-1.5 text-sm'
                                >
                                    <span className='text-foreground'>{request.username}</span>
                                    <span className='text-xs text-muted'>{t('pending')}</span>
                                    <HeroButton
                                        size='sm'
                                        variant='tertiary'
                                        className='ml-auto !h-6 !px-2 text-xs'
                                        onPress={() => act('remove', { userId: request.userId })}
                                    >
                                        {t('Cancel')}
                                    </HeroButton>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                <div className='mb-1 text-xs uppercase tracking-wide text-muted'>
                    {t('Friends ({{count}})', { count: friends.length })}
                </div>
                {friends.length === 0 ? (
                    <div className='py-4 text-sm text-muted'>
                        {t('No friends yet - send a request above!')}
                    </div>
                ) : (
                    <div className='space-y-1'>
                        {friends.map((friend) => (
                            <div
                                key={friend.userId}
                                className='flex items-center gap-2 rounded bg-surface-secondary/50 px-2 py-1.5 text-sm'
                            >
                                {onlineBadge(friend.username)}
                                <span className='font-semibold text-foreground'>
                                    {friend.username}
                                </span>
                                <HeroButton
                                    size='sm'
                                    variant='tertiary'
                                    className='ml-auto !h-6 !px-2 text-xs'
                                    onPress={() =>
                                        act('remove', { userId: friend.userId }, t('Removed'))
                                    }
                                >
                                    {t('Remove')}
                                </HeroButton>
                            </div>
                        ))}
                    </div>
                )}
            </Panel>
        </div>
    );
};

Friends.displayName = 'Friends';

export default Friends;
