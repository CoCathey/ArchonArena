import React from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@heroui/react';
import { Link } from 'react-router-dom';

import { useGetMembershipPreviewsQuery, useSetMembershipPreviewMutation } from '../../redux/api';

/**
 * ARCHON (N12): the preview programme, as the member sees it.
 *
 * This is where the three abstract Vault Master promises - experimental
 * features, beta features, priority access - become a list of switches with
 * names on them. That is deliberately the whole design: the tier was previously
 * selling a position in a queue with no queue behind it, and the fix is not
 * better copy, it is a page where you can see what is in the queue and turn it
 * on.
 *
 * ## Three states, not two
 *
 * A row is on, off, or NOT YET YOURS. The third one is the one worth building:
 * a preview whose window has not opened for this account still appears, with
 * the date it does. Omitting those would make a head start invisible to
 * everyone except the people who already have it, and a head start nobody can
 * see is not a benefit, it is a rumour.
 *
 * Saved on toggle rather than through the profile form's Save button, matching
 * NotificationPreferences: this panel is not part of that form, and a switch
 * that silently needs a separate Save is the kind of thing people get wrong once
 * and never trust again.
 */

const STAGE_CLASS = Object.freeze({
    experimental: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/40',
    beta: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
    early_access: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
    released: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
});

const formatDate = (value) => {
    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
};

const PreviewRow = ({ preview, onToggle, isSaving, t }) => (
    <div className='rounded border border-border/60 bg-surface-secondary/30 p-3'>
        <div className='flex flex-wrap items-start justify-between gap-2'>
            <div className='min-w-0'>
                <div className='flex flex-wrap items-center gap-2'>
                    <span className='text-sm font-medium text-foreground'>{preview.label}</span>
                    <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                            STAGE_CLASS[preview.stage] || STAGE_CLASS.released
                        }`}
                    >
                        {t(preview.stageLabel)}
                    </span>
                    {preview.viaPriority && (
                        <span className='rounded-full border border-violet-500/40 bg-violet-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-300'>
                            {t('{{days}} days early', { days: preview.priorityDays })}
                        </span>
                    )}
                </div>
                <p className='m-0 mt-1 max-w-2xl text-xs text-muted'>{preview.summary}</p>
                <p className='m-0 mt-1 text-xs text-muted'>
                    <span className='text-foreground/80'>{t('Where')}:</span> {preview.where}
                    {' · '}
                    {t(preview.caution)}
                </p>
            </div>

            {preview.available ? (
                <label className='flex shrink-0 items-center gap-2 text-xs text-muted'>
                    <input
                        aria-label={t('Enable {{label}}', { label: preview.label })}
                        checked={!!preview.enabled}
                        disabled={isSaving}
                        type='checkbox'
                        onChange={(event) => onToggle(preview, event.target.checked)}
                    />
                    {preview.enabled ? t('On') : t('Off')}
                </label>
            ) : (
                // Not an upsell and not an error - a date. They are already
                // entitled to this preview's stage; they are waiting for it.
                <span className='shrink-0 text-xs text-muted'>
                    {t('Yours from {{date}}', { date: formatDate(preview.availableFrom) })}
                </span>
            )}
        </div>
    </div>
);

const PreviewProgram = () => {
    const { t } = useTranslation();
    const { data, isLoading } = useGetMembershipPreviewsQuery();
    const [setPreview, { isLoading: isSaving }] = useSetMembershipPreviewMutation();

    const previews = data?.previews || [];

    const onToggle = async (preview, enabled) => {
        try {
            await setPreview({ preview: preview.id, enabled }).unwrap();
        } catch {
            toast.danger(t('Could not change that preview'));
        }
    };

    if (isLoading) {
        return <p className='text-sm text-muted'>{t('Loading…')}</p>;
    }

    // Nothing to show is not an error state. An account whose tier reaches no
    // preview stage gets the explanation and a way to change that, rather than
    // an empty box that looks broken.
    if (!previews.length) {
        return (
            <div className='space-y-2'>
                <p className='m-0 text-sm text-muted'>
                    {t(
                        'The preview programme is how features reach players before they are ' +
                            'finished. Vault Master members get experimental and beta tools as they ' +
                            'are built, and every preview reaches them the day it opens.'
                    )}
                </p>
                <Link className='text-sm text-accent hover:underline' to='/membership'>
                    {t('See what membership includes')}
                </Link>
            </div>
        );
    }

    return (
        <div className='space-y-3'>
            <p className='m-0 text-sm text-muted'>
                {t(
                    'Features that exist but are not finished. Switch one on and it appears where ' +
                        'it says it will; switch it off and it goes away again. Nothing here ' +
                        'affects your games, your rating or anybody else.'
                )}
            </p>

            <div className='space-y-2'>
                {previews.map((preview) => (
                    <PreviewRow
                        isSaving={isSaving}
                        key={preview.id}
                        onToggle={onToggle}
                        preview={preview}
                        t={t}
                    />
                ))}
            </div>

            <p className='m-0 text-xs text-muted'>
                {t(
                    'A preview can change or be withdrawn. When one is finished it moves to the ' +
                        'tier it was built for and stops being a switch.'
                )}
            </p>

            {/* A plain link, not <HeroButton as={Link}> - HeroUI's Button does
                not forward routing props, which is the same trap the tier
                buttons on the membership page fell into. */}
            <Link className='text-sm text-accent hover:underline' to='/intelligence'>
                {t('Open Archon Intelligence')}
            </Link>
        </div>
    );
};

PreviewProgram.displayName = 'PreviewProgram';

export default PreviewProgram;
