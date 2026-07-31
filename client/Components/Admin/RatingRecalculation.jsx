import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, toast } from '@heroui/react';

import Panel from '../Site/Panel';
import { useRecalculateRatingsMutation } from '../../redux/api';

/**
 * ARCHON (N4): rebuild the ladder by replaying RatingHistory under the current
 * Elo configuration.
 *
 * Tuning the Elo config only ever affected games played after the change, so a
 * config that turned out wrong stayed baked into the ladder forever. This
 * replays the recorded results under the config as it stands now.
 *
 * The dry run is not optional-by-convention, it is the only thing this
 * component can do until the operator has seen a report: the Apply button does
 * not exist until a preview has come back, and it clears as soon as anything
 * else changes. Committing rewrites the competitive standing of every player on
 * the site and there is no undo.
 */
const RatingRecalculation = () => {
    const { t } = useTranslation();
    const [recalculate, { isLoading }] = useRecalculateRatingsMutation();
    const [report, setReport] = useState(null);

    const run = async (confirm) => {
        try {
            const result = await recalculate({ confirm }).unwrap();

            if (!result.success) {
                toast.danger(result.message || t('Recalculation failed'));
                setReport(null);

                return;
            }

            if (result.committed) {
                toast.success(
                    t('Recalculation applied: {{count}} rating(s) rewritten', {
                        count: result.changed
                    })
                );
                // The preview described a ladder that no longer exists.
                setReport(null);

                return;
            }

            setReport(result);
        } catch {
            toast.danger(t('Recalculation failed'));
            setReport(null);
        }
    };

    const onApply = async () => {
        if (
            !window.confirm(
                t(
                    'Rewrite {{count}} rating(s) from the replayed history? This changes the standing of every affected player and cannot be undone.',
                    { count: report.changed }
                )
            )
        ) {
            return;
        }

        await run(true);
    };

    return (
        <Panel title={t('Rating recalculation')}>
            <p className='mb-3 text-xs text-muted'>
                {t(
                    'Replays every recorded game under the Elo settings above and rebuilds the ladder. Changing those settings only affects future games until you run this. Always a preview first.'
                )}
            </p>

            <div className='flex flex-wrap items-center gap-2'>
                <HeroButton
                    size='sm'
                    variant='primary'
                    isPending={isLoading}
                    onPress={() => run(false)}
                >
                    {t('Preview recalculation')}
                </HeroButton>
                {report && report.changed > 0 && (
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        isPending={isLoading}
                        onPress={onApply}
                    >
                        {t('Apply to {{count}} rating(s)', { count: report.changed })}
                    </HeroButton>
                )}
            </div>

            {report && (
                <div className='mt-3 space-y-2 text-sm'>
                    <div className='text-foreground'>
                        {t(
                            '{{games}} games replayed · {{changed}} of {{compared}} ratings would change',
                            {
                                games: report.gamesReplayed,
                                changed: report.changed,
                                compared: report.ratingsCompared
                            }
                        )}
                        {report.seededFromSeason ? (
                            <span className='text-muted'>
                                {' '}
                                {t('(season {{season}} onward)', {
                                    season: report.seededFromSeason
                                })}
                            </span>
                        ) : null}
                    </div>

                    {report.changed === 0 ? (
                        <p className='text-muted'>
                            {t(
                                'Nothing would change - the ladder already matches the current settings.'
                            )}
                        </p>
                    ) : (
                        <div className='overflow-x-auto'>
                            <table className='w-full text-left text-sm'>
                                <thead>
                                    <tr className='text-xs uppercase tracking-wide text-muted'>
                                        <th className='px-2 py-1'>{t('Player')}</th>
                                        <th className='px-2 py-1'>{t('Pool')}</th>
                                        <th className='px-2 py-1 text-center'>{t('Now')}</th>
                                        <th className='px-2 py-1 text-center'>{t('Would be')}</th>
                                        <th className='px-2 py-1 text-center'>{t('Change')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {report.movers.map((mover) => (
                                        <tr
                                            key={`${mover.userId}-${mover.pool}`}
                                            className='border-b border-border/40'
                                        >
                                            <td className='px-2 py-1.5 text-foreground'>
                                                {mover.username}
                                            </td>
                                            <td className='px-2 py-1.5 text-muted'>{mover.pool}</td>
                                            <td className='px-2 py-1.5 text-center text-muted'>
                                                {mover.before}
                                            </td>
                                            <td className='px-2 py-1.5 text-center text-foreground'>
                                                {mover.after}
                                            </td>
                                            <td
                                                className={`px-2 py-1.5 text-center font-semibold ${
                                                    mover.delta > 0
                                                        ? 'text-emerald-300'
                                                        : 'text-rose-300'
                                                }`}
                                            >
                                                {mover.delta > 0 ? '+' : ''}
                                                {mover.delta}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {report.changed > report.movers.length && (
                                <p className='mt-2 text-xs text-muted'>
                                    {t('Showing the {{shown}} largest of {{total}} changes.', {
                                        shown: report.movers.length,
                                        total: report.changed
                                    })}
                                </p>
                            )}
                        </div>
                    )}

                    <p className='text-xs text-muted'>
                        {t(
                            'Decay is not replayed - it depends on inactivity rather than games. Applying clears the decay marker so the next sweep re-derives it from the rebuilt ratings.'
                        )}
                    </p>
                </div>
            )}
        </Panel>
    );
};

RatingRecalculation.displayName = 'RatingRecalculation';

export default RatingRecalculation;
