import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Input } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import Ratings from './Ratings';
import { useGetDeckStatsQuery, useGetMetaStatsQuery, useGetPlayerStatsQuery } from '../redux/api';

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

/**
 * ARCHON (N3): the house-vs-house matchup matrix.
 *
 * Read as "the row house, when facing the column house". Every game feeds nine
 * cells, because each deck brings three houses — so a cell counts games in
 * which a deck containing that house met a deck containing the other, which is
 * what a KeyForge matchup table means.
 *
 * Cells with too few games behind them are blank rather than coloured: a 100%
 * win rate off two games reads as a finding and is noise.
 */
const MatchupMatrix = ({ matchups }) => {
    const { t } = useTranslation();
    const houses = matchups?.houses || [];
    const cells = matchups?.cells || {};

    if (houses.length === 0) {
        return null;
    }

    const cellClass = (winRate) => {
        if (winRate == null) {
            return 'text-muted';
        }

        if (winRate >= 55) {
            return 'bg-emerald-500/20 text-emerald-200';
        }

        if (winRate <= 45) {
            return 'bg-rose-500/20 text-rose-200';
        }

        return 'text-foreground';
    };

    return (
        <Panel title={t('House Matchups')}>
            <p className='mb-3 text-xs text-muted'>
                {t(
                    'How often a deck containing the row house beats a deck containing the column house. Matchups with fewer than {{min}} games are left blank.',
                    { min: matchups.minGames }
                )}
            </p>
            <div className='overflow-x-auto'>
                <table className='w-full border-collapse text-sm'>
                    <thead>
                        <tr className='text-xs uppercase tracking-wide text-muted'>
                            <th className='px-2 py-1 text-left'>{t('vs')}</th>
                            {houses.map((house) => (
                                <th key={house} className='px-2 py-1 text-center'>
                                    {t(house)}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {houses.map((house) => (
                            <tr key={house} className='border-b border-border/40'>
                                <td className='whitespace-nowrap px-2 py-1.5 text-foreground'>
                                    {t(house)}
                                </td>
                                {houses.map((opponent) => {
                                    const cell = cells[`${house}|${opponent}`];

                                    return (
                                        <td
                                            key={opponent}
                                            className={`px-2 py-1.5 text-center ${cellClass(
                                                cell?.winRate
                                            )}`}
                                            title={
                                                cell
                                                    ? t('{{games}} games', { games: cell.games })
                                                    : undefined
                                            }
                                        >
                                            {cell?.winRate == null ? '—' : `${cell.winRate}%`}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </Panel>
    );
};

MatchupMatrix.displayName = 'MatchupMatrix';

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

    // ARCHON (N3): win rate per expansion.
    const setItems = (stats.sets || []).map((entry) => ({
        label: entry.set,
        value: entry.winRate,
        detail: t('{{games}} games', { games: entry.games })
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

                    <Panel title={t('Win Rate by Set')}>
                        <p className='mb-3 text-xs text-muted'>
                            {t(
                                'Share of games won by decks from each expansion, newest set first. The line marks an even 50%.'
                            )}
                        </p>
                        <BarList
                            items={setItems}
                            showMidline
                            emptyText={t('No sets have finished a game yet.')}
                        />
                    </Panel>

                    <MatchupMatrix matchups={stats.houseMatchups} />

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
 * ARCHON: how each of your decks actually performs, next to what its SAS
 * predicted. SAS says how strong a deck is on paper; the delta says whether it
 * wins for you — a deck well above its band is one you pilot well, and one well
 * below it is worth reconsidering however high it scores.
 */
const DeckStats = () => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    const { data, isFetching } = useGetDeckStatsQuery(user?.username, { skip: !user });
    const stats = data?.stats;
    const decks = stats?.decks || [];

    if (!user) {
        return (
            <Panel title={t('Your Decks')}>
                <p className='text-sm text-muted'>{t('Log in to see how your decks perform.')}</p>
            </Panel>
        );
    }

    if (isFetching) {
        return <div className='py-8 text-center text-muted'>{t('Loading…')}</div>;
    }

    if (decks.length === 0) {
        return (
            <Panel title={t('Your Decks')}>
                <p className='text-sm text-muted'>
                    {t('No finished games yet. Play a few and your decks will show up here.')}
                </p>
            </Panel>
        );
    }

    // ARCHON (N3): the callouts. Ranked by how far a deck beats what its SAS
    // band predicts, not by raw win rate - see StatisticsService.deckCallouts
    // for why that is the more useful question.
    const callouts = [
        stats?.bestDeck && {
            key: 'best',
            label: t('Your best deck'),
            deck: stats.bestDeck,
            tone: 'text-emerald-300'
        },
        stats?.worstDeck && {
            key: 'worst',
            label: t('Your weakest result'),
            deck: stats.worstDeck,
            tone: 'text-rose-300'
        }
    ].filter(Boolean);

    const matchupItems = (stats?.matchups || [])
        .filter((entry) => entry.winRate != null)
        .map((entry) => ({
            label: entry.opponentHouse,
            value: entry.winRate,
            detail: t('{{games}} games', { games: entry.games })
        }));

    return (
        <div className='space-y-4'>
            {callouts.length > 0 && (
                <Panel title={t('Highlights')}>
                    <div className='grid gap-3 sm:grid-cols-2'>
                        {callouts.map((callout) => (
                            <div
                                key={callout.key}
                                className='rounded-md border border-border/55 bg-surface-secondary/35 px-3 py-2'
                            >
                                <div className='text-xs uppercase tracking-wide text-muted'>
                                    {callout.label}
                                </div>
                                <div className='truncate text-sm font-semibold text-foreground'>
                                    {callout.deck.name}
                                </div>
                                <div className='text-xs text-muted'>
                                    {t('{{wins}}-{{losses}} · {{rate}}% win rate', {
                                        wins: callout.deck.wins,
                                        losses: callout.deck.losses,
                                        rate: callout.deck.winRate
                                    })}
                                    {callout.deck.sasDelta != null && (
                                        <span className={`ml-1 font-semibold ${callout.tone}`}>
                                            {callout.deck.sasDelta > 0 ? '+' : ''}
                                            {callout.deck.sasDelta} {t('vs its SAS band')}
                                        </span>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                    <p className='mt-2 text-xs text-muted'>
                        {t(
                            'Ranked by how far each deck beats what decks of its power actually win here, so a modest deck you pilot well outranks a strong deck with ordinary results. Decks with fewer than {{min}} games are not considered.',
                            { min: stats?.calloutMinGames ?? 5 }
                        )}
                    </p>
                </Panel>
            )}

            {stats?.bestMatchup && stats?.worstMatchup && (
                <Panel title={t('Your Matchups')}>
                    <p className='mb-3 text-xs text-muted'>
                        {t(
                            'How you do against decks containing each house. Best: {{best}}. Hardest: {{worst}}.',
                            {
                                best: stats.bestMatchup.opponentHouse,
                                worst: stats.worstMatchup.opponentHouse
                            }
                        )}
                    </p>
                    <BarList
                        items={matchupItems}
                        showMidline
                        emptyText={t('Not enough games against any house yet.')}
                    />
                </Panel>
            )}

            <Panel title={t('Your Decks')}>
                <p className='mb-3 text-xs text-muted'>
                    {t(
                        'Delta compares each deck to what decks of its SAS band actually win here. Positive means it beats its paper strength.'
                    )}
                </p>
                <div className='overflow-x-auto'>
                    <table className='w-full text-sm'>
                        <thead>
                            <tr className='text-left text-xs uppercase tracking-wide text-muted'>
                                <th className='px-2 py-1'>{t('Deck')}</th>
                                <th className='px-2 py-1 text-center'>{t('SAS')}</th>
                                <th className='px-2 py-1 text-center'>{t('W-L')}</th>
                                <th className='px-2 py-1 text-center'>{t('Win %')}</th>
                                <th className='px-2 py-1 text-center'>{t('Delta')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {decks.map((deck) => (
                                <tr key={deck.deckId} className='border-b border-border/40'>
                                    <td className='max-w-0 truncate px-2 py-1.5 text-foreground'>
                                        {deck.name}
                                    </td>
                                    <td className='px-2 py-1.5 text-center text-muted'>
                                        {deck.sasRating ?? '-'}
                                    </td>
                                    <td className='px-2 py-1.5 text-center text-muted'>
                                        {deck.wins}-{deck.losses}
                                    </td>
                                    <td className='px-2 py-1.5 text-center font-semibold text-foreground'>
                                        {deck.winRate}%
                                    </td>
                                    <td
                                        className={`px-2 py-1.5 text-center font-semibold ${
                                            deck.sasDelta == null
                                                ? 'text-muted'
                                                : deck.sasDelta > 0
                                                ? 'text-emerald-300'
                                                : deck.sasDelta < 0
                                                ? 'text-rose-300'
                                                : 'text-muted'
                                        }`}
                                    >
                                        {deck.sasDelta == null
                                            ? '-'
                                            : `${deck.sasDelta > 0 ? '+' : ''}${deck.sasDelta}`}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </Panel>
        </div>
    );
};

DeckStats.displayName = 'DeckStats';

/**
 * ARCHON: statistics & analytics. A public meta dashboard (house / SAS win
 * rates, format popularity, headline totals) plus per-player breakdowns,
 * replacing the old Stats placeholder.
 *
 * Your own numbers come first. A player opening Stats is nearly always asking
 * "how am I doing?", and that used to be a separate page reached through a
 * flyout - so the section is one page now, and it opens on you. The meta and
 * the per-deck breakdowns are a click away on the same page rather than
 * somewhere else in the tree.
 *
 * Signed out there is no "me" to show, so the tab is not offered and the meta
 * leads instead.
 */
const Stats = () => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);

    // Signed in, both /stats and /stats/me open here - which is what makes the
    // old bookmark still land on what it named.
    const [tab, setTab] = useState(user ? 'me' : 'meta');

    const tabs = [
        user && { key: 'me', label: t('My Stats') },
        { key: 'meta', label: t('The Meta') },
        { key: 'player', label: t('Player Stats') },
        { key: 'decks', label: t('Your Decks') }
    ].filter(Boolean);

    // A signed-out visitor can never select 'me', but a player who signs out
    // while sitting on it can end up holding it.
    const active = tab === 'me' && !user ? 'meta' : tab;

    return (
        <div className='mx-auto w-full max-w-4xl space-y-4'>
            <div className='flex flex-wrap gap-2'>
                {tabs.map((entry) => (
                    <HeroButton
                        key={entry.key}
                        size='sm'
                        variant={active === entry.key ? 'primary' : 'tertiary'}
                        onPress={() => setTab(entry.key)}
                    >
                        {entry.label}
                    </HeroButton>
                ))}
            </div>

            {active === 'me' ? (
                <Ratings embedded />
            ) : active === 'meta' ? (
                <MetaStats />
            ) : active === 'decks' ? (
                <DeckStats />
            ) : (
                <PlayerStats />
            )}
        </div>
    );
};

Stats.displayName = 'Stats';

export default Stats;
