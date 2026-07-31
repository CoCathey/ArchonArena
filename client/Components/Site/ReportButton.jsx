import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Label, toast } from '@heroui/react';

import { useGetModerationOptionsQuery, useSubmitReportMutation } from '../../redux/api';

const inputClass =
    'w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none';

const REASON_LABELS = {
    harassment: 'Harassment or abuse',
    'hate-speech': 'Hate speech',
    cheating: 'Cheating',
    collusion: 'Collusion or result fixing',
    'inappropriate-name': 'Inappropriate name',
    spam: 'Spam or advertising',
    other: 'Something else'
};

/**
 * ARCHON (N5): report from the surface where the problem appears.
 *
 * Deliberately a small inline control rather than a link to a report page:
 * the acceptance criterion is two clicks, and a form that makes someone
 * re-describe *which* message or deck they meant is both slower and less
 * accurate than one that already knows. The server captures a snapshot of the
 * target, so the report survives the evidence being deleted.
 */
const ReportButton = ({ targetType, targetId, targetUsername, label, className }) => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    const [open, setOpen] = useState(false);
    const [reason, setReason] = useState('harassment');
    const [details, setDetails] = useState('');
    const { data: options } = useGetModerationOptionsQuery(undefined, { skip: !open });
    const [submitReport, { isLoading }] = useSubmitReportMutation();

    // Reporting needs an account - an anonymous report cannot be followed up
    // and is the easiest thing in the world to flood a queue with.
    if (!user) {
        return null;
    }

    const submit = async () => {
        try {
            const result = await submitReport({
                targetType,
                targetId,
                targetUsername,
                reason,
                details
            }).unwrap();

            if (result.success) {
                toast.success(t('Thank you - a moderator will look at this.'));
                setOpen(false);
                setDetails('');
            } else {
                toast.danger(result.message || t('Could not file the report'));
            }
        } catch {
            toast.danger(t('Could not file the report'));
        }
    };

    if (!open) {
        return (
            <HeroButton
                size='sm'
                variant='tertiary'
                className={`!h-6 !px-2 text-xs ${className || ''}`}
                onPress={() => setOpen(true)}
            >
                {label || t('Report')}
            </HeroButton>
        );
    }

    const reasons = options?.reasons || Object.keys(REASON_LABELS);

    return (
        <div className='mt-2 space-y-2 rounded-md border border-border/60 bg-surface-secondary/40 p-3'>
            <div>
                <Label>{t('What is wrong?')}</Label>
                <select
                    className={inputClass}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                >
                    {reasons.map((option) => (
                        <option key={option} value={option}>
                            {t(REASON_LABELS[option] || option)}
                        </option>
                    ))}
                </select>
            </div>
            <div>
                <Label>{t('What happened?')}</Label>
                <textarea
                    className={`${inputClass} min-h-20`}
                    value={details}
                    maxLength={4000}
                    placeholder={t('A moderator will read this. Please be specific.')}
                    onChange={(event) => setDetails(event.target.value)}
                />
            </div>
            <div className='flex gap-2'>
                <HeroButton
                    size='sm'
                    variant='primary'
                    isPending={isLoading}
                    isDisabled={details.trim().length < 10}
                    onPress={submit}
                >
                    {t('Send report')}
                </HeroButton>
                <HeroButton size='sm' variant='tertiary' onPress={() => setOpen(false)}>
                    {t('Cancel')}
                </HeroButton>
            </div>
            <p className='text-xs text-muted'>
                {t(
                    'We record what you are reporting as it is now, so deleting it later does not erase the report.'
                )}
            </p>
        </div>
    );
};

ReportButton.displayName = 'ReportButton';

export default ReportButton;
export { REASON_LABELS };
