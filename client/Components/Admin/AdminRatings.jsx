import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, toast } from '@heroui/react';

import Panel from '../Site/Panel';
import AmberValue from '../Site/AmberValue';
import {
    useGetRatingsQuery,
    useAdminSetRatingMutation,
    useAdminResetRatingsMutation
} from '../../redux/api';

const inputClass =
    'w-24 rounded-md border border-border/65 bg-surface-secondary/55 px-2 py-1 text-sm text-foreground focus:border-border/90 focus:outline-none dark:border-border/80 dark:bg-surface-secondary/85';

const POOLS = ['archon', 'sealed', 'alliance'];

/**
 * ARCHON: admin tool - view, set, or reset a player's Amber per pool.
 * Setting writes the rating (and optionally games played) directly;
 * resetting deletes the pool row so the player re-enters at the default
 * as provisional. RatingHistory is never touched (audit trail).
 */
const AdminRatings = ({ username }) => {
    const { t } = useTranslation();
    const { data, refetch } = useGetRatingsQuery(username, { skip: !username });
    const [adminSetRating, setState] = useAdminSetRatingMutation();
    const [adminResetRatings] = useAdminResetRatingsMutation();
    const [drafts, setDrafts] = useState({});

    const ratings = data?.ratings || [];
    const byPool = Object.fromEntries(ratings.map((rating) => [rating.pool, rating]));

    const run = async (promise, successMessage) => {
        try {
            const result = await promise.unwrap();

            if (result.success) {
                toast.success(successMessage);
                refetch();
            } else {
                toast.danger(result.message || t('Action failed'));
            }
        } catch {
            toast.danger(t('Action failed'));
        }
    };

    return (
        <Panel title={t('Amber (ratings)')}>
            <div className='space-y-2'>
                {POOLS.map((pool) => {
                    const current = byPool[pool];
                    const draft = drafts[pool] || {};

                    return (
                        <div
                            key={pool}
                            className='flex flex-wrap items-center gap-2 rounded-md border border-border/45 bg-surface-secondary/30 px-2 py-1.5'
                        >
                            <span className='w-16 text-sm font-semibold capitalize text-foreground'>
                                {pool}
                            </span>
                            <span className='w-24'>
                                {current ? (
                                    <AmberValue value={current.rating} />
                                ) : (
                                    <span className='text-xs text-muted'>{t('unrated')}</span>
                                )}
                            </span>
                            <span className='w-20 text-xs text-muted'>
                                {current
                                    ? t('{{count}} games', { count: current.gamesPlayed })
                                    : ''}
                            </span>
                            <input
                                type='number'
                                className={inputClass}
                                placeholder={t('Amber')}
                                value={draft.rating ?? ''}
                                onChange={(event) =>
                                    setDrafts((all) => ({
                                        ...all,
                                        [pool]: { ...draft, rating: event.target.value }
                                    }))
                                }
                            />
                            <input
                                type='number'
                                className={inputClass}
                                placeholder={t('Games')}
                                value={draft.gamesPlayed ?? ''}
                                onChange={(event) =>
                                    setDrafts((all) => ({
                                        ...all,
                                        [pool]: { ...draft, gamesPlayed: event.target.value }
                                    }))
                                }
                            />
                            <HeroButton
                                size='sm'
                                variant='tertiary'
                                className='!h-7 !px-2 text-xs'
                                isDisabled={draft.rating === undefined || draft.rating === ''}
                                isPending={setState.isLoading}
                                onPress={() =>
                                    run(
                                        adminSetRating({
                                            username,
                                            pool,
                                            rating: parseInt(draft.rating, 10),
                                            gamesPlayed:
                                                draft.gamesPlayed === undefined ||
                                                draft.gamesPlayed === ''
                                                    ? undefined
                                                    : parseInt(draft.gamesPlayed, 10)
                                        }),
                                        t('Rating updated')
                                    )
                                }
                            >
                                {t('Set')}
                            </HeroButton>
                            {current && (
                                <HeroButton
                                    size='sm'
                                    variant='tertiary'
                                    className='!h-7 !px-2 text-xs'
                                    onPress={() => {
                                        if (
                                            window.confirm(
                                                t(
                                                    "Reset {{username}}'s {{pool}} rating? They will re-enter at the default as provisional.",
                                                    { username, pool }
                                                )
                                            )
                                        ) {
                                            run(
                                                adminResetRatings({ username, pool }),
                                                t('Rating reset')
                                            );
                                        }
                                    }}
                                >
                                    {t('Reset')}
                                </HeroButton>
                            )}
                        </div>
                    );
                })}
            </div>
            <p className='mt-2 text-xs text-muted'>
                {t(
                    'Set writes the Amber value directly (games optional). Reset removes the rating so the player starts fresh. Game history is never altered.'
                )}
            </p>
        </Panel>
    );
};

AdminRatings.displayName = 'AdminRatings';

export default AdminRatings;
