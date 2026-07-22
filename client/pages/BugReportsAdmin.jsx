import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, toast } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import { useGetBugReportsQuery, useSetBugReportStatusMutation } from '../redux/api';

/**
 * ARCHON: admin inbox for beta bug reports filed from the sidebar.
 * An inbox, not a ticketing system: read, resolve, reopen.
 */
const BugReportsAdmin = () => {
    const { t } = useTranslation();
    const [statusFilter, setStatusFilter] = useState('open');
    const { data, refetch } = useGetBugReportsQuery(
        statusFilter ? { status: statusFilter } : undefined,
        { pollingInterval: 60000 }
    );
    const [setStatus, statusState] = useSetBugReportStatusMutation();

    const reports = data?.reports || [];

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
        ['open', t('Open')],
        ['resolved', t('Resolved')],
        ['', t('All')]
    ];

    return (
        <div className='mx-auto w-full max-w-4xl'>
            <Panel title={t('Bug Reports')}>
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

                {reports.length === 0 ? (
                    <div className='py-8 text-center text-sm text-muted'>
                        {statusFilter === 'open'
                            ? t('No open reports - the beta is behaving!')
                            : t('Nothing here yet')}
                    </div>
                ) : (
                    <div className='space-y-2'>
                        {reports.map((report) => (
                            <div
                                key={report.id}
                                className='rounded-md border border-border/60 bg-surface-secondary/50 px-3 py-2'
                            >
                                <div className='mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted'>
                                    <span className='font-semibold text-foreground'>
                                        {report.username || t('deleted account')}
                                    </span>
                                    <span>
                                        {report.createdAt
                                            ? new Date(report.createdAt).toLocaleString()
                                            : ''}
                                    </span>
                                    {report.page && (
                                        <span className='rounded bg-surface-tertiary/70 px-1.5 py-0.5 font-mono'>
                                            {report.page}
                                        </span>
                                    )}
                                    <span
                                        className={`rounded px-1.5 py-0.5 uppercase tracking-wide ${
                                            report.status === 'open'
                                                ? 'bg-amber-400/15 text-amber-300'
                                                : 'bg-emerald-500/15 text-emerald-400'
                                        }`}
                                    >
                                        {t(report.status)}
                                    </span>
                                    {report.status === 'resolved' && report.resolvedBy && (
                                        <span>{t('by {{name}}', { name: report.resolvedBy })}</span>
                                    )}
                                    <span className='ml-auto'>
                                        {report.status === 'open' ? (
                                            <HeroButton
                                                size='sm'
                                                variant='tertiary'
                                                className='!h-6 !px-2 text-xs'
                                                isDisabled={statusState.isLoading}
                                                onPress={() => changeStatus(report.id, 'resolved')}
                                            >
                                                {t('Mark Resolved')}
                                            </HeroButton>
                                        ) : (
                                            <HeroButton
                                                size='sm'
                                                variant='tertiary'
                                                className='!h-6 !px-2 text-xs'
                                                isDisabled={statusState.isLoading}
                                                onPress={() => changeStatus(report.id, 'open')}
                                            >
                                                {t('Reopen')}
                                            </HeroButton>
                                        )}
                                    </span>
                                </div>
                                <p className='whitespace-pre-wrap text-sm text-foreground'>
                                    {report.body}
                                </p>
                                {report.userAgent && (
                                    <div className='mt-1 truncate text-xs text-muted/70'>
                                        {report.userAgent}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </Panel>
        </div>
    );
};

BugReportsAdmin.displayName = 'BugReportsAdmin';

export default BugReportsAdmin;
