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
    // ARCHON (N4): seasons and decay have existed in the engine since Phase 5
    // but were completely invisible to players.
    const currentSeason = data?.currentSeason;
    const seasonHistory = data?.seasonHistory || [];

    return (
        <div className='mx-auto w-full max-w-3xl space-y-4'>
            <Panel
                title={
                    currentSeason?.number
                        ? t('Your Amber — Season {{season}}', { season: currentSeason.number })
                        : t('Your Amber')
                }
            >
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
                                    <span className='font-semibold text-green-400'>
                                        {rating.wins ?? 0}
                                    </span>
                                    {'W – '}
                                    <span className='font-semibold text-red-400'>
                                        {rating.losses ?? 0}
                                    </span>
                                    {'L '}
                                    {t('({{count}} rated games)', { count: rating.gamesPlayed })}
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

            {/* ARCHON (N4): the end-of-season summary. A soft reset used to
                move a player's Amber with no explanation anywhere on the site. */}
            {seasonHistory.length > 0 && (
                <Panel title={t('Your seasons')}>
                    <p className='mb-3 text-xs text-muted'>
                        {t(
                            'Where you finished each season, and what the soft reset carried into the next one.'
                        )}
                    </p>
                    <div className='overflow-x-auto'>
                        <table className='w-full text-left text-sm'>
                            <thead>
                                <tr className='text-xs uppercase tracking-wide text-muted'>
                                    <th className='px-2 py-1'>{t('Season')}</th>
                                    <th className='px-2 py-1'>{t('Pool')}</th>
                                    <th className='px-2 py-1 text-center'>{t('Finished')}</th>
                                    <th className='px-2 py-1 text-center'>{t('Amber')}</th>
                                    <th className='px-2 py-1 text-center'>{t('Reset to')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {seasonHistory.map((entry) => (
                                    <tr
                                        key={`${entry.season}-${entry.pool}`}
                                        className='border-b border-border/40'
                                    >
                                        <td className='px-2 py-1.5 text-foreground'>
                                            <Link
                                                href={`/leaderboards?season=${entry.season}`}
                                                className='hover:text-amber-300 hover:underline'
                                            >
                                                {t('Season {{season}}', { season: entry.season })}
                                            </Link>
                                        </td>
                                        <td className='px-2 py-1.5 text-muted'>
                                            {t(POOL_LABELS[entry.pool] || entry.pool)}
                                        </td>
                                        <td className='px-2 py-1.5 text-center text-muted'>
                                            {entry.rank ? `#${entry.rank}` : t('Unranked')}
                                        </td>
                                        <td className='px-2 py-1.5 text-center font-semibold text-foreground'>
                                            {entry.rating}
                                        </td>
                                        <td className='px-2 py-1.5 text-center text-muted'>
                                            {entry.ratingAfterReset}
                                            {entry.resetDelta !== 0 && (
                                                <span
                                                    className={`ml-1 text-xs ${
                                                        entry.resetDelta > 0
                                                            ? 'text-emerald-300'
                                                            : 'text-rose-300'
                                                    }`}
                                                >
                                                    ({entry.resetDelta > 0 ? '+' : ''}
                                                    {entry.resetDelta})
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </Panel>
            )}

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
                        <li>
                            {t(
                                'At the top: very high-rated players move in smaller steps, so the top of the ladder stays stable and hard-earned.'
                            )}
                        </li>
                    </ul>
                    <p>
                        {t(
                            'Amber can go down as well as up - it always reflects your current standing against the field.'
                        )}
                    </p>
                    <p>
                        {t(
                            'Seasons: when a new season starts, every rating is softly reset toward the middle - you keep part of the gap you built, so a strong season still counts for something without the ladder freezing in place. Your previous finishes are kept, and the exact reset is shown above.'
                        )}
                    </p>
                </div>
            </Panel>
        </div>
    );
};

Ratings.displayName = 'Ratings';

export default Ratings;
