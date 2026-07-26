import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import AmberValue from '../Components/Site/AmberValue';
import { countryName } from '../geo';
import { useGetLeaderboardQuery, useGetLocationQuery } from '../redux/api';

const PAGE_SIZE = 50;

/**
 * ARCHON: rankings (Phase 6). Worldwide / region / country / state
 * leaderboards over the rating pools. Region, country, and state scopes
 * follow the viewing player's saved location.
 */
const Leaderboards = () => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    const [scope, setScope] = useState('world');
    const [pool, setPool] = useState('archon');
    const [page, setPage] = useState(0);

    const { data: location } = useGetLocationQuery(undefined, { skip: !user });

    const scopeParams =
        scope === 'region'
            ? { region: location?.region }
            : scope === 'country'
            ? { country: location?.country }
            : scope === 'state'
            ? { country: location?.country, state: location?.state }
            : {};

    const scopeReady =
        scope === 'world' ||
        (scope === 'region' && !!location?.region) ||
        (scope === 'country' && !!location?.country) ||
        (scope === 'state' && !!location?.country && !!location?.state);

    const { data, isFetching } = useGetLeaderboardQuery(
        // Over-fetch one row so we can tell whether a next page exists even
        // when the current page is exactly full (otherwise "Next" stays
        // enabled on a full final page and advances to an empty page).
        { pool, scope, limit: PAGE_SIZE + 1, offset: page * PAGE_SIZE, ...scopeParams },
        { skip: !scopeReady }
    );

    const rawEntries = data?.entries || [];
    const hasMore = rawEntries.length > PAGE_SIZE;
    const entries = rawEntries.slice(0, PAGE_SIZE);

    const scopes = [
        ['world', t('World')],
        ['region', t('Region')],
        ['country', t('Country')],
        ['state', t('State')]
    ];

    const pools = [
        ['archon', t('Archon')],
        ['sealed', t('Sealed')],
        ['alliance', t('Alliance')]
    ];

    const scopeLabel =
        scope === 'region'
            ? location?.region
            : scope === 'country'
            ? countryName(location?.country)
            : scope === 'state'
            ? `${location?.state}, ${countryName(location?.country)}`
            : t('Worldwide');

    return (
        <div className='mx-auto w-full max-w-4xl'>
            <Panel title={t('Leaderboards')}>
                <div className='mb-3 flex flex-wrap items-center gap-2'>
                    <div className='flex gap-1'>
                        {scopes.map(([key, label]) => (
                            <HeroButton
                                key={key}
                                size='sm'
                                variant={scope === key ? 'primary' : 'tertiary'}
                                onPress={() => {
                                    setScope(key);
                                    setPage(0);
                                }}
                            >
                                {label}
                            </HeroButton>
                        ))}
                    </div>
                    <div className='ml-auto flex gap-1'>
                        {pools.map(([key, label]) => (
                            <HeroButton
                                key={key}
                                size='sm'
                                variant={pool === key ? 'primary' : 'tertiary'}
                                onPress={() => {
                                    setPool(key);
                                    setPage(0);
                                }}
                            >
                                {label}
                            </HeroButton>
                        ))}
                    </div>
                </div>

                {!scopeReady ? (
                    <div className='rounded-md border border-border/60 bg-surface-secondary/70 px-3 py-4 text-sm text-muted'>
                        {user ? (
                            <>
                                {t('Set your location to see this leaderboard.')}{' '}
                                <Link href='/profile' className='text-amber-300 underline'>
                                    {t('Set location')}
                                </Link>
                            </>
                        ) : (
                            <>
                                {t('Log in and set your location to see this leaderboard.')}{' '}
                                <Link href='/login' className='text-amber-300 underline'>
                                    {t('Log In')}
                                </Link>
                            </>
                        )}
                    </div>
                ) : (
                    <>
                        <div className='mb-2 text-xs uppercase tracking-wide text-muted'>
                            {scopeLabel}
                        </div>
                        <div className='overflow-x-auto'>
                            <table className='w-full text-sm'>
                                <thead>
                                    <tr className='border-b border-border/70 text-left text-xs uppercase tracking-wide text-muted'>
                                        <th className='px-2 py-2 w-12'>#</th>
                                        <th className='px-2 py-2'>{t('Player')}</th>
                                        <th className='px-2 py-2'>{t('Location')}</th>
                                        <th className='px-2 py-2 text-right'>{t('Amber')}</th>
                                        <th className='px-2 py-2 text-right'>{t('Record')}</th>
                                        <th className='px-2 py-2 text-right'>{t('Games')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {entries.map((entry) => (
                                        <tr
                                            key={entry.username}
                                            className={`border-b border-border/40 ${
                                                entry.username === user?.username
                                                    ? 'bg-accent/15'
                                                    : ''
                                            }`}
                                        >
                                            <td className='px-2 py-2 font-semibold text-muted'>
                                                {entry.rank}
                                            </td>
                                            <td className='px-2 py-2 font-semibold text-foreground'>
                                                <Link
                                                    href={`/players/${encodeURIComponent(
                                                        entry.username
                                                    )}`}
                                                    className='hover:text-amber-300 hover:underline'
                                                >
                                                    {entry.username}
                                                </Link>
                                                {entry.provisional && (
                                                    <span
                                                        className='ml-1 text-xs text-muted'
                                                        title={t('Provisional rating')}
                                                    >
                                                        ?
                                                    </span>
                                                )}
                                            </td>
                                            <td className='px-2 py-2 text-muted'>
                                                {[
                                                    entry.state,
                                                    entry.country && countryName(entry.country)
                                                ]
                                                    .filter(Boolean)
                                                    .join(', ')}
                                            </td>
                                            <td className='px-2 py-2 text-right'>
                                                <AmberValue value={entry.rating} />
                                            </td>
                                            <td className='px-2 py-2 text-right text-muted'>
                                                <span className='text-green-400'>
                                                    {entry.wins ?? 0}
                                                </span>
                                                {'–'}
                                                <span className='text-red-400'>
                                                    {entry.losses ?? 0}
                                                </span>
                                            </td>
                                            <td className='px-2 py-2 text-right text-muted'>
                                                {entry.gamesPlayed}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {entries.length === 0 && !isFetching && (
                            <div className='px-2 py-6 text-center text-sm text-muted'>
                                {t(
                                    'No ranked players here yet. Play rated games to claim the top spot!'
                                )}
                            </div>
                        )}
                        <div className='mt-3 flex items-center justify-between'>
                            <HeroButton
                                size='sm'
                                variant='tertiary'
                                isDisabled={page === 0}
                                onPress={() => setPage((current) => Math.max(0, current - 1))}
                            >
                                {t('Previous')}
                            </HeroButton>
                            <span className='text-xs text-muted'>
                                {t('Page {{page}}', { page: page + 1 })}
                            </span>
                            <HeroButton
                                size='sm'
                                variant='tertiary'
                                isDisabled={!hasMore}
                                onPress={() => setPage((current) => current + 1)}
                            >
                                {t('Next')}
                            </HeroButton>
                        </div>
                    </>
                )}
            </Panel>
        </div>
    );
};

Leaderboards.displayName = 'Leaderboards';

export default Leaderboards;
