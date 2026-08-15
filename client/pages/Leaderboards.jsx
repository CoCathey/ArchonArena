import React, { useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import PlayerName from '../Components/Site/PlayerName';
import AmberValue from '../Components/Site/AmberValue';
import Avatar from '../Components/Site/Avatar';
import { countryName } from '../geo';
import {
    useGetLeaderboardQuery,
    useGetLocationQuery,
    useGetSeasonsQuery,
    useGetSeasonStandingsQuery
} from '../redux/api';

const PAGE_SIZE = 50;

// Podium display order: 2nd, 1st, 3rd, so the winner stands in the middle.
const PODIUM_STYLES = [
    { medal: '🥈', ring: 'ring-slate-300/70', pad: 'sm:mt-6' },
    { medal: '🥇', ring: 'ring-amber-400/80', pad: '' },
    { medal: '🥉', ring: 'ring-orange-400/70', pad: 'sm:mt-10' }
];

const locationOf = (entry) =>
    [entry.state, entry.country && countryName(entry.country)].filter(Boolean).join(', ');

/**
 * The top three, as a podium. Shown above the table on the first page of any
 * ladder.
 *
 * This came from the old Top Players page, which was this podium over a
 * hard-coded worldwide top 25 - so it duplicated this page at one scope and
 * could not do any of the others. Folding it in here means the podium now
 * works for a country or a finished season too, which it never could as a
 * separate page.
 */
const Podium = ({ entries }) => {
    if (entries.length === 0) {
        return null;
    }

    const ordered = [entries[1], entries[0], entries[2]];

    return (
        <div className='mb-6 grid grid-cols-3 gap-2 sm:gap-4'>
            {ordered.map((entry, index) =>
                entry ? (
                    <div
                        key={entry.username}
                        className={`flex flex-col items-center rounded-lg border border-border/60 bg-surface-secondary/50 px-2 py-4 text-center ${PODIUM_STYLES[index].pad}`}
                    >
                        <div className='text-2xl'>{PODIUM_STYLES[index].medal}</div>
                        <div className={`mt-1 rounded-full ring-2 ${PODIUM_STYLES[index].ring}`}>
                            <Avatar imgPath={entry.avatar} />
                        </div>
                        <div className='mt-2 truncate text-sm font-bold text-foreground'>
                            <PlayerName
                                className='hover:text-amber-300'
                                link
                                username={entry.username}
                            />
                        </div>
                        {locationOf(entry) && (
                            <div className='truncate text-xs text-muted'>{locationOf(entry)}</div>
                        )}
                        <div className='mt-1'>
                            <AmberValue value={entry.rating} />
                        </div>
                    </div>
                ) : (
                    <div key={`empty-${index}`} />
                )
            )}
        </div>
    );
};

Podium.displayName = 'LeaderboardPodium';

/**
 * ARCHON: rankings (Phase 6). Worldwide / region / country / state
 * leaderboards over the rating pools, with a podium for the top three.
 * Region, country, and state scopes follow the viewing player's saved
 * location.
 *
 * This is the site's only rankings page. "Top Players" used to sit beside it
 * showing the same query pinned to the worldwide top 25; the two are one page
 * now, and the podium it contributed applies to every scope.
 */
const Leaderboards = () => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    const [scope, setScope] = useState('world');
    const [pool, setPool] = useState('archon');
    const [page, setPage] = useState(0);

    // ARCHON (N4): which season's ladder to show. '' is the live one; a number
    // reads the archived final standings for a season that has ended. Seeded
    // from the query string so the Ratings page can link straight to a season.
    const [searchParams] = useSearchParams();
    const [season, setSeason] = useState(searchParams.get('season') || '');

    const { data: location } = useGetLocationQuery(undefined, { skip: !user });
    const { data: seasonData } = useGetSeasonsQuery();
    const seasons = useMemo(() => seasonData?.seasons || [], [seasonData]);
    const currentSeason = useMemo(() => seasons.find((entry) => entry.current), [seasons]);
    const pastSeasons = useMemo(() => seasons.filter((entry) => !entry.current), [seasons]);
    const viewingArchive = season !== '';

    const scopeParams =
        scope === 'region'
            ? { region: location?.region }
            : scope === 'country'
            ? { country: location?.country }
            : scope === 'state'
            ? { country: location?.country, state: location?.state }
            : {};

    const scopeReady =
        viewingArchive ||
        scope === 'world' ||
        (scope === 'region' && !!location?.region) ||
        (scope === 'country' && !!location?.country) ||
        (scope === 'state' && !!location?.country && !!location?.state);

    const { data: liveData, isFetching: liveFetching } = useGetLeaderboardQuery(
        // Over-fetch one row so we can tell whether a next page exists even
        // when the current page is exactly full (otherwise "Next" stays
        // enabled on a full final page and advances to an empty page).
        { pool, scope, limit: PAGE_SIZE + 1, offset: page * PAGE_SIZE, ...scopeParams },
        { skip: !scopeReady || viewingArchive }
    );

    // An archived season is a snapshot of a ladder that no longer exists, so it
    // has no geographic scopes - it is stored as the final worldwide standings.
    const { data: archiveData, isFetching: archiveFetching } = useGetSeasonStandingsQuery(
        { season, pool, limit: PAGE_SIZE + 1, offset: page * PAGE_SIZE },
        { skip: !viewingArchive }
    );

    const data = viewingArchive ? archiveData : liveData;
    const isFetching = viewingArchive ? archiveFetching : liveFetching;
    const rawEntries = data?.entries || [];
    const hasMore = rawEntries.length > PAGE_SIZE;
    const pageEntries = rawEntries.slice(0, PAGE_SIZE);

    // The podium stands in for the first three rows, and only on the first
    // page - on page two, rank 51 is not a medal position.
    const podiumEntries = page === 0 ? pageEntries.slice(0, 3) : [];
    const entries = page === 0 ? pageEntries.slice(3) : pageEntries;

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
                    {/* Archived standings are stored as one worldwide final
                        ladder, so the geographic scopes do not apply to them. */}
                    {!viewingArchive && (
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
                    )}
                    {/* ARCHON (N4): seasons existed in the engine but were
                        invisible; this is where a player finds the one they
                        are in and the ones that finished. */}
                    {seasons.length > 0 && (
                        <select
                            className='rounded-md border border-border/70 bg-surface px-2 py-1 text-sm text-foreground'
                            value={season}
                            aria-label={t('Season')}
                            onChange={(event) => {
                                setSeason(event.target.value);
                                setPage(0);
                            }}
                        >
                            <option value=''>
                                {currentSeason
                                    ? t('Season {{season}} (current)', {
                                          season: currentSeason.number
                                      })
                                    : t('Current')}
                            </option>
                            {pastSeasons.map((entry) => (
                                <option key={entry.number} value={entry.number}>
                                    {t('Season {{season}}', { season: entry.number })}
                                </option>
                            ))}
                        </select>
                    )}
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
                            {viewingArchive
                                ? t('Season {{season}} final standings', { season })
                                : scopeLabel}
                            {!viewingArchive && currentSeason?.number
                                ? ` · ${t('Season {{season}}', { season: currentSeason.number })}`
                                : ''}
                        </div>
                        <Podium entries={podiumEntries} />
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
                                                <PlayerName
                                                    className='hover:text-amber-300'
                                                    link
                                                    username={entry.username}
                                                />
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
                        {/* The whole page, not just the table: with three or
                            fewer players everybody is on the podium and the
                            table below it is legitimately empty. */}
                        {pageEntries.length === 0 && !isFetching && (
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
