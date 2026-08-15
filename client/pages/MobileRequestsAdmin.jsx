import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, toast } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import { useGetTestFlightRequestsQuery, useSetTestFlightRequestStatusMutation } from '../redux/api';

/**
 * ARCHON (N14): the queue an admin works through to send TestFlight
 * invites. An inbox, not a ticketing system, matching Bug Reports: mark a
 * request resolved once the invite (or a decline) has actually been sent in
 * App Store Connect - nothing here talks to Apple.
 */
const MobileRequestsAdmin = () => {
    const { t } = useTranslation();
    const [statusFilter, setStatusFilter] = useState('pending');
    const { data, refetch } = useGetTestFlightRequestsQuery(
        statusFilter ? { status: statusFilter } : undefined,
        { pollingInterval: 60000 }
    );
    const [setStatus, statusState] = useSetTestFlightRequestStatusMutation();

    const requests = data?.requests || [];

    const changeStatus = async (id, status) => {
        try {
            const result = await setStatus({ id, status }).unwrap();

            if (result.success) {
                toast.success(status === 'resolved' ? t('Marked resolved') : t('Reopened'));
                refetch();
            } else {
                toast.danger(result.message || t('Update failed'));
            }
        } catch {
            toast.danger(t('Update failed'));
        }
    };

    const filters = [
        ['pending', t('Pending')],
        ['resolved', t('Resolved')],
        ['', t('All')]
    ];

    return (
        <div className='mx-auto w-full max-w-4xl'>
            <Panel title={t('TestFlight Requests')}>
                <div className='mb-3 flex flex-wrap gap-1'>
                    {filters.map(([key, label]) => (
                        <HeroButton
                            key={key}
                            size='sm'
                            variant={statusFilter === key ? 'primary' : 'tertiary'}
                            onPress={() => setStatusFilter(key)}
                        >
                            {label}
                        </HeroButton>
                    ))}
                </div>

                {requests.length === 0 ? (
                    <div className='py-8 text-center text-sm text-muted'>
                        {statusFilter === 'pending'
                            ? t('No pending requests - the queue is clear!')
                            : t('Nothing here yet')}
                    </div>
                ) : (
                    <div className='space-y-2'>
                        {requests.map((request) => (
                            <div
                                key={request.id}
                                className='flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/60 bg-surface-secondary/50 px-3 py-2 text-sm'
                            >
                                <span className='font-semibold text-foreground'>
                                    {request.username || t('deleted account')}
                                </span>
                                <span className='font-mono text-xs text-muted'>
                                    {request.appleIdEmail}
                                </span>
                                <span className='text-xs text-muted'>
                                    {request.createdAt
                                        ? new Date(request.createdAt).toLocaleString()
                                        : ''}
                                </span>
                                <span
                                    className={`rounded px-1.5 py-0.5 text-xs uppercase tracking-wide ${
                                        request.status === 'pending'
                                            ? 'bg-amber-400/15 text-amber-300'
                                            : 'bg-emerald-500/15 text-emerald-400'
                                    }`}
                                >
                                    {t(request.status)}
                                </span>
                                {request.status === 'resolved' && request.resolvedBy && (
                                    <span className='text-xs text-muted'>
                                        {t('by {{name}}', { name: request.resolvedBy })}
                                    </span>
                                )}
                                <span className='ml-auto'>
                                    {request.status === 'pending' ? (
                                        <HeroButton
                                            size='sm'
                                            variant='tertiary'
                                            className='!h-6 !px-2 text-xs'
                                            isDisabled={statusState.isLoading}
                                            onPress={() => changeStatus(request.id, 'resolved')}
                                        >
                                            {t('Mark Resolved')}
                                        </HeroButton>
                                    ) : (
                                        <HeroButton
                                            size='sm'
                                            variant='tertiary'
                                            className='!h-6 !px-2 text-xs'
                                            isDisabled={statusState.isLoading}
                                            onPress={() => changeStatus(request.id, 'pending')}
                                        >
                                            {t('Reopen')}
                                        </HeroButton>
                                    )}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </Panel>
        </div>
    );
};

MobileRequestsAdmin.displayName = 'MobileRequestsAdmin';

export default MobileRequestsAdmin;
