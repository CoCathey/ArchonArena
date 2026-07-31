import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Label, toast } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import { REASON_LABELS } from '../Components/Site/ReportButton';
import {
    useGetModerationAuditQuery,
    useGetModerationQueueQuery,
    useModerationActMutation,
    useModerationReportActionMutation
} from '../redux/api';

const inputClass =
    'w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none';

const ACTION_LABELS = {
    note: 'Note only',
    warn: 'Warn',
    mute: 'Mute (no chat)',
    timeout: 'Timeout (no play)',
    ban: 'Suspend account'
};

const STATUSES = ['open', 'claimed', 'resolved', 'dismissed'];

/** The snapshot captured when the report was filed. */
const ContextView = ({ report }) => {
    const { t } = useTranslation();
    const context = report.context;

    if (!context) {
        return null;
    }

    return (
        <div className='mt-1 rounded border border-border/40 bg-surface-secondary/60 px-2 py-1 text-xs'>
            <div className='mb-0.5 text-muted'>{t('Captured at report time')}</div>
            {context.text && <div className='font-mono text-foreground'>“{context.text}”</div>}
            {context.name && <div className='text-foreground'>{context.name}</div>}
            {context.description && <div className='text-muted'>{context.description}</div>}
            {/* An in-person dispute: show both accounts side by side, which is
                the whole reason a moderator was called in. */}
            {context.reports && (
                <div className='mt-1 space-y-0.5'>
                    <div className='text-muted'>
                        {context.player1} {t('vs')} {context.player2}
                    </div>
                    {context.reports.map((entry, index) => (
                        <div key={index} className='text-foreground'>
                            {t('Reporter {{id}} says winner {{winner}}, keys {{a}}-{{b}}', {
                                id: entry.reporterId,
                                winner: entry.winnerId,
                                a: entry.player1Keys,
                                b: entry.player2Keys
                            })}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

const ReportRow = ({ report, onChanged }) => {
    const { t } = useTranslation();
    const [resolution, setResolution] = useState('');
    const [action, setAction] = useState('warn');
    const [reason, setReason] = useState('');
    const [hours, setHours] = useState('');
    const [expanded, setExpanded] = useState(false);
    const [reportAction] = useModerationReportActionMutation();
    const [moderationAct] = useModerationActMutation();

    const run = async (promise, message) => {
        try {
            const result = await promise;

            if (result.success) {
                toast.success(message);
                onChanged();
            } else {
                toast.danger(result.message || t('Action failed'));
            }
        } catch {
            toast.danger(t('Action failed'));
        }
    };

    const applySanction = async () => {
        if (!reason.trim()) {
            toast.danger(t('Every moderation action needs a reason'));

            return;
        }

        await run(
            moderationAct({
                targetUserId: report.targetUserId,
                action,
                reason,
                hours: hours === '' ? undefined : Number(hours),
                reportId: report.id
            }).unwrap(),
            t('Action applied')
        );
    };

    const isPattern = report.repeatReports >= report.repeatThreshold;

    return (
        <div className='rounded-md border border-border/50 bg-surface-secondary/40 p-2'>
            <div className='flex flex-wrap items-center gap-2 text-sm'>
                <span className='rounded bg-surface-secondary/70 px-1.5 text-xs uppercase text-muted'>
                    {report.targetType}
                </span>
                <span className='font-semibold text-foreground'>
                    {t(REASON_LABELS[report.reason] || report.reason)}
                </span>
                {report.targetName && (
                    <Link
                        href={`/players/${encodeURIComponent(report.targetName)}`}
                        className='text-amber-300 hover:underline'
                    >
                        {report.targetName}
                    </Link>
                )}
                {/* One complaint is a disagreement; several from different
                    people is a pattern, and the moderator cannot tell which
                    they are looking at from the report alone. */}
                {isPattern && (
                    <span className='rounded bg-red-500/20 px-1.5 text-xs text-red-300'>
                        {t('{{count}} reporters', { count: report.repeatReports })}
                    </span>
                )}
                <span className='ml-auto text-xs text-muted'>
                    {t('by')} {report.reporter || t('deleted account')} ·{' '}
                    {new Date(report.createdAt).toLocaleString()}
                </span>
            </div>

            <p className='mt-1 whitespace-pre-wrap text-sm text-muted'>{report.details}</p>
            <ContextView report={report} />

            {report.status === 'claimed' && (
                <div className='mt-1 text-xs text-muted'>
                    {t('Claimed by {{who}}', { who: report.claimedBy })}
                </div>
            )}
            {report.resolution && (
                <div className='mt-1 text-xs text-muted'>
                    {t('Resolution:')} {report.resolution}
                </div>
            )}

            {report.status !== 'resolved' && report.status !== 'dismissed' && (
                <div className='mt-2 flex flex-wrap gap-1'>
                    {report.status === 'open' ? (
                        <HeroButton
                            size='sm'
                            variant='primary'
                            className='!h-6 !px-2 text-xs'
                            onPress={() =>
                                run(
                                    reportAction({ id: report.id, action: 'claim' }).unwrap(),
                                    t('Claimed')
                                )
                            }
                        >
                            {t('Claim')}
                        </HeroButton>
                    ) : (
                        <HeroButton
                            size='sm'
                            variant='tertiary'
                            className='!h-6 !px-2 text-xs'
                            onPress={() =>
                                run(
                                    reportAction({ id: report.id, action: 'release' }).unwrap(),
                                    t('Released')
                                )
                            }
                        >
                            {t('Release')}
                        </HeroButton>
                    )}
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        className='!h-6 !px-2 text-xs'
                        onPress={() => setExpanded(!expanded)}
                    >
                        {t('Act / resolve')}
                    </HeroButton>
                </div>
            )}

            {expanded && (
                <div className='mt-2 space-y-2 rounded border border-border/40 p-2'>
                    {report.targetUserId && (
                        <div className='grid gap-2 sm:grid-cols-3'>
                            <div>
                                <Label>{t('Action')}</Label>
                                <select
                                    className={inputClass}
                                    value={action}
                                    onChange={(event) => setAction(event.target.value)}
                                >
                                    {Object.entries(ACTION_LABELS).map(([value, text]) => (
                                        <option key={value} value={value}>
                                            {t(text)}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <Label>{t('Hours (blank = default)')}</Label>
                                <input
                                    type='number'
                                    min={1}
                                    className={inputClass}
                                    value={hours}
                                    onChange={(event) => setHours(event.target.value)}
                                />
                            </div>
                            <div>
                                <Label>{t('Reason (shown to the player)')}</Label>
                                <input
                                    type='text'
                                    className={inputClass}
                                    value={reason}
                                    onChange={(event) => setReason(event.target.value)}
                                />
                            </div>
                            <div className='sm:col-span-3'>
                                <HeroButton
                                    size='sm'
                                    variant='primary'
                                    className='!h-6 !px-2 text-xs'
                                    onPress={applySanction}
                                >
                                    {t('Apply to {{who}}', { who: report.targetName })}
                                </HeroButton>
                            </div>
                        </div>
                    )}

                    <div>
                        <Label>{t('How was this resolved?')}</Label>
                        <input
                            type='text'
                            className={inputClass}
                            value={resolution}
                            onChange={(event) => setResolution(event.target.value)}
                        />
                    </div>
                    <div className='flex gap-1'>
                        <HeroButton
                            size='sm'
                            variant='primary'
                            className='!h-6 !px-2 text-xs'
                            isDisabled={!resolution.trim()}
                            onPress={() =>
                                run(
                                    reportAction({
                                        id: report.id,
                                        action: 'resolve',
                                        body: { resolution }
                                    }).unwrap(),
                                    t('Resolved')
                                )
                            }
                        >
                            {t('Resolve')}
                        </HeroButton>
                        <HeroButton
                            size='sm'
                            variant='tertiary'
                            className='!h-6 !px-2 text-xs'
                            isDisabled={!resolution.trim()}
                            onPress={() =>
                                run(
                                    reportAction({
                                        id: report.id,
                                        action: 'resolve',
                                        body: { resolution, dismiss: true }
                                    }).unwrap(),
                                    t('Dismissed')
                                )
                            }
                        >
                            {t('Dismiss')}
                        </HeroButton>
                    </div>
                </div>
            )}
        </div>
    );
};

/**
 * ARCHON (N5): the moderation queue.
 *
 * Claim before acting, so two moderators do not sanction the same player
 * twice for the same thing; resolve with a written reason, because a closed
 * report with no reasoning is indistinguishable from one that was ignored.
 */
const ModerationQueue = () => {
    const { t } = useTranslation();
    const [status, setStatus] = useState('open');
    const { data, refetch } = useGetModerationQueueQuery({ status });
    const { data: audit } = useGetModerationAuditQuery({ limit: 30 });

    return (
        <div className='mx-auto w-full max-w-4xl space-y-4'>
            <Panel title={t('Moderation queue')}>
                <div className='mb-3 flex gap-1'>
                    {STATUSES.map((option) => (
                        <HeroButton
                            key={option}
                            size='sm'
                            variant={option === status ? 'primary' : 'tertiary'}
                            className='!h-6 !px-2 text-xs capitalize'
                            onPress={() => setStatus(option)}
                        >
                            {t(option)}
                        </HeroButton>
                    ))}
                </div>
                <div className='space-y-2'>
                    {(data?.reports || []).map((report) => (
                        <ReportRow key={report.id} report={report} onChanged={refetch} />
                    ))}
                    {data?.reports?.length === 0 && (
                        <div className='text-sm text-muted'>
                            {status === 'open' ? t('Nothing waiting. ') : t('Nothing here.')}
                        </div>
                    )}
                </div>
            </Panel>

            <Panel title={t('Audit log')}>
                <p className='mb-2 text-xs text-muted'>
                    {t(
                        'Every moderator action, and every settings change, with who did it. Entries keep the moderator’s name even if the account is later deleted.'
                    )}
                </p>
                <div className='space-y-1'>
                    {(audit?.entries || []).map((entry) => (
                        <div
                            key={entry.id}
                            className='flex flex-wrap items-baseline gap-2 rounded bg-surface-secondary/50 px-2 py-1 text-xs'
                        >
                            <span className='font-mono text-amber-300'>{entry.action}</span>
                            <span className='text-foreground'>{entry.actor || t('unknown')}</span>
                            {entry.targetName && (
                                <span className='text-muted'>→ {entry.targetName}</span>
                            )}
                            {entry.detail?.reason && (
                                <span className='text-muted'>“{entry.detail.reason}”</span>
                            )}
                            <span className='ml-auto text-muted'>
                                {new Date(entry.createdAt).toLocaleString()}
                            </span>
                        </div>
                    ))}
                    {audit?.entries?.length === 0 && (
                        <div className='text-sm text-muted'>{t('Nothing logged yet.')}</div>
                    )}
                </div>
            </Panel>
        </div>
    );
};

ModerationQueue.displayName = 'ModerationQueue';

export default ModerationQueue;
