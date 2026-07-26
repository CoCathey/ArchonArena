import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import AmberValue from '../Components/Site/AmberValue';
import Avatar from '../Components/Site/Avatar';
import { countryName } from '../geo';
import { useGetLeaderboardQuery } from '../redux/api';

const TOP_COUNT = 25;

/**
 * ARCHON: Top Players (Phase 6) - the best players worldwide by Amber, with
 * a podium for the top three. Leaderboards is the scoped explorer
 * (region/country/state); this is the "hall of fame" at a glance.
 */
const TopPlayers = () => {
    const { t } = useTranslation();
    const currentUser = useSelector((state) => state.account.user);
    const [pool, setPool] = useState('archon');

    const { data, isFetching } = useGetLeaderboardQuery({
        pool,
        scope: 'world',
        limit: TOP_COUNT,
        offset: 0
    });

    const entries = data?.entries || [];
    const podium = entries.slice(0, 3);
    const rest = entries.slice(3);

    const pools = [
        ['archon', t('Archon')],
        ['sealed', t('Sealed')],
        ['alliance', t('Alliance')]
    ];

    // Podium display order: 2nd, 1st, 3rd (center is tallest).
    const podiumOrder = [podium[1], podium[0], podium[2]];
    const podiumStyles = [
        { medal: '🥈', ring: 'ring-slate-300/70', pad: 'sm:mt-6' },
        { medal: '🥇', ring: 'ring-amber-400/80', pad: '' },
        { medal: '🥉', ring: 'ring-orange-400/70', pad: 'sm:mt-10' }
    ];

    const locationOf = (entry) =>
        [entry.state, entry.country && countryName(entry.country)].filter(Boolean).join(', ');

    return (
        <div className='mx-auto w-full max-w-4xl'>
            <Panel title={t('Top Players')}>
                <p className='mb-3 text-sm text-muted'>
                    {t('The highest-rated Archon Arena players worldwide, ranked by Amber.')}
                </p>

                <div className='mb-4 flex gap-1'>
                    {pools.map(([key, label]) => (
                        <HeroButton
                            key={key}
                            size='sm'
                            variant={pool === key ? 'primary' : 'tertiary'}
                            onPress={() => setPool(key)}
                        >
                            {label}
                        </HeroButton>
                    ))}
                </div>

                {podium.length > 0 && (
                    <div className='mb-6 grid grid-cols-3 gap-2 sm:gap-4'>
                        {podiumOrder.map((entry, index) =>
                            entry ? (
                                <div
                                    key={entry.username}
                                    className={`flex flex-col items-center rounded-lg border border-border/60 bg-surface-secondary/50 px-2 py-4 text-center ${podiumStyles[index].pad}`}
                                >
                                    <div className='text-2xl'>{podiumStyles[index].medal}</div>
                                    <div
                                        className={`mt-1 rounded-full ring-2 ${podiumStyles[index].ring}`}
                                    >
                                        <Avatar imgPath={entry.avatar} />
                                    </div>
                                    <div className='mt-2 truncate text-sm font-bold text-foreground'>
                                        <Link
                                            href={`/players/${encodeURIComponent(entry.username)}`}
                                            className='hover:text-amber-300 hover:underline'
                                        >
                                            {entry.username}
                                        </Link>
                                    </div>
                                    {locationOf(entry) && (
                                        <div className='truncate text-xs text-muted'>
                                            {locationOf(entry)}
                                        </div>
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
                )}

                {rest.length > 0 && (
                    <div className='overflow-x-auto'>
                        <table className='w-full text-sm'>
                            <tbody>
                                {rest.map((entry) => (
                                    <tr
                                        key={entry.username}
                                        className={`border-b border-border/40 ${
                                            entry.username === currentUser?.username
                                                ? 'bg-accent/15'
                                                : ''
                                        }`}
                                    >
                                        <td className='w-10 px-2 py-2 font-semibold text-muted'>
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
                                            {locationOf(entry)}
                                        </td>
                                        <td className='px-2 py-2 text-right'>
                                            <AmberValue value={entry.rating} />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {entries.length === 0 && !isFetching && (
                    <div className='py-6 text-center text-sm text-muted'>
                        {t('No ranked players yet. Play rated games to claim the top spot!')}
                    </div>
                )}
            </Panel>
        </div>
    );
};

TopPlayers.displayName = 'TopPlayers';

export default TopPlayers;
