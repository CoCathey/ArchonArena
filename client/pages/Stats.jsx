import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Input } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import { useGetMetaStatsQuery, useGetPlayerStatsQuery } from '../redux/api';

const pct = (value) => (value == null ? '—' : `${value.toFixed(1)}%`);

const formatDuration = (seconds) => {
    if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) {
        return '—';
    }

    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;

    if (h > 0) {
        return `${h}h ${m}m`;
    }

    return `${m}m ${s}s`;
};

const StatTile = ({ label, value, hint }) => (
    <div className='rounded-lg border border-border/60 bg-surface-secondary/50 px-4 py-3'>
        <div className='text-xs uppercase tracking-wide text-muted'>{label}</div>
        <div className='mt-1 text-2xl font-semibold text-foreground'>{value}</div>
        {hint ? <div className='mt-0.5 text-xs text-muted'>{hint}</div> : null}
    </div>
);

/**
 * Self-labelling horizontal magnitude bars: one accent hue, the entity named on
 * the left and its value on the right, so identity is never carried by colour
 * alone. `showMidline` draws a faint 50% reference for win-rate charts (a
 * two-player decided game always has one winner, so rates centre on even).
 */
const BarList = ({ items, max = 100, showMidline = false, emptyText }) => {
    if (!items || items.length === 0) {
        return <p className='text-sm text-muted'>{emptyText}</p>;
    }

    const scale = max || Math.max(1, ...items.map((item) => Number(item.value) || 0));

    return (
        <div className='space-y-2'>
            {items.map((item) => {
                const width =
                    item.value == null ? 0 : Math.max(0, Math.min(100, (item.value / scale) * 100));

                return (
                    <div key={item.label} className='flex items-center gap-3'>
                        <div
                            className='w-32 shrink-0 truncate text-sm text-foreground'
                            title={item.label}
                        >
                            {item.label}
                        </div>
                        <div className='relative h-5 flex-1 overflow-hidden rounded bg-surface-secondary/60'>
                            {showMidline ? (
                                <div className='absolute inset-y-0 left-1/2 z-10 w-px bg-border/80' />
                            ) : null}
                            <div
                                className='h-full rounded bg-amber-400/80'
                                style={{ width: `${width}%` }}
                            />
                        </div>
                        <div className='w-36 shrink-0 whitespace-nowrap text-right text-xs text-muted'>
                            <span className='font-semibold text-foreground'>{item.valueLabel}</span>
                            {item.sub ? <span className='ml-1'>{item.sub}</span> : null}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

const MetaStats = () => {
    const { t } = useTranslation();
    const { data, isFetching, isError } = useGetMetaStatsQuery();
    const stats = data?.stats;

    if (isFetching && !stats) {
        return (
            <Panel title={t('The Meta')}>
                <p className='text-sm text-muted'>{t('Loading platform statistics…')}</p>
            </Panel>
        );
    }

    if (isError || !stats) {
        return (
            <Panel title={t('The Meta')}>
                <p className='text-sm text-muted'>
                    {t('Platform statistics are not available right now.')}
                </p>
            </Panel>
        );
    }

    const totals = stats.totals || {};
    const hasGames = (totals.decidedGames || 0) > 0;

    const houseItems = (stats.houses || []).map((house) => ({
        label: t(house.house),
        value: house.winRate,
        valueLabel: pct(house.winRate),
        sub: t('({{count}} games)', { count: house.games })
    }));

    const formatMax = Math.max(1, ...(stats.formats || []).map((format) => format.share || 0));
    const formatItems = (stats.formats || []).map((format) => ({
        label: t(format.format),
        value: format.share,
        valueLabel: pct(format.share),
        sub: t('({{count}} games)', { count: format.games })
    }));

    const sasItems = (stats.sasBands || []).map((band) => ({
        label: band.band,
        value: band.winRate,
        valueLabel: pct(band.winRate),
        sub: t('({{count}} games)', { count: band.games })
    }));

    return (
        <div className='space-y-4'>
            <Panel title={t('The Meta')}>
                <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
                    <StatTile
                        label={t('Games Played')}
                        value={(totals.finishedGames || 0).toLocaleString()}
                    />
                    <StatTile
                        label={t('Decided Games')}
                        value={(totals.decidedGames || 0).toLocaleString()}
                        hint={t('with a winner')}
                    />
                    <StatTile
                        label={t('Avg Game Length')}
                        value={formatDuration(totals.avgDurationSec)}
                    />
                    <StatTile
                        label={t('Avg Keys Forged')}
                        value={totals.avgKeys == null ? '—' : totals.avgKeys.toFixed(2)}
                        hint={t('per player')}
                    />
                </div>
                {!hasGames ? (
                    <p className='mt-3 text-sm text-muted'>
                        {t(
                            'No decided games have been recorded yet. Meta charts appear once games are played.'
                        )}{' '}
                        <Link href='/play' className='text-amber-300 underline'>
                            {t('Play Online')}
                        </Link>
                    </p>
                ) : null}
            </Panel>

            {hasGames ? (
                <>
                    <Panel title={t('Win Rate by House')}>
                        <p className='mb-3 text-xs text-muted'>
                            {t(
                                'Share of games won by decks containing each house. The line marks an even 50%.'
                            )}
                        </p>
                        <BarList
                            items={houseItems}
                            showMidline
                            emptyText={t('Not enough house data yet.')}
                        />
                    </Panel>

                    <Panel title={t('Win Rate by Deck Power (SAS)')}>
                        <p className='mb-3 text-xs text-muted'>
                            {t('How often decks in each SAS band win. The line marks an even 50%.')}
                        </p>
                        <BarList
                            items={sasItems}
                            showMidline
                            emptyText={t('No rated decks have finished a game yet.')}
                        />
                    </Panel>

                    <Panel title={t('Format Popularity')}>
                        <p className='mb-3 text-xs text-muted'>
                            {t('Share of finished games played in each format.')}
                        </p>
                        <BarList
                            items={formatItems}
                            max={formatMax}
                            emptyText={t('No games recorded yet.')}
                        />
                    </Panel>
                </>
            ) : null}
        </div>
    );
};

MetaStats.displayName = 'MetaStats';

const PlayerStats = () => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    const [query, setQuery] = useState('');
    const [lookup, setLookup] = useState(user?.username || '');

    const target = lookup || user?.username || '';
    const { data, isFetching, isError, error } = useGetPlayerStatsQuery(target, {
        skip: !target
    });
    const stats = data?.stats;
    const notFound = isError && error?.status === 404;

    const submit = (event) => {
        event.preventDefault();
        const trimmed = query.trim();

        if (trimmed) {
            setLookup(trimmed);
        }
    };

    const overall = stats?.overall;

    const houseItems = (stats?.houses || []).map((house) => ({
        label: t(house.house),
        value: house.winRate,
        valueLabel: pct(house.winRate),
        sub: t('({{wins}}-{{losses}})', { wins: house.wins, losses: house.games - house.wins })
    }));

    const formatItems = (stats?.formats || []).map((format) => ({
        label: t(format.format),
        value: format.winRate,
        valueLabel: pct(format.winRate),
        sub: t('({{wins}}-{{losses}})', { wins: format.wins, losses: format.losses })
    }));

    return (
        <div className='space-y-4'>
            <Panel title={t('Player Stats')}>
                <form className='mb-3 flex flex-wrap items-center gap-2' onSubmit={submit}>
                    <Input
                        size='sm'
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t('Look up a player by name')}
                        className='max-w-xs'
                        aria-label={t('Player name')}
                    />
                    <HeroButton size='sm' type='submit' variant='secondary'>
                        {t('Search')}
                    </HeroButton>
                    {target ? (
                        <span className='text-sm text-muted'>
                            {t('Showing')}{' '}
                            <span className='font-semibold text-foreground'>{target}</span>
                        </span>
                    ) : null}
                </form>

                {!target ? (
                    <p className='text-sm text-muted'>
                        {t('Log in or search for a player to see their stats.')}
                    </p>
                ) : isFetching && !stats ? (
                    <p className='text-sm text-muted'>{t('Loading…')}</p>
                ) : notFound ? (
                    <p className='text-sm text-muted'>
                        {t('No player named "{{name}}" was found.', { name: target })}
                    </p>
                ) : !overall ? (
                    <p className='text-sm text-muted'>
                        {t('Player statistics are not available right now.')}
                    </p>
                ) : overall.games === 0 ? (
                    <p className='text-sm text-muted'>
                        {t('{{name}} has not finished any decided games yet.', {
                            name: stats.username
                        })}
                    </p>
                ) : (
                    <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
                        <StatTile
                            label={t('Record')}
                            value={`${overall.wins}-${overall.losses}`}
                            hint={t('{{count}} games', { count: overall.games })}
                        />
                        <StatTile label={t('Win Rate')} value={pct(overall.winRate)} />
                        <StatTile
                            label={t('Avg Keys')}
                            value={overall.avgKeys == null ? '—' : overall.avgKeys.toFixed(2)}
                            hint={t('per game')}
                        />
                        <StatTile
                            label={t('Avg Game Length')}
                            value={formatDuration(overall.avgDurationSec)}
                        />
                    </div>
                )}
            </Panel>

            {overall && overall.games > 0 ? (
                <>
                    <Panel title={t('Win Rate by Format')}>
                        <BarList items={formatItems} emptyText={t('No format data yet.')} />
                    </Panel>

                    <Panel title={t('Win Rate by House')}>
                        <BarList
                            items={houseItems}
                            showMidline
                            emptyText={t('No house data yet.')}
                        />
                    </Panel>
                </>
            ) : null}
        </div>
    );
};

PlayerStats.displayName = 'PlayerStats';

/**
 * ARCHON: statistics & analytics. A public meta dashboard (house / SAS win
 * rates, format popularity, headline totals) plus per-player breakdowns,
 * replacing the old Stats placeholder.
 */
const Stats = () => {
    const { t } = useTranslation();
    const [tab, setTab] = useState('meta');

    return (
        <div className='mx-auto w-full max-w-4xl space-y-4'>
            <div className='flex gap-2'>
                <HeroButton
                    size='sm'
                    variant={tab === 'meta' ? 'primary' : 'tertiary'}
                    onPress={() => setTab('meta')}
                >
                    {t('The Meta')}
                </HeroButton>
                <HeroButton
                    size='sm'
                    variant={tab === 'player' ? 'primary' : 'tertiary'}
                    onPress={() => setTab('player')}
                >
                    {t('Player Stats')}
                </HeroButton>
            </div>

            {tab === 'meta' ? <MetaStats /> : <PlayerStats />}
        </div>
    );
};

Stats.displayName = 'Stats';

export default Stats;
