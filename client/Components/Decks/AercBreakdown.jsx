import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * ARCHON: the AERC components behind a deck's SAS score.
 *
 * SAS is one number; AERC is what it is made of — how much amber control,
 * creature control, efficiency and so on the deck actually has. The platform
 * has stored the whole Decks of KeyForge payload since SAS enrichment landed
 * but never read it back, so players saw the verdict without the reasoning.
 *
 * Bars are scaled against the largest component present rather than a fixed
 * ceiling, because the components have very different natural ranges — a fixed
 * scale would make most of them look like noise.
 *
 * @param {{ aerc?: object }} props
 */
const AercBreakdown = ({ aerc }) => {
    const { t } = useTranslation();

    if (!aerc || !aerc.components || aerc.components.length === 0) {
        return null;
    }

    const max = Math.max(...aerc.components.map((component) => Math.abs(component.value)), 1);

    return (
        <div className='space-y-2'>
            <div className='flex flex-wrap items-baseline gap-x-3 gap-y-1'>
                <span className='text-sm font-semibold text-foreground'>{t('AERC breakdown')}</span>
                {aerc.aercScore != null && (
                    <span className='text-xs text-muted'>
                        {t('AERC {{score}}', { score: aerc.aercScore })}
                    </span>
                )}
                {aerc.sasPercentile != null && (
                    <span className='text-xs text-muted'>
                        {t('Better than {{percentile}}% of decks', {
                            percentile: Math.round(aerc.sasPercentile)
                        })}
                    </span>
                )}
            </div>

            <ul className='space-y-1'>
                {aerc.components.map((component) => (
                    <li key={component.key} className='flex items-center gap-2 text-xs'>
                        <span className='w-36 shrink-0 text-muted'>{t(component.label)}</span>
                        <span className='h-2 min-w-0 flex-1 overflow-hidden rounded bg-surface-secondary/70'>
                            <span
                                className='block h-full rounded bg-amber-400/80'
                                style={{
                                    width: `${Math.round((Math.abs(component.value) / max) * 100)}%`
                                }}
                            />
                        </span>
                        <span className='w-10 shrink-0 text-right font-semibold text-foreground'>
                            {Math.round(component.value * 10) / 10}
                        </span>
                    </li>
                ))}
            </ul>

            {(aerc.synergyRating != null || aerc.antisynergyRating != null) && (
                <div className='flex flex-wrap gap-x-4 text-xs text-muted'>
                    {aerc.synergyRating != null && (
                        <span>{t('Synergy {{value}}', { value: aerc.synergyRating })}</span>
                    )}
                    {aerc.antisynergyRating != null && (
                        <span>{t('Antisynergy {{value}}', { value: aerc.antisynergyRating })}</span>
                    )}
                </div>
            )}
        </div>
    );
};

AercBreakdown.displayName = 'AercBreakdown';

export default AercBreakdown;
