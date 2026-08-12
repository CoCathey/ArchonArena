import React from 'react';
import PropTypes from 'prop-types';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import AlertPanel from '../Components/Site/AlertPanel';
import PremiumLock from '../Components/Membership/PremiumLock';
import { CAPABILITIES, hasCapability } from '../membership';
import { useGetPlayerIntelligenceQuery, useGetMetaIntelligenceQuery } from '../redux/api';

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

const ArchonIntelligence = () => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    const unlocked = hasCapability(user, CAPABILITIES.ARCHON_INTELLIGENCE);
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
                    <Link className='text-sm text-primary hover:underline' to='/membership'>
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
                    capability={CAPABILITIES.ARCHON_INTELLIGENCE}
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

            {/* ---- Deck Intelligence ------------------------------------ */}
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
