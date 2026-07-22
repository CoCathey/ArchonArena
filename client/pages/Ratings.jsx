import React from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import AmberValue from '../Components/Site/AmberValue';
import { useGetRatingsQuery } from '../redux/api';

const POOL_LABELS = {
    archon: 'Archon',
    sealed: 'Sealed',
    alliance: 'Alliance'
};

/**
 * ARCHON: Ratings (Phase 6). A player's Amber across formats - value, world
 * rank, games, provisional status - plus a plain explainer of how Amber is
 * earned. "Amber" is our name for the player rating (see AmberValue).
 */
const Ratings = () => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);

    const { data, isFetching } = useGetRatingsQuery(user?.username, { skip: !user });
    const ratings = data?.ratings || [];

    return (
        <div className='mx-auto w-full max-w-3xl space-y-4'>
            <Panel title={t('Your Amber')}>
                {!user ? (
                    <p className='text-sm text-muted'>
                        {t('Log in to see your Amber and world ranking.')}{' '}
                        <Link href='/login' className='text-amber-300 underline'>
                            {t('Log In')}
                        </Link>
                    </p>
                ) : ratings.length === 0 ? (
                    <p className='text-sm text-muted'>
                        {isFetching
                            ? t('Loading…')
                            : t(
                                  'You have not played any rated games yet. Jump into Play Online to earn your first Amber.'
                              )}{' '}
                        {!isFetching && (
                            <Link href='/play' className='text-amber-300 underline'>
                                {t('Play Online')}
                            </Link>
                        )}
                    </p>
                ) : (
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
                                    {t('{{count}} rated games', { count: rating.gamesPlayed })}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                {user && ratings.length > 0 && (
                    <p className='mt-3 text-xs text-muted'>
                        {t('See where you stand on the')}{' '}
                        <Link href='/leaderboards' className='text-amber-300 underline'>
                            {t('Leaderboards')}
                        </Link>{' '}
                        {t('and')}{' '}
                        <Link href='/community/top-players' className='text-amber-300 underline'>
                            {t('Top Players')}
                        </Link>
                        .
                    </p>
                )}
            </Panel>

            <Panel title={t('How Amber works')}>
                <div className='space-y-3 text-sm text-muted'>
                    <p>
                        {t(
                            'Amber is your competitive rating - the Archon Arena take on a chess-style Elo. Everyone starts around 1,200 Amber. Win and you gain Amber; lose and you shed it. The amount that moves depends on who you played and how the game went.'
                        )}
                    </p>
                    <ul className='list-disc space-y-1 pl-5'>
                        <li>
                            {t(
                                'Deck power (SAS): beating a stronger deck earns more Amber than beating a weaker one, and losing to a weaker deck costs more.'
                            )}
                        </li>
                        <li>
                            {t(
                                'Key differential: a decisive 3-0 moves more Amber than a nail-biting 3-2.'
                            )}
                        </li>
                        <li>
                            {t(
                                'Provisional: your first several games swing more Amber while the system finds your level. After that your rating settles.'
                            )}
                        </li>
                    </ul>
                    <p>
                        {t(
                            'Amber can go down as well as up - it always reflects your current standing against the field.'
                        )}
                    </p>
                </div>
            </Panel>
        </div>
    );
};

Ratings.displayName = 'Ratings';

export default Ratings;
