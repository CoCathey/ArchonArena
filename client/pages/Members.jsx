import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Input } from '@heroui/react';
import moment from 'moment';

import Panel from '../Components/Site/Panel';
import PlayerName from '../Components/Site/PlayerName';
import AmberValue from '../Components/Site/AmberValue';
import { COUNTRIES, countryName } from '../geo';
import { useGetMembersQuery } from '../redux/api';

const PAGE_SIZE = 25;

const selectClass =
    'rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none dark:border-border/80 dark:bg-surface-secondary/85';

/**
 * ARCHON: member directory (Phase 9), chess.com-style: stat tiles +
 * searchable member list. Online count comes from lobby presence.
 */
const Members = () => {
    const { t } = useTranslation();
    const onlineUsers = useSelector((state) => state.lobby.users);
    const [query, setQuery] = useState('');
    const [country, setCountry] = useState('');
    const [page, setPage] = useState(0);

    const { data, isFetching } = useGetMembersQuery({
        query: query || undefined,
        country: country || undefined,
        // Over-fetch one row to detect a next page even on an exactly-full
        // page (otherwise "Next" advances to an empty page).
        limit: PAGE_SIZE + 1,
        offset: page * PAGE_SIZE
    });

    const rawMembers = data?.members || [];
    const hasMore = rawMembers.length > PAGE_SIZE;
    const members = rawMembers.slice(0, PAGE_SIZE);
    const stats = data?.stats;

    const tiles = [
        { value: (onlineUsers || []).length, label: t('Online') },
        { value: stats?.joined24h ?? '-', label: t('Joined in the past 24 hours') },
        { value: stats?.total ?? '-', label: t('Members') }
    ];

    return (
        <div className='mx-auto w-full max-w-4xl space-y-4'>
            <div className='grid gap-3 sm:grid-cols-3'>
                {tiles.map((tile) => (
                    <div
                        key={tile.label}
                        className='rounded-lg border border-border/70 bg-surface-secondary/60 px-4 py-3'
                    >
                        <div className='text-2xl font-extrabold text-foreground'>
                            {typeof tile.value === 'number'
                                ? tile.value.toLocaleString()
                                : tile.value}
                        </div>
                        <div className='text-xs text-muted'>{tile.label}</div>
                    </div>
                ))}
            </div>

            <Panel title={t('Search Members')}>
                <form
                    className='mb-3 flex flex-wrap gap-2'
                    onSubmit={(event) => {
                        event.preventDefault();
                        setPage(0);
                    }}
                >
                    <Input
                        className='min-w-40 flex-1'
                        placeholder={t('Search by username')}
                        value={query}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            setPage(0);
                        }}
                    />
                    <select
                        className={selectClass}
                        value={country}
                        onChange={(event) => {
                            setCountry(event.target.value);
                            setPage(0);
                        }}
                    >
                        <option value=''>{t('All Countries')}</option>
                        {COUNTRIES.map(([code, name]) => (
                            <option key={code} value={code}>
                                {name}
                            </option>
                        ))}
                    </select>
                </form>

                <div className='overflow-x-auto'>
                    <table className='w-full text-sm'>
                        <thead>
                            <tr className='border-b border-border/70 text-left text-xs uppercase tracking-wide text-muted'>
                                <th className='px-2 py-2'>{t('Player')}</th>
                                <th className='px-2 py-2'>{t('Location')}</th>
                                <th className='px-2 py-2 text-right'>{t('Amber')}</th>
                                <th className='px-2 py-2 text-right'>{t('Joined')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {members.map((member) => (
                                <tr key={member.username} className='border-b border-border/40'>
                                    <td className='px-2 py-2 font-semibold text-foreground'>
                                        <PlayerName
                                            className='hover:text-amber-300'
                                            link
                                            username={member.username}
                                        />
                                    </td>
                                    <td className='px-2 py-2 text-muted'>
                                        {[
                                            member.state,
                                            member.country && countryName(member.country)
                                        ]
                                            .filter(Boolean)
                                            .join(', ')}
                                    </td>
                                    <td className='px-2 py-2 text-right'>
                                        {member.rating != null ? (
                                            <AmberValue value={member.rating} />
                                        ) : (
                                            <span className='text-muted'>—</span>
                                        )}
                                    </td>
                                    <td className='px-2 py-2 text-right text-muted'>
                                        {moment(member.joined).format('MMM YYYY')}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {members.length === 0 && !isFetching && (
                    <div className='py-6 text-center text-sm text-muted'>
                        {t('No members match your search')}
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
            </Panel>
        </div>
    );
};

Members.displayName = 'Members';

export default Members;
