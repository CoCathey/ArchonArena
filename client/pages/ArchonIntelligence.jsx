import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import AlertPanel from '../Components/Site/AlertPanel';
import PremiumLock from '../Components/Membership/PremiumLock';
import SetFilter from '../Components/Site/SetFilter';
import { CAPABILITIES, hasCapability } from '../membership';
import { deriveFindings } from '../archonFindings';
import {
    useGetAercIntelligenceQuery,
    useGetDeckComparisonQuery,
    useGetDeckIntelligenceQuery,
    useGetPlayerIntelligenceQuery,
    useGetMetaIntelligenceQuery,
    useGetReplayIntelligenceQuery
} from '../redux/api';

/**
 * ARCHON (N12): Archon Intelligence.
 *
 * Three questions, in order, and the page is laid out as that argument:
 *
 *   Deck Intelligence   - is this actually a good deck?
 *   Player Intelligence - am I actually good with it?
 *   Meta Intelligence   - how does it fare against what people are playing?
 *
 * A locked visitor sees the real structure with sample-shaped content blurred
 * behind it, so the page sells itself. Nothing here invents a number: every
 * metric the server could not compute arrives as `available: false` with a
 * reason, and is rendered as "not recorded yet" rather than as a zero.
 *
 * ## The set filter reaches the whole page
 *
 * One control at the top, and everything below it re-reads for those sets -
 * because a house win rate, a deck ranking and a "vs expectation" all mean
 * something different inside one set than averaged over twenty of them.
 *
 * Two tables deliberately ignore it: "your record by set" and "what the field
 * is playing, by set". Those are the tables the filter is chosen FROM. Filtering
 * them to the current selection would collapse each to a single row and destroy
 * the comparison that makes the filter worth setting.
 */

const pct = (value) =>
    value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
const num = (value, digits = 1) =>
    value === null || value === undefined ? '—' : Number(value).toFixed(digits);
const signed = (value, digits = 0) =>
    value === null || value === undefined
        ? '—'
        : `${value >= 0 ? '+' : ''}${Number(value).toFixed(digits)}`;

/**
 * The decks to offer in a picker, most-played first.
 *
 * The rankings arrive sorted by win rate, which is right for a table you read
 * top-down and wrong for a list you choose from: taking the first twelve of a
 * win-rate sort offers a player their twelve luckiest decks and opens the
 * panel on whichever one they happened to win with once. What somebody wants
 * to inspect is the deck they actually play, so the picker re-sorts on games
 * and leaves the table's own order alone.
 */
const PICKER_LIMIT = 12;
const mostPlayed = (decks) =>
    [...decks].sort((a, b) => (b.games || 0) - (a.games || 0)).slice(0, PICKER_LIMIT);
const duration = (seconds) => {
    if (!seconds && seconds !== 0) {
        return '—';
    }

    const mins = Math.round(seconds / 60);

    return `${mins} min`;
};

/** A single headline number. */
const Stat = ({ label, value, hint, tone }) => (
    <div className='rounded border border-border/70 bg-surface-secondary/60 px-3 py-2'>
        <div className='text-[11px] uppercase tracking-wide text-muted'>{label}</div>
        <div
            className={[
                'text-lg font-semibold',
                tone === 'good'
                    ? 'text-emerald-300'
                    : tone === 'bad'
                    ? 'text-red-300'
                    : 'text-foreground'
            ].join(' ')}
        >
            {value}
        </div>
        {hint && <div className='text-[11px] text-muted'>{hint}</div>}
    </div>
);

Stat.propTypes = {
    hint: PropTypes.node,
    label: PropTypes.node,
    tone: PropTypes.string,
    value: PropTypes.node
};

/** Horizontal bar for a house row. */
const HouseBar = ({ row, t }) => (
    <div className='flex items-center gap-2 text-xs'>
        <div className='w-28 shrink-0 truncate text-foreground'>{row.houseName || row.house}</div>
        <div className='h-2 flex-1 overflow-hidden rounded bg-surface-secondary'>
            <div
                className={row.winRate >= 0.5 ? 'h-full bg-emerald-500/70' : 'h-full bg-red-500/70'}
                style={{ width: `${Math.round((row.winRate ?? 0) * 100)}%` }}
            />
        </div>
        <div className='w-10 shrink-0 text-right text-foreground'>{pct(row.winRate)}</div>
        <div className='w-16 shrink-0 text-right text-muted'>
            {t('{{count}}g', { count: row.games })}
        </div>
    </div>
);

HouseBar.propTypes = { row: PropTypes.object, t: PropTypes.func };

/**
 * A set row: name, win rate, and how much of the sample it is.
 *
 * The share bar is drawn at true scale, unlike the house one - a deck has three
 * houses but exactly one set, so these really do sum to 100% and can be read as
 * proportions of the whole.
 */
const SetRow = ({ row, t, showShare = true }) => (
    <div className='flex items-center gap-2 text-xs'>
        <div className='w-32 shrink-0 truncate text-foreground' title={row.set?.name}>
            {row.set?.name || row.set?.code || '—'}
        </div>
        <div className='h-2 flex-1 overflow-hidden rounded bg-surface-secondary'>
            <div
                className={row.winRate >= 0.5 ? 'h-full bg-emerald-500/70' : 'h-full bg-red-500/70'}
                style={{ width: `${Math.round((row.winRate ?? 0) * 100)}%` }}
            />
        </div>
        <div className='w-10 shrink-0 text-right text-foreground'>{pct(row.winRate)}</div>
        <div className='w-14 shrink-0 text-right text-muted'>
            {t('{{count}}g', { count: row.games })}
        </div>
        {showShare && (
            <div className='w-12 shrink-0 text-right text-muted' title={t('share of games')}>
                {pct(row.share)}
            </div>
        )}
    </div>
);

SetRow.propTypes = { row: PropTypes.object, showShare: PropTypes.bool, t: PropTypes.func };

/**
 * ARCHON: the AERC view.
 *
 * SAS answers "is this deck strong", which a player can already see. AERC is
 * what that number is made of, and answers the question they actually have:
 * which KIND of deck suits them, and which kind beats them.
 *
 * The bands are cut at the site-wide quartiles of each trait, so "high creature
 * control" means the same thing for everyone. The range each band covers is
 * printed under its name rather than left to the label, because "High" on its
 * own is a word, not a number.
 */
const bandRange = (band, t) => {
    if (band.from === null && band.to === null) {
        return '';
    }

    if (band.from === null) {
        return t('under {{to}}', { to: num(band.to) });
    }

    if (band.to === null) {
        return t('{{from}}+', { from: num(band.from) });
    }

    return `${num(band.from)}–${num(band.to)}`;
};

/** One trait's four bands, as a row of cells. */
const BandStrip = ({ bands, t }) => (
    <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
        {bands.map((band) => (
            <div
                className={[
                    'rounded border px-3 py-2',
                    band.games === 0
                        ? 'border-border/40 bg-surface-secondary/30'
                        : band.confident
                        ? 'border-border/70 bg-surface-secondary/60'
                        : 'border-amber-500/40 bg-amber-500/5'
                ].join(' ')}
                key={band.band}
            >
                <div className='text-[11px] uppercase tracking-wide text-muted'>
                    {t(band.band)}{' '}
                    <span className='normal-case text-muted/70'>{bandRange(band, t)}</span>
                </div>
                <div
                    className={[
                        'text-lg font-semibold',
                        band.games === 0
                            ? 'text-muted'
                            : band.winRate >= 0.5
                            ? 'text-emerald-300'
                            : 'text-red-300'
                    ].join(' ')}
                >
                    {band.games === 0 ? '—' : pct(band.winRate)}
                </div>
                <div className='text-[11px] text-muted'>
                    {band.games === 0
                        ? t('no games')
                        : t('{{wins}}–{{losses}} in {{games}}', {
                              games: band.games,
                              losses: band.losses,
                              wins: band.wins
                          })}
                </div>
                {band.games > 0 && !band.confident && (
                    <div className='text-[11px] text-amber-300'>{t('too few to lean on')}</div>
                )}
            </div>
        ))}
    </div>
);

BandStrip.propTypes = { bands: PropTypes.array, t: PropTypes.func };

/**
 * The headline findings, as sentences.
 *
 * Nine traits times four bands times two sides is a lot of numbers, and the two
 * that matter are not the ones a reader will happen to look at. The server
 * ranks them by the gap between two bands that BOTH clear the sample
 * threshold - which is what stops the headline being a 100% record over two
 * games.
 */
const Findings = ({ findings, t }) => (
    <div className='space-y-1.5'>
        {findings.map((finding, index) => (
            <div
                className='rounded border border-border/70 bg-surface-secondary/50 px-3 py-2 text-sm'
                key={index}
            >
                {finding.side === 'opponent'
                    ? t(
                          'Against {{label}} you win {{best}} in the {{bestBand}} band and {{worst}} in the {{worstBand}} band.',
                          {
                              best: pct(finding.best.winRate),
                              bestBand: t(finding.best.band).toLowerCase(),
                              label: finding.label,
                              worst: pct(finding.worst.winRate),
                              worstBand: t(finding.worst.band).toLowerCase()
                          }
                      )
                    : t(
                          'With your own {{label}} you win {{best}} in the {{bestBand}} band and {{worst}} in the {{worstBand}} band.',
                          {
                              best: pct(finding.best.winRate),
                              bestBand: t(finding.best.band).toLowerCase(),
                              label: finding.label,
                              worst: pct(finding.worst.winRate),
                              worstBand: t(finding.worst.band).toLowerCase()
                          }
                      )}{' '}
                <span className='text-muted'>
                    {t('({{games}} games)', { games: finding.games })}
                </span>
            </div>
        ))}
    </div>
);

Findings.propTypes = { findings: PropTypes.array, t: PropTypes.func };

/** Blurred sample used behind the lock, so the page demonstrates its own value. */
const SamplePanel = () => (
    <div className='space-y-2 p-3'>
        <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
            {[
                ['Win rate', '61%'],
                ['vs expected', '+4.2'],
                ['Avg keys at end', '2.4'],
                ['Avg length', '18 min']
            ].map(([label, value]) => (
                <Stat key={label} label={label} value={value} />
            ))}
        </div>
        <div className='space-y-1.5'>
            {[0.68, 0.61, 0.55, 0.43, 0.38].map((winRate, index) => (
                <HouseBar
                    key={index}
                    row={{ houseName: '————', winRate, games: 20 - index }}
                    t={(s, o) => `${o?.count ?? ''}g`}
                />
            ))}
        </div>
    </div>
);

/**
 * ARCHON (N12): the Elo history a Supporter is sold.
 *
 * The endpoint has always returned this; nothing rendered it, so "Full Elo
 * history" was a promise with no surface. Inline SVG rather than a charting
 * dependency - it is one polyline over a series the server already shaped
 * oldest-first.
 */
const EloHistory = ({ history, t }) => {
    if (!history || !history.length) {
        return (
            <div className='p-3 text-sm text-muted'>
                {t('No rated games yet — your rating history appears here once you play.')}
            </div>
        );
    }

    const ratings = history.map((entry) => entry.ratingAfter);
    const min = Math.min(...ratings);
    const max = Math.max(...ratings);
    // A flat series would divide by zero and collapse the line onto an edge.
    const span = max - min || 1;
    const width = 600;
    const height = 120;

    const points = history
        .map((entry, index) => {
            const x = history.length === 1 ? width / 2 : (index / (history.length - 1)) * width;
            const y = height - ((entry.ratingAfter - min) / span) * height;

            return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');

    const first = history[0];
    const last = history[history.length - 1];
    const net = last.ratingAfter - first.ratingBefore;

    return (
        <div className='space-y-2 p-1'>
            <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
                <Stat label={t('Current')} value={last.ratingAfter} />
                <Stat
                    label={t('Net change')}
                    tone={net >= 0 ? 'good' : 'bad'}
                    value={`${net >= 0 ? '+' : ''}${net}`}
                />
                <Stat label={t('Peak')} value={max} />
                <Stat label={t('Rated games')} value={history.length} />
            </div>

            <div className='overflow-x-auto'>
                <svg
                    className='w-full'
                    height={height}
                    preserveAspectRatio='none'
                    role='img'
                    aria-label={t('Rating over time')}
                    viewBox={`0 0 ${width} ${height}`}
                >
                    <polyline
                        fill='none'
                        points={points}
                        stroke='currentColor'
                        strokeWidth='2'
                        className='text-accent'
                    />
                </svg>
            </div>

            <div className='overflow-x-auto'>
                <table className='w-full min-w-[420px] text-xs'>
                    <thead>
                        <tr className='border-b border-border/70 text-left text-muted'>
                            <th className='py-1 pr-2 font-medium'>{t('Date')}</th>
                            <th className='py-1 pr-2 font-medium'>{t('Opponent')}</th>
                            <th className='py-1 pr-2 text-right font-medium'>{t('Result')}</th>
                            <th className='py-1 pr-2 text-right font-medium'>{t('Change')}</th>
                            <th className='py-1 pr-2 text-right font-medium'>{t('Rating')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {[...history]
                            .reverse()
                            .slice(0, 25)
                            .map((entry, index) => (
                                <tr className='border-b border-border/40' key={index}>
                                    <td className='py-1 pr-2 text-muted'>
                                        {new Date(entry.at).toLocaleDateString()}
                                    </td>
                                    <td className='py-1 pr-2 text-foreground'>
                                        {entry.opponent || '—'}
                                    </td>
                                    <td
                                        className={`py-1 pr-2 text-right ${
                                            entry.won ? 'text-emerald-300' : 'text-red-300'
                                        }`}
                                    >
                                        {entry.won ? t('Win') : t('Loss')}
                                    </td>
                                    <td
                                        className={`py-1 pr-2 text-right ${
                                            entry.change >= 0 ? 'text-emerald-300' : 'text-red-300'
                                        }`}
                                    >
                                        {entry.change >= 0 ? '+' : ''}
                                        {entry.change}
                                    </td>
                                    <td className='py-1 pr-2 text-right text-foreground'>
                                        {entry.ratingAfter}
                                    </td>
                                </tr>
                            ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

EloHistory.propTypes = { history: PropTypes.array, t: PropTypes.func };

/**
 * ARCHON (N12): "Is this deck good?" - the first of the three questions.
 *
 * The endpoint has been built, gated and tested since Archon Intelligence
 * shipped, and nothing called it, so the headline promise of the tier was two
 * thirds true. This is its surface: pick one of your decks and see its record,
 * what it does against each opposing house, and how the rating moved while you
 * played it.
 *
 * The deck list is the rankings the page already loads, so choosing a deck
 * costs one request rather than two.
 */
const DeckIntelligence = ({ decks, t }) => {
    const [deckId, setDeckId] = useState(null);
    const offered = mostPlayed(decks);
    // Opens on the deck with the most games behind it rather than the one at
    // the top of a win-rate sort, which could be a single lucky game.
    const selected = deckId || (offered.length ? offered[0].deckId : null);

    const { data, isFetching } = useGetDeckIntelligenceQuery(selected, { skip: !selected });

    if (!decks.length) {
        return (
            <div className='p-3 text-sm text-muted'>
                {t('Play a few games with a deck and its breakdown appears here.')}
            </div>
        );
    }

    const mine = data?.mine;
    const everyone = data?.everyone;

    return (
        <div className='space-y-3 p-1'>
            <div className='flex flex-wrap gap-1.5'>
                {offered.map((deck) => (
                    <button
                        className={[
                            'rounded-full border px-2.5 py-1 text-xs transition',
                            deck.deckId === selected
                                ? 'border-amber-500/60 bg-amber-500/15 text-amber-200'
                                : 'border-border/70 bg-surface-secondary/60 text-foreground hover:border-border'
                        ].join(' ')}
                        key={deck.deckId}
                        onClick={() => setDeckId(deck.deckId)}
                        type='button'
                    >
                        {deck.deckName}
                        <span className='ml-1.5 text-muted'>{deck.games}g</span>
                    </button>
                ))}
            </div>

            {isFetching && <div className='text-sm text-muted'>{t('Loading…')}</div>}

            {mine?.overview?.available && (
                <>
                    <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
                        <Stat
                            label={t('Your record')}
                            value={`${mine.overview.wins}–${mine.overview.losses}`}
                            hint={pct(mine.overview.winRate)}
                        />
                        <Stat
                            label={t('Avg keys at end')}
                            value={num(mine.overview.avgKeysAtEnd)}
                            hint={t('caps at 3 for online games')}
                        />
                        <Stat label={t('Avg length')} value={duration(mine.overview.avgSeconds)} />
                        <Stat
                            label={t('Rating swing')}
                            tone={(mine.rating?.netSwing ?? 0) >= 0 ? 'good' : 'bad'}
                            value={
                                mine.rating?.available
                                    ? `${mine.rating.netSwing >= 0 ? '+' : ''}${
                                          mine.rating.netSwing
                                      }`
                                    : '—'
                            }
                        />
                    </div>

                    {/* "Is this a good deck" is answered by everybody's
                        record, not just yours - so when there is no wider
                        record the panel says that rather than quietly
                        rendering nothing and leaving the question hanging. */}
                    {everyone?.available && (
                        <p className='m-0 text-xs text-muted'>
                            {everyone.games > mine.overview.games
                                ? t(
                                      'Across every player who has used this deck: {{wins}}–{{losses}} ({{rate}}).',
                                      {
                                          wins: everyone.wins,
                                          losses: everyone.losses,
                                          rate: pct(everyone.winRate)
                                      }
                                  )
                                : t(
                                      'Nobody else has played this deck here, so its record is entirely your own.'
                                  )}
                        </p>
                    )}

                    {mine.byOpposingHouse?.available && (
                        <div className='space-y-1.5'>
                            <div className='text-[11px] uppercase tracking-wide text-muted'>
                                {t('Against decks containing')}
                            </div>
                            {mine.byOpposingHouse.rows.map((row) => (
                                <HouseBar key={row.house} row={row} t={t} />
                            ))}
                        </div>
                    )}

                    {/* The per-deck question the set dimension actually
                        answers. The server has computed this on every deck
                        request since Deck Intelligence shipped and nothing
                        rendered it, so the query was being paid for and
                        thrown away. A deck that is 70% into the older sets
                        and 40% into the newest is telling its owner exactly
                        what to bring. */}
                    {mine.byOpposingSet?.available && mine.byOpposingSet.rows.length > 1 && (
                        <div className='space-y-1.5'>
                            <div className='text-[11px] uppercase tracking-wide text-muted'>
                                {t('Against decks from')}
                            </div>
                            {mine.byOpposingSet.rows.map((row) => (
                                <SetRow key={row.set?.id} row={row} showShare={false} t={t} />
                            ))}
                            <p className='m-0 text-[11px] text-muted'>
                                {t(
                                    'A deck has exactly one set, so unlike the house table above ' +
                                        'these rows add up to this deck’s real game count.'
                                )}
                            </p>
                        </div>
                    )}

                    {/* Turn order was a single grey line, which is a waste of
                        a first/second split the engine records per game. The
                        gap is the number worth reading, so it is the one shown
                        largest. */}
                    {mine.byTurnOrder?.available ? (
                        <div className='space-y-1'>
                            <div className='text-[11px] uppercase tracking-wide text-muted'>
                                {t('Turn order')}
                            </div>
                            <div className='grid grid-cols-3 gap-2'>
                                <Stat
                                    label={t('Going first')}
                                    value={pct(mine.byTurnOrder.first.winRate)}
                                    hint={t('{{count}} games', {
                                        count: mine.byTurnOrder.first.games
                                    })}
                                />
                                <Stat
                                    label={t('Going second')}
                                    value={pct(mine.byTurnOrder.second.winRate)}
                                    hint={t('{{count}} games', {
                                        count: mine.byTurnOrder.second.games
                                    })}
                                />
                                <Stat
                                    label={t('Difference')}
                                    tone={mine.byTurnOrder.edge >= 0 ? 'good' : 'bad'}
                                    value={
                                        mine.byTurnOrder.edge === null
                                            ? '—'
                                            : `${mine.byTurnOrder.edge >= 0 ? '+' : ''}${pct(
                                                  mine.byTurnOrder.edge
                                              )}`
                                    }
                                    hint={t('first minus second')}
                                />
                            </div>
                            {mine.byTurnOrder.gamesWithoutData > 0 && (
                                <p className='m-0 text-[11px] text-muted'>
                                    {t(
                                        '{{count}} older games are left out: turn order was not ' +
                                            'recorded before it was added to the engine.',
                                        { count: mine.byTurnOrder.gamesWithoutData }
                                    )}
                                </p>
                            )}
                        </div>
                    ) : (
                        <div className='text-xs text-muted'>{mine.byTurnOrder?.reason}</div>
                    )}
                </>
            )}

            {mine && !mine.overview?.available && !isFetching && (
                <div className='text-sm text-muted'>
                    {t('No finished games with this deck yet.')}
                </div>
            )}
        </div>
    );
};

DeckIntelligence.propTypes = { decks: PropTypes.array, t: PropTypes.func };

/** Up to this many decks side by side - the same limit the Deep Probe uses. */
const MAX_COMPARED = 4;

/**
 * ARCHON: Deck comparison - the `deck_comparison` promise, delivered on the
 * page whose questions it answers.
 *
 * Pick two to four of your decks and read them as columns: record, rating
 * movement, keys, length, turn order, and how each fares against every house
 * you have met with it. Everything is your own games. The single-deck panel
 * above is where one deck's full breakdown lives; the Deep Probe is this
 * comparison scoped to an event's sets.
 *
 * Like the Deep Probe, it refuses to recommend. What it adds instead is the
 * confidence marker: two records can only be weighed against each other by
 * someone who knows which of them to believe, so a thin sample is named
 * rather than ranked as if it were a forty-game record.
 */
const DeckComparison = ({ decks, t }) => {
    const [selected, setSelected] = useState([]);

    // The picker is the page's (set-filtered) rankings, so narrowing the
    // filter can strand a selection. Filtering at use rather than in state
    // means a stranded deck is never quietly compared - and comes back on its
    // own if the filter widens again before the picker is next touched.
    const offered = mostPlayed(decks);
    const active = selected.filter((deckId) => offered.some((deck) => deck.deckId === deckId));

    const { data, isFetching } = useGetDeckComparisonQuery(active, { skip: active.length < 2 });

    // Writes the pruned list back, so the cap always counts real chips.
    const toggle = (deckId) =>
        setSelected(
            active.includes(deckId)
                ? active.filter((id) => id !== deckId)
                : active.length >= MAX_COMPARED
                ? active
                : [...active, deckId]
        );

    if (!decks.length) {
        return (
            <div className='p-3 text-sm text-muted'>
                {t('Play a few games with two of your decks and you can compare them here.')}
            </div>
        );
    }

    const compared = active.length >= 2 ? data?.decks || [] : [];

    // The union of every opposing house any compared deck has met, widest
    // sample first - the rows of the matchup half of the table.
    const houseTotals = new Map();

    for (const deck of compared) {
        for (const row of deck.byOpposingHouse?.rows || []) {
            const entry = houseTotals.get(row.house) || {
                house: row.house,
                houseName: row.houseName,
                games: 0
            };

            entry.games += row.games;
            houseTotals.set(row.house, entry);
        }
    }

    const houses = [...houseTotals.values()].sort((a, b) => b.games - a.games);

    /** One matchup cell: the record where there is one, coloured only when
        there is enough of it to mean something. */
    const matchupCell = (deck, house) => {
        const row = (deck.byOpposingHouse?.rows || []).find(
            (candidate) => candidate.house === house.house
        );

        if (!row) {
            return <span className='text-muted'>—</span>;
        }

        return (
            <span
                className={
                    row.games < 3
                        ? 'text-muted'
                        : row.winRate >= 0.5
                        ? 'text-emerald-300'
                        : 'text-red-300'
                }
            >
                {pct(row.winRate)} <span className='text-muted'>({row.games}g)</span>
            </span>
        );
    };

    const thin = compared.filter((deck) => !deck.confident);

    const metricRows = [
        {
            label: t('Games'),
            render: (deck) => <span className='text-muted'>{deck.overview?.games ?? 0}</span>
        },
        {
            label: t('Record'),
            render: (deck) =>
                deck.overview?.available ? `${deck.overview.wins}–${deck.overview.losses}` : '—'
        },
        {
            label: t('Win rate'),
            render: (deck) => <span className='font-semibold'>{pct(deck.overview?.winRate)}</span>
        },
        {
            label: t('Rating swing'),
            render: (deck) => (
                <span
                    className={
                        deck.rating?.available
                            ? deck.rating.netSwing >= 0
                                ? 'text-emerald-300'
                                : 'text-red-300'
                            : 'text-muted'
                    }
                >
                    {deck.rating?.available ? signed(deck.rating.netSwing) : '—'}
                </span>
            )
        },
        {
            label: t('vs expected'),
            render: (deck) => (
                <span
                    className={
                        deck.rating?.available && deck.rating.vsExpectation !== null
                            ? deck.rating.vsExpectation >= 0
                                ? 'text-emerald-300'
                                : 'text-red-300'
                            : 'text-muted'
                    }
                >
                    {deck.rating?.available && deck.rating.vsExpectation !== null
                        ? signed(deck.rating.vsExpectation, 1)
                        : '—'}
                </span>
            )
        },
        {
            label: t('SAS'),
            render: (deck) => <span className='text-muted'>{deck.sas ?? '—'}</span>
        },
        { label: t('Avg keys at end'), render: (deck) => num(deck.overview?.avgKeysAtEnd) },
        { label: t('Avg length'), render: (deck) => duration(deck.overview?.avgSeconds) },
        {
            label: t('Going first'),
            render: (deck) =>
                deck.byTurnOrder?.available ? pct(deck.byTurnOrder.first.winRate) : '—'
        },
        {
            label: t('Going second'),
            render: (deck) =>
                deck.byTurnOrder?.available ? pct(deck.byTurnOrder.second.winRate) : '—'
        }
    ];

    return (
        <div className='space-y-3 p-1'>
            <div className='flex flex-wrap gap-1.5'>
                {offered.map((deck) => {
                    const isOn = active.includes(deck.deckId);
                    const atLimit = !isOn && active.length >= MAX_COMPARED;

                    return (
                        <button
                            className={[
                                'rounded-full border px-2.5 py-1 text-xs transition',
                                isOn
                                    ? 'border-amber-500/60 bg-amber-500/15 text-amber-200'
                                    : 'border-border/70 bg-surface-secondary/60 text-foreground hover:border-border',
                                atLimit ? 'cursor-not-allowed opacity-40' : ''
                            ].join(' ')}
                            disabled={atLimit}
                            key={deck.deckId}
                            onClick={() => toggle(deck.deckId)}
                            type='button'
                        >
                            {deck.deckName}
                            <span className='ml-1.5 text-muted'>{deck.games}g</span>
                        </button>
                    );
                })}
            </div>

            {isFetching && <div className='text-sm text-muted'>{t('Comparing…')}</div>}

            {active.length < 2 && (
                <div className='rounded border border-dashed border-border/70 p-4 text-center text-sm text-muted'>
                    {t('Pick at least two decks to put them side by side — up to {{max}}.', {
                        max: MAX_COMPARED
                    })}
                </div>
            )}

            {compared.length >= 2 && (
                <>
                    <div className='overflow-x-auto'>
                        <table className='w-full min-w-[480px] text-sm'>
                            <thead>
                                <tr className='border-b border-border/70 text-left'>
                                    <th className='py-1.5 pr-2 font-medium text-muted'> </th>
                                    {compared.map((deck) => (
                                        <th
                                            className='py-1.5 pr-2 font-semibold text-foreground'
                                            key={deck.deckId}
                                        >
                                            <div className='truncate' title={deck.deckName}>
                                                {deck.deckName}
                                            </div>
                                            <div
                                                className='text-[11px] font-normal text-muted'
                                                title={deck.set?.name}
                                            >
                                                {deck.set?.code || '—'}
                                            </div>
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {metricRows.map((metric) => (
                                    <tr className='border-b border-border/40' key={metric.label}>
                                        <td className='py-1.5 pr-2 text-xs uppercase tracking-wide text-muted'>
                                            {metric.label}
                                        </td>
                                        {compared.map((deck) => (
                                            <td
                                                className='py-1.5 pr-2 text-foreground'
                                                key={deck.deckId}
                                            >
                                                {metric.render(deck)}
                                            </td>
                                        ))}
                                    </tr>
                                ))}

                                {houses.length > 0 && (
                                    <tr>
                                        <td
                                            className='pb-1 pt-3 text-[11px] uppercase tracking-wide text-muted'
                                            colSpan={compared.length + 1}
                                        >
                                            {t('Against decks containing')}
                                        </td>
                                    </tr>
                                )}
                                {houses.map((house) => (
                                    <tr className='border-b border-border/40' key={house.house}>
                                        <td className='py-1.5 pr-2 text-xs text-foreground'>
                                            {house.houseName || house.house}
                                        </td>
                                        {compared.map((deck) => (
                                            <td className='py-1.5 pr-2' key={deck.deckId}>
                                                {matchupCell(deck, house)}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {thin.length > 0 && (
                        <div className='rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300'>
                            {t(
                                '{{decks}}: under {{min}} games — a record this thin is shown, not ranked. {{min}}+ is a usable sample.',
                                {
                                    decks: thin.map((deck) => deck.deckName).join(', '),
                                    min: data?.minConfidentGames ?? 10
                                }
                            )}
                        </div>
                    )}

                    <p className='m-0 text-[11px] text-muted'>
                        {t(
                            'Your own games only, across each deck’s whole record. Matchup cells are ' +
                                'coloured only from 3 games; a house a deck has never met shows a dash. ' +
                                'Picking a deck for a specific event is the Deep Probe’s job — it scopes ' +
                                'this same comparison to the sets an event allows.'
                        )}
                    </p>
                </>
            )}
        </div>
    );
};

DeckComparison.propTypes = { decks: PropTypes.array, t: PropTypes.func };

/**
 * ARCHON (N12): Replay Intelligence.
 *
 * The one panel on this page whose numbers come from recorded games rather than
 * from a column, and the only place on the site that can answer which house a
 * player actually calls. Every other house figure here is measured across decks
 * CONTAINING a house, because which house was called on a turn is recorded
 * nowhere else - the caveat under "your record by house" says exactly that, and
 * this is the panel that lifts it.
 */
const ReplayIntelligence = ({ insights, t }) => {
    if (!insights) {
        return <div className='p-3 text-sm text-muted'>{t('Loading…')}</div>;
    }

    if (!insights.available) {
        return (
            <div className='p-3 text-sm text-muted'>
                {insights.reason ||
                    t('No recorded games yet — finish one and it is analysed here.')}
            </div>
        );
    }

    return (
        <div className='space-y-3 p-1'>
            <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
                <Stat
                    label={t('Games analysed')}
                    value={insights.games}
                    hint={t('{{wins}} won', { wins: insights.wins })}
                />
                <Stat
                    label={t('Amber per turn')}
                    value={num(insights.amberPerTurn)}
                    hint={t('turns that gained any')}
                />
                <Stat
                    label={t('First key')}
                    value={num(insights.firstKeyRound)}
                    hint={t('average turn')}
                />
                <Stat
                    label={t('Game length')}
                    value={num(insights.turnsPerGame)}
                    hint={t('your turns')}
                />
            </div>

            <div>
                <div className='mb-1 text-xs uppercase tracking-wide text-muted'>
                    {t('Houses you call, and how you do when you call them')}
                </div>
                <div className='space-y-1.5'>
                    {insights.byHouse.map((row) => (
                        <div className='flex items-center gap-2 text-xs' key={row.house}>
                            <div className='w-28 shrink-0 truncate text-foreground'>
                                {t(row.house)}
                            </div>
                            <div className='h-2 flex-1 overflow-hidden rounded bg-surface-secondary'>
                                <div
                                    className={
                                        row.winRate >= 0.5
                                            ? 'h-full bg-emerald-500/70'
                                            : 'h-full bg-red-500/70'
                                    }
                                    style={{ width: `${Math.round((row.winRate ?? 0) * 100)}%` }}
                                />
                            </div>
                            <div className='w-10 shrink-0 text-right text-foreground'>
                                {pct(row.winRate)}
                            </div>
                            <div
                                className='w-20 shrink-0 text-right text-muted'
                                title={t('turns called')}
                            >
                                {t('{{count}} turns', { count: row.turns })}
                            </div>
                            <div
                                className='w-12 shrink-0 text-right text-muted'
                                title={t('share of your turns')}
                            >
                                {pct(row.share)}
                            </div>
                        </div>
                    ))}
                </div>
                <p className='m-0 pt-1 text-[11px] text-muted'>
                    {t(
                        'Counted per turn, from recorded board states — this is the house you ' +
                            'actually called, not the houses your deck contains. The win rate is ' +
                            'over the games in which you called it at least once.'
                    )}
                </p>
            </div>

            {insights.vsHouse.length > 0 && (
                <div>
                    <div className='mb-1 text-xs uppercase tracking-wide text-muted'>
                        {t('What the other side called')}
                    </div>
                    <div className='flex flex-wrap gap-1.5 text-xs'>
                        {insights.vsHouse.map((row) => (
                            <span
                                className='rounded bg-surface-secondary/60 px-1.5 py-0.5'
                                key={row.house}
                            >
                                <span className='text-foreground'>{t(row.house)}</span>{' '}
                                <span className='text-muted'>
                                    {pct(row.winRate)} ({row.games})
                                </span>
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {insights.skipped > 0 && (
                <p className='m-0 text-[11px] text-muted'>
                    {t(
                        '{{count}} of your recorded games are from before board states were ' +
                            'captured and could not be read.',
                        { count: insights.skipped }
                    )}
                </p>
            )}
        </div>
    );
};

ReplayIntelligence.propTypes = { insights: PropTypes.object, t: PropTypes.func };

/**
 * ARCHON (N12): a panel whose contents arrived through the preview programme.
 *
 * Labelled, always, and with the stage said out loud. A beta panel that looks
 * identical to a finished one is how a work in progress gets read as a promise -
 * and the whole reason the tier can honestly sell "beta features" is that the
 * player knows which ones they are and can switch them off.
 */
const PreviewPanel = ({ title, stage, children, t }) => (
    <Panel
        type='default'
        compactHeader
        title={
            <span className='inline-flex items-center gap-2'>
                {title}
                <span className='rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300'>
                    {stage}
                </span>
            </span>
        }
    >
        {children}
        <p className='m-0 mt-2 text-[11px] text-muted'>
            {t('A preview. Turn it off in Profile → Previews.')}
        </p>
    </Panel>
);

PreviewPanel.propTypes = {
    children: PropTypes.node,
    stage: PropTypes.node,
    t: PropTypes.func,
    title: PropTypes.node
};

/** The performance dashboard with a time axis - preview `performance-trend`. */
const PerformanceTrend = ({ trend, t }) => {
    if (!trend?.available) {
        return (
            <div className='p-3 text-sm text-muted'>
                {trend?.reason || t('No rated games in this window yet.')}
            </div>
        );
    }

    // The widest bar in the set defines the scale, so a player with a handful of
    // games gets a readable chart rather than five invisible slivers.
    const peak = Math.max(...trend.points.map((point) => Math.abs(point.vsExpectation || 0)), 1);

    return (
        <div className='space-y-1.5'>
            {trend.points.map((point) => {
                const value = point.vsExpectation || 0;
                const ahead = value >= 0;

                return (
                    <div className='flex items-center gap-2 text-xs' key={point.month}>
                        <span className='w-20 shrink-0 text-muted'>
                            {new Date(point.month).toLocaleDateString(undefined, {
                                month: 'short',
                                year: '2-digit'
                            })}
                        </span>
                        {/* A centre line, so above and below expectation read as
                            opposite directions rather than as two lengths. */}
                        <span className='relative h-3 flex-1 rounded bg-surface-secondary/60'>
                            <span
                                className={`absolute top-0 h-3 ${
                                    ahead ? 'left-1/2 bg-emerald-500/70' : 'bg-red-500/70'
                                }`}
                                style={
                                    ahead
                                        ? { width: `${(Math.abs(value) / peak) * 50}%` }
                                        : {
                                              right: '50%',
                                              width: `${(Math.abs(value) / peak) * 50}%`
                                          }
                                }
                            />
                        </span>
                        <span
                            className={`w-16 shrink-0 text-right ${
                                ahead ? 'text-emerald-300' : 'text-red-300'
                            }`}
                        >
                            {ahead ? '+' : ''}
                            {num(value)}
                        </span>
                        <span className='w-14 shrink-0 text-right text-muted'>
                            {t('{{count}}g', { count: point.games })}
                        </span>
                    </div>
                );
            })}
            <p className='m-0 text-xs text-muted'>
                {t(
                    'Wins above or below what your rating predicted, by month. Months with no ' +
                        'rated games are left out rather than drawn as zero.'
                )}
            </p>
        </div>
    );
};

PerformanceTrend.propTypes = { t: PropTypes.func, trend: PropTypes.object };

/** Recent results and streaks - preview `form-and-streaks`. */
const FormAndStreaks = ({ form, t }) => {
    if (!form?.available) {
        return (
            <div className='p-3 text-sm text-muted'>{form?.reason || t('No rated games yet.')}</div>
        );
    }

    return (
        <div className='space-y-3'>
            <div className='flex flex-wrap gap-1'>
                {form.recent.map((result, index) => (
                    <span
                        className={`flex h-6 w-6 items-center justify-center rounded text-[11px] font-semibold ${
                            result.won
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : 'bg-red-500/20 text-red-300'
                        }`}
                        key={index}
                        title={new Date(result.at).toLocaleString()}
                    >
                        {result.won ? t('W') : t('L')}
                    </span>
                ))}
            </div>
            <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
                <Stat
                    label={t('Last {{count}}', { count: form.games })}
                    value={`${form.wins}-${form.losses}`}
                />
                <Stat label={t('Win rate')} value={pct(form.winRate)} />
                <Stat
                    label={t('Current streak')}
                    tone={form.currentStreak.kind === 'win' ? 'good' : 'bad'}
                    value={`${form.currentStreak.length}${
                        form.currentStreak.kind === 'win' ? t('W') : t('L')
                    }`}
                />
                <Stat label={t('Best win streak')} value={form.bestWinStreak} />
            </div>
            <p className='m-0 text-xs text-muted'>
                {form.streakWindowTruncated
                    ? t('Streaks measured over your last {{count}} rated games.', {
                          count: form.streakWindow
                      })
                    : t('Streaks measured over all {{count}} of your rated games.', {
                          count: form.streakWindow
                      })}
            </p>
        </div>
    );
};

FormAndStreaks.propTypes = { form: PropTypes.object, t: PropTypes.func };

/** Going first vs going second - preview `turn-order-insights`. */
const TurnOrder = ({ turnOrder, t }) => {
    if (!turnOrder?.available) {
        return (
            <div className='p-3 text-sm text-muted'>
                {turnOrder?.reason || t('Turn order is not recorded for these games.')}
            </div>
        );
    }

    return (
        <div className='space-y-2'>
            <div className='grid grid-cols-2 gap-2 sm:grid-cols-3'>
                <Stat
                    label={t('Going first')}
                    value={pct(turnOrder.first.winRate)}
                    hint={t('{{count}} games', { count: turnOrder.first.games })}
                />
                <Stat
                    label={t('Going second')}
                    value={pct(turnOrder.second.winRate)}
                    hint={t('{{count}} games', { count: turnOrder.second.games })}
                />
                <Stat
                    label={t('Difference')}
                    tone={turnOrder.edge >= 0 ? 'good' : 'bad'}
                    value={
                        turnOrder.edge === null
                            ? '—'
                            : `${turnOrder.edge >= 0 ? '+' : ''}${pct(turnOrder.edge)}`
                    }
                    hint={t('first minus second')}
                />
            </div>
            {turnOrder.gamesWithoutData > 0 && (
                <p className='m-0 text-xs text-muted'>
                    {t(
                        '{{count}} older games are left out: turn order was not recorded before it ' +
                            'was added to the engine.',
                        { count: turnOrder.gamesWithoutData }
                    )}
                </p>
            )}
        </div>
    );
};

TurnOrder.propTypes = { t: PropTypes.func, turnOrder: PropTypes.object };

/**
 * ARCHON: "What stands out" - the answer before the evidence.
 *
 * Fifteen panels is a lot to hand someone with no statement about which of
 * them matters. This is the same move the AERC lens already made with its
 * findings, applied to the page as a whole and to the payload it has already
 * fetched: no extra request, no number the panels below would disagree with,
 * and nothing that rests on a sample too thin to mean anything (see
 * archonFindings.js for the rules).
 *
 * It renders nothing at all when there is not enough record to say something
 * true. An empty panel is a better outcome than a confident sentence about
 * four games.
 */
const WhatStandsOut = ({ player, t }) => {
    const findings = deriveFindings(player);

    if (!findings.length) {
        return null;
    }

    const sentence = (finding) => {
        const v = finding.values;

        switch (finding.kind) {
            case 'aheadOfRating':
                return t(
                    'You are {{gap}} wins ahead of what your rating predicted, across {{games}} rated games — {{actual}} actual against {{expected}} expected.',
                    {
                        actual: pct(v.winRate),
                        expected: pct(v.expectedWinRate),
                        games: v.games,
                        gap: num(v.gap)
                    }
                );
            case 'behindRating':
                return t(
                    'You are {{gap}} wins behind what your rating predicted, across {{games}} rated games — {{actual}} actual against {{expected}} expected.',
                    {
                        actual: pct(v.winRate),
                        expected: pct(v.expectedWinRate),
                        games: v.games,
                        gap: num(v.gap)
                    }
                );
            case 'houseSpread':
                return t(
                    'Decks containing {{worstHouse}} are your hardest matchup at {{worstRate}} over {{worstGames}} games; against {{bestHouse}} you win {{bestRate}} over {{bestGames}}.',
                    {
                        bestGames: v.bestGames,
                        bestHouse: v.bestHouse,
                        bestRate: pct(v.bestRate),
                        worstGames: v.worstGames,
                        worstHouse: v.worstHouse,
                        worstRate: pct(v.worstRate)
                    }
                );
            case 'strongerFirst':
                return t(
                    'Going first is worth {{edge}} to you: {{first}} on the play against {{second}} on the draw.',
                    {
                        edge: pct(v.edge),
                        first: pct(v.firstRate),
                        second: pct(v.secondRate)
                    }
                );
            case 'strongerSecond':
                return t(
                    'You do better going second: {{second}} on the draw against {{first}} on the play, a gap of {{edge}}.',
                    {
                        edge: pct(v.edge),
                        first: pct(v.firstRate),
                        second: pct(v.secondRate)
                    }
                );
            case 'formUp':
                return t(
                    'You are on an upswing — {{recent}} across your last {{games}} games, against {{lifetime}} lifetime.',
                    {
                        games: v.recentGames,
                        lifetime: pct(v.lifetimeRate),
                        recent: pct(v.recentRate)
                    }
                );
            case 'formDown':
                return t(
                    'Your recent form is below your record — {{recent}} across your last {{games}} games, against {{lifetime}} lifetime.',
                    {
                        games: v.recentGames,
                        lifetime: pct(v.lifetimeRate),
                        recent: pct(v.recentRate)
                    }
                );
            case 'bestDeck':
                return t(
                    '{{deck}} is your strongest deck with a real sample behind it: {{rate}} over {{games}} games.',
                    {
                        deck: v.deckName,
                        games: v.games,
                        rate: pct(v.winRate)
                    }
                );
            default:
                return null;
        }
    };

    return (
        <div className='space-y-1.5 p-1'>
            {findings.map((finding) => (
                <div
                    className='rounded border border-border/70 bg-surface-secondary/50 px-3 py-2 text-sm'
                    key={finding.id}
                >
                    {sentence(finding)}
                </div>
            ))}
            <p className='m-0 pt-1 text-[11px] text-muted'>
                {t(
                    'Ranked by the size of the effect, counting only figures with enough games ' +
                        'behind them to mean something. These are records, not causes — who you ' +
                        'happened to play rides along with any of them.'
                )}
            </p>
        </div>
    );
};

WhatStandsOut.propTypes = { player: PropTypes.object, t: PropTypes.func };

const ArchonIntelligence = () => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    // The payload is gated per section server-side, so fetch it whenever the
    // account can see any of them. Gating this on ARCHON_INTELLIGENCE meant a
    // Supporter never even asked for the Elo history they had paid for.
    const playerSections = [
        CAPABILITIES.ELO_HISTORY,
        CAPABILITIES.PERFORMANCE_DASHBOARD,
        CAPABILITIES.PERSONAL_DECK_RANKINGS,
        CAPABILITIES.MATCHUP_ANALYTICS
    ];
    // ARCHON (N12): the preview capabilities count too. A tier that reached the
    // programme but none of the tier sections would otherwise never request the
    // payload, and its preview panels would silently never appear.
    const unlocked = [
        ...playerSections,
        CAPABILITIES.EXPERIMENTAL_FEATURES,
        CAPABILITIES.BETA_FEATURES,
        CAPABILITIES.EARLY_ACCESS
    ].some((capability) => hasCapability(user, capability));
    const canMeta = hasCapability(user, CAPABILITIES.META_ANALYTICS);
    const canReplays = hasCapability(user, CAPABILITIES.ADVANCED_REPLAYS);
    const canAerc = hasCapability(user, CAPABILITIES.AERC_ANALYTICS);
    // Empty means every set, which is what both the control and the server
    // already take it to mean.
    const [sets, setSets] = useState([]);
    // SAS is the default view because it is the number every player already
    // knows. AERC is the deeper read, and switching is one click rather than a
    // different page - the whole value is in comparing the two.
    const [lens, setLens] = useState('sas');
    const [trait, setTrait] = useState('amberControl');

    // Skipped entirely when locked: a 403 round trip per panel teaches nobody
    // anything, and the locked state is rendered from the catalogue copy.
    const { data: player, isLoading } = useGetPlayerIntelligenceQuery(sets, {
        skip: !user || !unlocked
    });
    const { data: meta } = useGetMetaIntelligenceQuery(
        { days: 30, sets },
        { skip: !user || !canMeta }
    );
    // Not set-filtered: a recording carries the game, not the deck row the set
    // filter is built from, and reading 25 JSON documents per filter change is
    // not a cost worth paying for a narrowing this panel cannot honour.
    const { data: replays } = useGetReplayIntelligenceQuery(25, {
        skip: !user || !canReplays
    });
    // Only fetched when the AERC lens is actually showing: it is the most
    // expensive query on the page and nobody is reading it in SAS mode.
    const { data: aerc, isFetching: aercLoading } = useGetAercIntelligenceQuery(
        { days: 30, sets, trait },
        { skip: !user || !canAerc || lens !== 'aerc' }
    );

    if (!user) {
        return (
            <div className='mx-auto max-w-5xl p-3'>
                <AlertPanel
                    type='info'
                    message={t(
                        'Archon Intelligence analyses your own games. Sign in to see yours, or read what it covers on the membership page.'
                    )}
                />
                <div className='mt-3'>
                    <Link className='text-sm text-accent hover:underline' to='/membership'>
                        {t('See what Archon Intelligence covers')}
                    </Link>
                </div>
            </div>
        );
    }

    const vs = player?.vsExpectation;
    const rankings = player?.rankings || [];
    // Which sections came through the preview programme. Named by the server so
    // the page never has to guess whether a missing section is locked, empty, or
    // simply not switched on.
    const previews = player?.previews || [];
    // Derived from the payload already in hand - no request, and empty when
    // there is not enough record to say anything that would survive scrutiny.
    const findings = deriveFindings(player);
    /**
     * Whether the server served a given player section, for the panels whose
     * entitlement it reports.
     *
     * The payload has always carried `locked` and the page has always ignored
     * it, re-deciding client-side from the capability list in the JWT. That
     * list is minted at sign-in, so between a membership changing and the
     * token refreshing the two disagree - and the disagreement runs the wrong
     * way: the endpoint returns the data and the page blurs it. Undefined
     * until the payload arrives, which leaves PremiumLock on its own
     * judgement rather than flashing a lock over a section that is about to
     * load.
     */
    const served = (section) => (player?.locked ? !player.locked.includes(section) : undefined);
    const filtered = sets.length > 0;
    // Said once, under the filter, rather than repeated on every panel.
    const scopeNote = filtered
        ? t('Everything below counts only games played with decks from the selected sets.')
        : t('Everything below counts every set. Choose one or more to narrow it.');

    return (
        <div className='mx-auto max-w-6xl space-y-3 p-3'>
            <Panel type='default' compactHeader title={t('Archon Intelligence')}>
                <p className='m-0 text-sm text-muted'>
                    {t(
                        'Three questions: is the deck good, are you good with it, and how does it hold ' +
                            'up against what people are actually playing?'
                    )}
                </p>
            </Panel>

            <Panel type='default' compactHeader title={t('Set')}>
                <SetFilter hint={scopeNote} selected={sets} t={t} onChange={setSets} />
            </Panel>

            {/* ---- What stands out --------------------------------------
                Above everything, because it is the answer and the rest is the
                evidence. No PremiumLock: it is derived entirely from sections
                the payload already contains, so an account sees exactly the
                findings its own tier's data supports, and renders nothing at
                all when there is not enough record to say something true. */}
            {findings.length > 0 && (
                <Panel type='default' compactHeader title={t('What stands out')}>
                    <WhatStandsOut player={player} t={t} />
                </Panel>
            )}

            {/* ---- SAS / AERC lens -------------------------------------- */}
            <Panel type='default' compactHeader title={t('Read this as')}>
                <div className='space-y-2'>
                    <div className='flex flex-wrap items-center gap-1.5'>
                        {[
                            ['sas', t('SAS'), t('One number for how strong a deck is')],
                            [
                                'aerc',
                                t('AERC'),
                                t('What that number is made of, and which kinds beat you')
                            ]
                        ].map(([value, label, hint]) => (
                            <button
                                className={[
                                    'rounded-full border px-3 py-1 text-xs transition',
                                    lens === value
                                        ? 'border-accent/60 bg-accent/15 text-accent'
                                        : 'border-border/70 bg-surface-secondary/60 text-foreground hover:border-border'
                                ].join(' ')}
                                key={value}
                                onClick={() => setLens(value)}
                                title={hint}
                                type='button'
                            >
                                {label}
                            </button>
                        ))}
                        {!canAerc && (
                            <span className='ml-1 text-[11px] text-muted'>
                                {t('AERC analysis is part of Archon+.')}
                            </span>
                        )}
                    </div>
                    <p className='m-0 text-[11px] text-muted'>
                        {lens === 'aerc'
                            ? t(
                                  'AERC splits a deck into what it is actually good at. Bands are cut ' +
                                      'at the site-wide quartiles of each trait, so “high” means the ' +
                                      'same thing for everyone.'
                              )
                            : t(
                                  'SAS is a single score for deck power. Switch to AERC to see which ' +
                                      'kinds of deck you play well and which kinds beat you.'
                              )}
                    </p>
                </div>
            </Panel>

            {lens === 'aerc' && (
                <Panel type='default' compactHeader title={t('AERC')}>
                    <PremiumLock
                        capability={CAPABILITIES.AERC_ANALYTICS}
                        preview={<SamplePanel />}
                        minHeight={260}
                    >
                        <div className='space-y-4 p-1'>
                            {/* The answer first, then the evidence. */}
                            {!!aerc?.findings?.length && (
                                <div className='space-y-1.5'>
                                    <div className='text-[11px] uppercase tracking-wide text-muted'>
                                        {t('What stands out')}
                                    </div>
                                    <Findings findings={aerc.findings} t={t} />
                                    <p className='m-0 text-[11px] text-muted'>
                                        {t(
                                            'Ranked by the size of the gap, counting only bands with ' +
                                                'enough games behind them to mean something. These are ' +
                                                'records, not causes — deck power and who you happened ' +
                                                'to play ride along with any of them.'
                                        )}
                                    </p>
                                </div>
                            )}

                            <div className='flex flex-wrap items-center gap-1.5'>
                                {(aerc?.traits || []).map((entry) => (
                                    <button
                                        className={[
                                            'rounded-full border px-2.5 py-1 text-xs transition',
                                            trait === entry.key
                                                ? 'border-accent/60 bg-accent/15 text-accent'
                                                : 'border-border/70 bg-surface-secondary/60 text-foreground hover:border-border'
                                        ].join(' ')}
                                        key={entry.key}
                                        onClick={() => setTrait(entry.key)}
                                        type='button'
                                    >
                                        {entry.label}
                                    </button>
                                ))}
                            </div>

                            {aercLoading && (
                                <div className='text-sm text-muted'>{t('Loading…')}</div>
                            )}

                            {aerc?.opponent && (
                                <div className='space-y-1.5'>
                                    <div className='text-[11px] uppercase tracking-wide text-muted'>
                                        {t('Your record against their {{label}}', {
                                            label: (
                                                aerc.traits.find(
                                                    (entry) => entry.key === aerc.trait
                                                ) || {}
                                            ).label
                                        })}
                                    </div>
                                    <BandStrip bands={aerc.opponent.bands} t={t} />
                                </div>
                            )}

                            {aerc?.own && (
                                <div className='space-y-1.5'>
                                    <div className='text-[11px] uppercase tracking-wide text-muted'>
                                        {t('Your record with your own {{label}}', {
                                            label: (
                                                aerc.traits.find(
                                                    (entry) => entry.key === aerc.trait
                                                ) || {}
                                            ).label
                                        })}
                                    </div>
                                    <BandStrip bands={aerc.own.bands} t={t} />
                                </div>
                            )}

                            {/* What to bring against each kind of deck. */}
                            {!!aerc?.houses?.bands?.some((band) => band.houses.length > 0) && (
                                <div className='space-y-1.5'>
                                    <div className='text-[11px] uppercase tracking-wide text-muted'>
                                        {t('What has worked for you against each')}
                                    </div>
                                    <div className='grid gap-2 sm:grid-cols-2 lg:grid-cols-4'>
                                        {aerc.houses.bands.map((band) => (
                                            <div
                                                className='rounded border border-border/70 bg-surface-secondary/50 px-3 py-2'
                                                key={band.band}
                                            >
                                                <div className='mb-1 text-[11px] uppercase tracking-wide text-muted'>
                                                    {t('vs {{band}}', { band: t(band.band) })}
                                                </div>
                                                {band.houses.length ? (
                                                    band.houses.slice(0, 4).map((house) => (
                                                        <div
                                                            className='flex items-center justify-between text-xs'
                                                            key={house.house}
                                                        >
                                                            <span className='truncate text-foreground'>
                                                                {house.houseName}
                                                            </span>
                                                            <span className='ml-2 shrink-0 text-muted'>
                                                                {pct(house.winRate)} · {house.games}
                                                                g
                                                            </span>
                                                        </div>
                                                    ))
                                                ) : (
                                                    <div className='text-xs text-muted'>
                                                        {t('not enough games')}
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                    <p className='m-0 text-[11px] text-muted'>
                                        {t(
                                            'Houses your decks CONTAINED, so each game counts for three ' +
                                                'of them. Which house you actually played on a turn is ' +
                                                'not recorded outside replays.'
                                        )}
                                    </p>
                                </div>
                            )}

                            {/* The field, in the same terms - so two formats
                                can be held against each other. */}
                            {aerc?.meta?.available && (
                                <div className='space-y-1.5'>
                                    <div className='text-[11px] uppercase tracking-wide text-muted'>
                                        {filtered
                                            ? t('The field in these sets, over 30 days')
                                            : t('The whole field, over 30 days')}
                                    </div>
                                    <div className='grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5'>
                                        {aerc.meta.traits.map((entry) => (
                                            <Stat
                                                key={entry.key}
                                                label={entry.label}
                                                value={num(entry.median)}
                                                hint={t('median · mean {{mean}}', {
                                                    mean: num(entry.mean)
                                                })}
                                            />
                                        ))}
                                    </div>
                                    <p className='m-0 text-[11px] text-muted'>
                                        {t(
                                            'Across {{decks}} decks brought to games. Narrow the set ' +
                                                'filter above to compare one format against another.',
                                            { decks: aerc.meta.decks }
                                        )}
                                    </p>
                                </div>
                            )}

                            {/* Cards, with the caveat that makes them honest. */}
                            {!!aerc?.cards?.length && (
                                <div className='space-y-1.5'>
                                    <div className='text-[11px] uppercase tracking-wide text-muted'>
                                        {t('Cards in your winning decks')}
                                    </div>
                                    <div className='overflow-x-auto'>
                                        <table className='w-full min-w-[360px] text-sm'>
                                            <tbody>
                                                {aerc.cards.slice(0, 15).map((card) => (
                                                    <tr
                                                        className='border-b border-border/40'
                                                        key={card.cardId}
                                                    >
                                                        <td className='py-1 pr-2 text-foreground'>
                                                            {card.card}
                                                        </td>
                                                        <td className='py-1 pr-2 text-right text-muted'>
                                                            {card.wins}–{card.losses}
                                                        </td>
                                                        <td className='py-1 text-right text-foreground'>
                                                            {pct(card.winRate)}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                    <p className='m-0 text-[11px] text-muted'>
                                        {t(
                                            'Your record with decks that CONTAINED each card — not with ' +
                                                'the card being played, which is not recorded. A card ' +
                                                'that sat in your hand all game still counts, so read ' +
                                                'this as which of your decks win, described by their ' +
                                                'contents.'
                                        )}
                                    </p>
                                </div>
                            )}

                            {!aercLoading && !aerc?.findings?.length && !aerc?.own && (
                                <div className='text-sm text-muted'>
                                    {t(
                                        'Not enough rated games with decks Decks of KeyForge has scored ' +
                                            'yet. This fills in as you play.'
                                    )}
                                </div>
                            )}
                        </div>
                    </PremiumLock>
                </Panel>
            )}

            {/* ---- Deck Intelligence (1): is this deck good? -----------
                The page opens by promising three questions in order - is
                the deck good, are you good with it, how does it hold up
                against the field - and then rendered them 2, 1, 3, with
                Deck Intelligence tenth of sixteen panels and below three
                betas. The argument and the layout now agree. */}
            <Panel type='default' compactHeader title={t('Deck Intelligence — is this deck good?')}>
                <PremiumLock
                    capability={CAPABILITIES.ARCHON_INTELLIGENCE}
                    preview={<SamplePanel />}
                    minHeight={220}
                >
                    <DeckIntelligence decks={rankings} t={t} />
                </PremiumLock>
            </Panel>

            <Panel type='default' compactHeader title={t('Deck Intelligence — your decks ranked')}>
                <PremiumLock
                    capability={CAPABILITIES.PERSONAL_DECK_RANKINGS}
                    granted={served('rankings')}
                    preview={<SamplePanel />}
                    minHeight={200}
                >
                    {rankings.length ? (
                        <div className='overflow-x-auto'>
                            <table className='w-full min-w-[560px] text-sm'>
                                <thead>
                                    <tr className='border-b border-border/70 text-left text-xs uppercase tracking-wide text-muted'>
                                        <th className='py-1.5 pr-2 font-medium'>{t('Deck')}</th>
                                        <th className='py-1.5 pr-2 font-medium'>{t('Set')}</th>
                                        <th className='py-1.5 pr-2 text-right font-medium'>
                                            {t('Games')}
                                        </th>
                                        <th className='py-1.5 pr-2 text-right font-medium'>
                                            {t('W–L')}
                                        </th>
                                        <th className='py-1.5 pr-2 text-right font-medium'>
                                            {t('Win rate')}
                                        </th>
                                        <th className='py-1.5 pr-2 text-right font-medium'>
                                            {t('SAS')}
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rankings.map((deck) => (
                                        <tr className='border-b border-border/40' key={deck.deckId}>
                                            <td className='py-1.5 pr-2 text-foreground'>
                                                {deck.deckName}
                                            </td>
                                            <td
                                                className='py-1.5 pr-2 text-muted'
                                                title={deck.set?.name}
                                            >
                                                {deck.set?.code || '—'}
                                            </td>
                                            <td className='py-1.5 pr-2 text-right text-muted'>
                                                {deck.games}
                                            </td>
                                            <td className='py-1.5 pr-2 text-right text-muted'>
                                                {deck.wins}–{deck.losses}
                                            </td>
                                            {/* The rate is only rendered as a
                                                finding when there is a sample
                                                behind it. Under the threshold
                                                it is greyed and carries the
                                                count, so a 1-0 deck at the top
                                                of the table reads as what it
                                                is rather than as the best deck
                                                somebody owns. */}
                                            <td
                                                className={`py-1.5 pr-2 text-right ${
                                                    deck.confident
                                                        ? 'text-foreground'
                                                        : 'text-muted'
                                                }`}
                                            >
                                                {pct(deck.winRate)}
                                                {!deck.confident && (
                                                    <span
                                                        className='ml-1 text-amber-300/80'
                                                        title={t(
                                                            'Only {{games}} games — too few to rank on. {{min}}+ is a usable sample.',
                                                            {
                                                                games: deck.games,
                                                                min: deck.minConfidentGames ?? 10
                                                            }
                                                        )}
                                                    >
                                                        *
                                                    </span>
                                                )}
                                            </td>
                                            <td className='py-1.5 pr-2 text-right text-muted'>
                                                {deck.sas ?? '—'}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {rankings.some((deck) => !deck.confident) && (
                                <p className='m-0 pt-2 text-[11px] text-muted'>
                                    {t(
                                        'Sorted by win rate. A * marks a record with fewer than ' +
                                            '{{min}} games behind it — shown in place rather than ' +
                                            'hidden, because “won every game” is worth seeing as ' +
                                            'long as “twice” is printed beside it.',
                                        {
                                            min:
                                                rankings.find((deck) => deck.minConfidentGames)
                                                    ?.minConfidentGames ?? 10
                                        }
                                    )}
                                </p>
                            )}
                        </div>
                    ) : (
                        <div className='p-3 text-sm text-muted'>
                            {/* "Play more games" is the wrong advice when the
                                real answer is that the filter excluded them. */}
                            {filtered
                                ? t(
                                      'No games with decks from the selected sets. Try another set, or ' +
                                          'All sets.'
                                  )
                                : t(
                                      'Play a few games with your decks and their records appear here.'
                                  )}
                        </div>
                    )}
                </PremiumLock>
            </Panel>

            {/* ---- Deck comparison: which of these serves me better? ---- */}
            <Panel type='default' compactHeader title={t('Deck Intelligence — compare your decks')}>
                <PremiumLock
                    capability={CAPABILITIES.DECK_COMPARISON}
                    preview={<SamplePanel />}
                    minHeight={220}
                >
                    <DeckComparison decks={rankings} t={t} />
                </PremiumLock>
            </Panel>

            {/* ---- Player Intelligence (2): are you good with it? ------ */}
            <Panel type='default' compactHeader title={t('Player Intelligence')}>
                <PremiumLock
                    capability={CAPABILITIES.PERFORMANCE_DASHBOARD}
                    granted={served('vsExpectation')}
                    preview={<SamplePanel />}
                    minHeight={220}
                >
                    {isLoading ? (
                        <div className='p-3 text-sm text-muted'>{t('Loading…')}</div>
                    ) : vs?.available ? (
                        <div className='space-y-3 p-1'>
                            <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
                                <Stat label={t('Rated games')} value={vs.games} />
                                <Stat label={t('Win rate')} value={pct(vs.winRate)} />
                                <Stat
                                    label={t('Expected win rate')}
                                    value={pct(vs.expectedWinRate)}
                                    hint={t('what your rating predicted')}
                                />
                                <Stat
                                    label={t('vs expectation')}
                                    tone={vs.vsExpectation >= 0 ? 'good' : 'bad'}
                                    value={`${vs.vsExpectation >= 0 ? '+' : ''}${num(
                                        vs.vsExpectation
                                    )}`}
                                    hint={t('wins above/below prediction')}
                                />
                            </div>
                            <p className='m-0 text-xs text-muted'>
                                {t(
                                    'The rating engine records what it expected before each game was ' +
                                        'played. The gap between that and what happened is the part ' +
                                        'that is you rather than the matchup.'
                                )}
                            </p>
                        </div>
                    ) : (
                        <div className='p-3 text-sm text-muted'>
                            {vs?.reason || t('No rated games yet — play a few and come back.')}
                        </div>
                    )}
                </PremiumLock>
            </Panel>

            {/* ---- Elo history (Supporter) ------------------------------ */}
            <Panel type='default' compactHeader title={t('Your rating history')}>
                <PremiumLock
                    capability={CAPABILITIES.ELO_HISTORY}
                    granted={served('ratingHistory')}
                    preview={<SamplePanel />}
                    minHeight={200}
                >
                    <EloHistory history={player?.ratingHistory} t={t} />
                </PremiumLock>
            </Panel>

            {/* ---- Preview programme ------------------------------------
                No PremiumLock: these are not locked panels with an upgrade
                prompt behind them, they are sections that either arrived in the
                payload or did not. The server decides, from the account's tier
                and its own switches, and an account without them sees nothing
                here at all rather than a teaser for a thing that is not
                finished. */}
            {previews.includes('vsExpectationTrend') && (
                <PreviewPanel stage={t('Beta')} t={t} title={t('Performance trend')}>
                    <PerformanceTrend t={t} trend={player?.vsExpectationTrend} />
                </PreviewPanel>
            )}

            {previews.includes('form') && (
                <PreviewPanel stage={t('Experimental')} t={t} title={t('Form and streaks')}>
                    <FormAndStreaks form={player?.form} t={t} />
                </PreviewPanel>
            )}

            {previews.includes('byTurnOrder') && (
                <PreviewPanel stage={t('Early access')} t={t} title={t('Turn order')}>
                    <TurnOrder t={t} turnOrder={player?.byTurnOrder} />
                </PreviewPanel>
            )}

            {/* ---- By set ----------------------------------------------- */}
            <Panel type='default' compactHeader title={t('Your record by set')}>
                <PremiumLock
                    capability={CAPABILITIES.ARCHON_INTELLIGENCE}
                    preview={<SamplePanel />}
                    minHeight={180}
                >
                    <div className='space-y-1.5 p-1'>
                        {(player?.bySet || []).map((row) => (
                            <SetRow key={row.set?.id} row={row} t={t} />
                        ))}
                        {!player?.bySet?.length && (
                            <div className='text-sm text-muted'>{t('No games recorded yet.')}</div>
                        )}
                        <p className='m-0 pt-1 text-[11px] text-muted'>
                            {t(
                                'Not filtered — this is the table you pick a filter from. A deck belongs ' +
                                    'to exactly one set, so unlike the house tables these are shares of ' +
                                    'your real games and add up to 100%.'
                            )}
                        </p>
                    </div>
                </PremiumLock>
            </Panel>

            {/* ---- Matchups --------------------------------------------- */}
            <Panel
                type='default'
                compactHeader
                title={
                    filtered ? t('Your record by house, in these sets') : t('Your record by house')
                }
            >
                <PremiumLock
                    capability={CAPABILITIES.MATCHUP_ANALYTICS}
                    granted={served('byHouse')}
                    preview={<SamplePanel />}
                    minHeight={180}
                >
                    <div className='space-y-1.5 p-1'>
                        {(player?.byHouse || []).map((row) => (
                            <HouseBar key={row.house} row={row} t={t} />
                        ))}
                        {!player?.byHouse?.length && (
                            <div className='text-sm text-muted'>{t('No games recorded yet.')}</div>
                        )}
                        <p className='m-0 pt-1 text-[11px] text-muted'>
                            {t(
                                'Measured across decks that CONTAIN each house — not the house you ' +
                                    'called on a given turn, which is recorded only inside replays. ' +
                                    'Replay Intelligence, below, is the per-turn figure.'
                            )}
                        </p>
                    </div>
                </PremiumLock>
            </Panel>

            {/* ---- Replay Intelligence ---------------------------------- */}
            <Panel
                type='default'
                compactHeader
                title={t('Replay Intelligence — the house you actually call')}
            >
                <PremiumLock
                    capability={CAPABILITIES.ADVANCED_REPLAYS}
                    preview={<SamplePanel />}
                    minHeight={200}
                >
                    <ReplayIntelligence insights={replays} t={t} />
                </PremiumLock>
                <p className='m-0 px-1 pt-2 text-[11px] text-muted'>
                    {t(
                        'Read from your last 25 recorded games. Any finished game also carries its ' +
                            'own turn-by-turn analysis — open it from Game History.'
                    )}
                </p>
            </Panel>

            {/* ---- Meta Intelligence ------------------------------------ */}
            <Panel type='default' compactHeader title={t('Meta Intelligence')}>
                <PremiumLock
                    capability={CAPABILITIES.META_ANALYTICS}
                    preview={<SamplePanel />}
                    minHeight={200}
                >
                    <div className='space-y-2 p-1'>
                        {meta?.summary?.available && (
                            <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
                                <Stat label={t('Games')} value={meta.summary.games} />
                                <Stat label={t('Players')} value={meta.summary.players} />
                                <Stat label={t('Decks')} value={meta.summary.decks} />
                                <Stat
                                    label={t('Avg length')}
                                    value={duration(meta.summary.avgSeconds)}
                                />
                            </div>
                        )}
                        <div className='space-y-1.5'>
                            {(meta?.houses?.rows || []).map((row) => (
                                <HouseBar key={row.house} row={row} t={t} />
                            ))}
                        </div>
                        <p className='m-0 text-[11px] text-muted'>
                            {filtered
                                ? t(
                                      'House prevalence across the last {{days}} days, in the selected ' +
                                          'sets only. Each set ships its own distribution of houses, so ' +
                                          'this is the number that changes most when you narrow it.',
                                      { days: meta?.days ?? 30 }
                                  )
                                : t('Across all decided games in the last {{days}} days.', {
                                      days: meta?.days ?? 30
                                  })}
                        </p>
                    </div>
                </PremiumLock>
            </Panel>

            {/* ---- What the field is playing, by set -------------------- */}
            <Panel type='default' compactHeader title={t('What the field is playing, by set')}>
                <PremiumLock
                    capability={CAPABILITIES.META_ANALYTICS}
                    preview={<SamplePanel />}
                    minHeight={180}
                >
                    <div className='space-y-1.5 p-1'>
                        {(meta?.bySet?.rows || []).map((row) => (
                            <SetRow key={row.set?.id} row={row} t={t} />
                        ))}
                        {!meta?.bySet?.rows?.length && (
                            <div className='text-sm text-muted'>
                                {t('No games in this window yet.')}
                            </div>
                        )}
                        <p className='m-0 pt-1 text-[11px] text-muted'>
                            {t(
                                'Also unfiltered, for the same reason. Read the share column as what ' +
                                    'you are likely to face; treat the win rate as a statement about ' +
                                    'who plays each set rather than about the cards in it.'
                            )}
                        </p>
                    </div>
                </PremiumLock>
            </Panel>
        </div>
    );
};

ArchonIntelligence.displayName = 'ArchonIntelligence';

export default ArchonIntelligence;
