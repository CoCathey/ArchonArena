import React from 'react';
import { useTranslation } from 'react-i18next';

import Panel from '../Site/Panel';
import Link from '../Navigation/Link';
import AmberValue from '../Site/AmberValue';
import { useGetRatingsQuery } from '../../redux/api';

const POOL_LABELS = {
    archon: 'Archon',
    sealed: 'Sealed',
    alliance: 'Alliance'
};

/**
 * ARCHON: compact Amber standing on the profile/account page - the player's
 * rating, world rank and W-L per pool, linking through to the full Ratings
 * page. Hidden until the player has a rated game. Reuses the public ratings
 * API, mirroring the Ratings page card so the two always agree.
 *
 * @param {{ username?: string }} props
 */
const ProfileRankCard = ({ username }) => {
    const { t } = useTranslation();
    const { data } = useGetRatingsQuery(username, { skip: !username });
    const ratings = data?.ratings || [];

    if (ratings.length === 0) {
        return null;
    }

    return (
        <Panel type='default' compactHeader title={t('Your Amber')}>
            <div className='grid gap-3 sm:grid-cols-2'>
                {ratings.map((rating) => (
                    <div
                        key={rating.pool}
                        className='rounded-lg border border-border/60 bg-surface-secondary/50 px-4 py-3'
                    >
                        <div className='text-xs uppercase tracking-wide text-muted'>
                            {t(POOL_LABELS[rating.pool] || rating.pool)}
                        </div>
                        <div className='mt-1 flex items-end justify-between'>
                            <AmberValue
                                value={rating.rating}
                                className='text-2xl'
                                iconClass='h-5 w-5'
                                showLabel
                            />
                            {rating.provisional && (
                                <span className='rounded bg-accent/20 px-1.5 py-0.5 text-xs text-amber-300'>
                                    {t('Provisional')}
                                </span>
                            )}
                        </div>
                        <div className='mt-2 text-xs text-muted'>
                            {rating.rank
                                ? t('World rank #{{rank}} of {{total}}', {
                                      rank: rating.rank.toLocaleString(),
                                      total: rating.totalRated.toLocaleString()
                                  })
                                : null}
                        </div>
                        <div className='text-xs text-muted'>
                            <span className='font-semibold text-green-400'>{rating.wins ?? 0}</span>
                            {'W – '}
                            <span className='font-semibold text-red-400'>{rating.losses ?? 0}</span>
                            {'L '}
                            {t('({{count}} rated games)', { count: rating.gamesPlayed })}
                        </div>
                    </div>
                ))}
            </div>
            <p className='mt-3 text-xs text-muted'>
                {t('See where you stand on the')}{' '}
                <Link href='/community/leaderboards' className='text-amber-300 underline'>
                    {t('Leaderboards')}
                </Link>
                .
            </p>
        </Panel>
    );
};

ProfileRankCard.displayName = 'ProfileRankCard';

export default ProfileRankCard;
