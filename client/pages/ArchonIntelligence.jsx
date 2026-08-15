import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import AlertPanel from '../Components/Site/AlertPanel';
import PremiumLock from '../Components/Membership/PremiumLock';
import { CAPABILITIES, hasCapability } from '../membership';
import {
    useGetDeckIntelligenceQuery,
    useGetPlayerIntelligenceQuery,
    useGetMetaIntelligenceQuery
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
 */

const pct = (value) =>
    value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
const num = (value, digits = 1) =>
    value === null || value === undefined ? '—' : Number(value).toFixed(digits);
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
    const selected = deckId || (decks.length ? decks[0].deckId : null);

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
                {decks.slice(0, 12).map((deck) => (
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

                    {everyone?.available && everyone.games > mine.overview.games && (
                        <p className='m-0 text-xs text-muted'>
                            {t(
                                'Across every player who has used this deck: {{wins}}–{{losses}} ({{rate}}).',
                                {
                                    wins: everyone.wins,
                                    losses: everyone.losses,
                                    rate: pct(everyone.winRate)
                                }
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

                    <div className='text-xs text-muted'>
                        {mine.byTurnOrder?.available ? (
                            <span>
                                {t('Going first: {{first}} · Going second: {{second}}', {
                                    first: pct(mine.byTurnOrder.first.winRate),
                                    second: pct(mine.byTurnOrder.second.winRate)
                                })}
                            </span>
                        ) : (
                            <span>{mine.byTurnOrder?.reason}</span>
                        )}
                    </div>
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
    const unlocked = playerSections.some((capability) => hasCapability(user, capability));
    const canMeta = hasCapability(user, CAPABILITIES.META_ANALYTICS);

    // Skipped entirely when locked: a 403 round trip per panel teaches nobody
    // anything, and the locked state is rendered from the catalogue copy.
    const { data: player, isLoading } = useGetPlayerIntelligenceQuery(undefined, {
        skip: !user || !unlocked
    });
    const { data: meta } = useGetMetaIntelligenceQuery(30, { skip: !user || !canMeta });

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

            {/* ---- Player Intelligence ---------------------------------- */}
            <Panel type='default' compactHeader title={t('Player Intelligence')}>
                <PremiumLock
                    capability={CAPABILITIES.PERFORMANCE_DASHBOARD}
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
                    preview={<SamplePanel />}
                    minHeight={200}
                >
                    <EloHistory history={player?.ratingHistory} t={t} />
                </PremiumLock>
            </Panel>

            {/* ---- Deck Intelligence: is this deck good? ---------------- */}
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
                    preview={<SamplePanel />}
                    minHeight={200}
                >
                    {rankings.length ? (
                        <div className='overflow-x-auto'>
                            <table className='w-full min-w-[560px] text-sm'>
                                <thead>
                                    <tr className='border-b border-border/70 text-left text-xs uppercase tracking-wide text-muted'>
                                        <th className='py-1.5 pr-2 font-medium'>{t('Deck')}</th>
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
                                            <td className='py-1.5 pr-2 text-right text-muted'>
                                                {deck.games}
                                            </td>
                                            <td className='py-1.5 pr-2 text-right text-muted'>
                                                {deck.wins}–{deck.losses}
                                            </td>
                                            <td className='py-1.5 pr-2 text-right text-foreground'>
                                                {pct(deck.winRate)}
                                            </td>
                                            <td className='py-1.5 pr-2 text-right text-muted'>
                                                {deck.sas ?? '—'}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <div className='p-3 text-sm text-muted'>
                            {t('Play a few games with your decks and their records appear here.')}
                        </div>
                    )}
                </PremiumLock>
            </Panel>

            {/* ---- Matchups --------------------------------------------- */}
            <Panel type='default' compactHeader title={t('Your record by house')}>
                <PremiumLock
                    capability={CAPABILITIES.MATCHUP_ANALYTICS}
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
                                'Measured across decks that CONTAIN each house. Which house you chose ' +
                                    'on a given turn is not recorded outside replays, so this is not a ' +
                                    'per-turn figure.'
                            )}
                        </p>
                    </div>
                </PremiumLock>
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
                            {t('Across all decided games in the last {{days}} days.', {
                                days: meta?.days ?? 30
                            })}
                        </p>
                    </div>
                </PremiumLock>
            </Panel>
        </div>
    );
};

ArchonIntelligence.displayName = 'ArchonIntelligence';

export default ArchonIntelligence;
