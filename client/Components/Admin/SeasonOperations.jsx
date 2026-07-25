import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, toast } from '@heroui/react';

import Panel from '../Site/Panel';
import {
    useGetRatingSeasonQuery,
    useApplyRatingDecayMutation,
    useStartNewSeasonMutation
} from '../../redux/api';

/**
 * ARCHON: site-wide season & rating-decay operations for admins. The policy
 * (decay grace/rate/floor, season carry factor and baseline) is configured in
 * the Rating Engine section of Site Settings; these buttons run the operations.
 * Both are safe to re-run — decay is idempotent, a new season is explicit.
 */
const SeasonOperations = () => {
    const { t } = useTranslation();
    const { data: season, refetch } = useGetRatingSeasonQuery();
    const [applyDecay, decayState] = useApplyRatingDecayMutation();
    const [startNewSeason, seasonState] = useStartNewSeasonMutation();

    const onDecay = async () => {
        try {
            const result = await applyDecay().unwrap();

            if (result.success) {
                toast.success(t('Decay applied to {{count}} rating(s)', { count: result.decayed }));
            } else {
                toast.danger(result.message || t('Action failed'));
            }
        } catch {
            toast.danger(t('Action failed'));
        }
    };

    const onNewSeason = async () => {
        if (
            !window.confirm(
                t(
                    'Start a new season? Every rating is soft-reset toward the baseline. This cannot be undone.'
                )
            )
        ) {
            return;
        }

        try {
            const result = await startNewSeason().unwrap();

            if (result.success) {
                toast.success(
                    t('Season {{number}} started ({{count}} ratings adjusted)', {
                        number: result.season,
                        count: result.adjusted
                    })
                );
                refetch();
            } else {
                toast.danger(result.message || t('Action failed'));
            }
        } catch {
            toast.danger(t('Action failed'));
        }
    };

    const startedAt = season?.startedAt ? new Date(season.startedAt).toLocaleDateString() : null;

    return (
        <Panel title={t('Seasons & rating decay')}>
            <p className='mb-3 text-xs text-muted'>
                {t(
                    'Run the season and decay operations. Configure their policy in the Rating Engine section above.'
                )}
            </p>
            <div className='mb-3 text-sm text-foreground'>
                {t('Current season')}:{' '}
                <span className='font-semibold'>{season?.number ?? '-'}</span>
                {startedAt ? (
                    <span className='text-muted'>
                        {' '}
                        {t('(started {{date}})', { date: startedAt })}
                    </span>
                ) : null}
            </div>
            <div className='flex flex-wrap items-center gap-2'>
                <HeroButton
                    size='sm'
                    variant='primary'
                    isPending={seasonState.isLoading}
                    onPress={onNewSeason}
                >
                    {t('Start new season')}
                </HeroButton>
                <HeroButton
                    size='sm'
                    variant='tertiary'
                    isPending={decayState.isLoading}
                    onPress={onDecay}
                >
                    {t('Apply decay now')}
                </HeroButton>
            </div>
        </Panel>
    );
};

SeasonOperations.displayName = 'SeasonOperations';

export default SeasonOperations;
