import React from 'react';
import PropTypes from 'prop-types';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';

import Panel from '../Site/Panel';
import PremiumLock from '../Membership/PremiumLock';
import { CAPABILITIES, hasCapability } from '../../membership';
import { useGetGameReplayAnalysisQuery, useGetSharedReplayAnalysisQuery } from '../../redux/api';

/**
 * ARCHON (N12): the analysis over a replay - the Archon tier's
 * `advanced_replays`.
 *
 * Stepping through a replay is free and stays free. What this adds is the
 * reading of the game: every turn with the house that was called on it, the
 * amber each one earned, the key race, and the point after which the winner was
 * never headed again.
 *
 * Locked rather than hidden, like every other premium panel: a free account
 * sees the shape of it and what it would tell them. Nothing here is computed
 * client-side from the recording - the endpoint carries the capability check,
 * and a locked account never receives the numbers at all.
 *
 * @param {object} props
 * @param {string} [props.gameId] a game of the reader's own
 * @param {string} [props.shareToken] a game reached by a share link
 * @param {(messageIndex: number) => void} [props.onJump] move the viewer
 */
const ReplayAnalysis = ({ gameId, shareToken, onJump }) => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    const unlocked = hasCapability(user, CAPABILITIES.ADVANCED_REPLAYS);

    // Never asked for when locked: a 403 per replay teaches nobody anything,
    // and the locked state renders from the catalogue copy instead.
    const own = useGetGameReplayAnalysisQuery(gameId, {
        skip: !unlocked || !gameId
    });
    const shared = useGetSharedReplayAnalysisQuery(shareToken, {
        skip: !unlocked || !!gameId || !shareToken
    });

    const { data, isFetching } = gameId ? own : shared;
    const analysis = data?.analysis;

    if (!gameId && !shareToken) {
        return null;
    }

    return (
        <Panel title={t('Replay analysis')} titleAlign='center'>
            <PremiumLock
                capability={CAPABILITIES.ADVANCED_REPLAYS}
                preview={<SamplePanel t={t} />}
                minHeight={220}
            >
                {isFetching ? (
                    <div className='p-3 text-sm text-muted'>{t('Reading the game…')}</div>
                ) : analysis?.available ? (
                    <Analysis analysis={analysis} onJump={onJump} t={t} />
                ) : (
                    <div className='p-3 text-sm text-muted'>
                        {analysis?.reason || t('This replay could not be analysed.')}
                    </div>
                )}
            </PremiumLock>
        </Panel>
    );
};

/** A headline number, matching the Archon Intelligence tiles. */
const Stat = ({ label, value, hint }) => (
    <div className='rounded border border-border/70 bg-surface-secondary/60 px-3 py-2'>
        <div className='text-[11px] uppercase tracking-wide text-muted'>{label}</div>
        <div className='text-lg font-semibold text-foreground'>{value}</div>
        {hint && <div className='text-[11px] text-muted'>{hint}</div>}
    </div>
);

Stat.propTypes = { hint: PropTypes.node, label: PropTypes.node, value: PropTypes.node };

const num = (value, fallback = '—') =>
    value === null || value === undefined ? fallback : Number(value).toFixed(1).replace(/\.0$/, '');

/**
 * The key race as one line per player.
 *
 * Inline SVG rather than a charting dependency: it is two polylines over series
 * the server already shaped in turn order.
 */
const AmberChart = ({ turns, players, t }) => {
    const byPlayer = players.map((player) => ({
        name: player.name,
        points: turns
            .filter((turn) => turn.player === player.name)
            .map((turn) => ({ round: turn.round, value: turn.amberEnd + turn.keysEnd * 6 }))
    }));

    const all = byPlayer.flatMap((series) => series.points.map((point) => point.value));

    if (all.length === 0) {
        return null;
    }

    const max = Math.max(...all, 1);
    const width = 600;
    const height = 110;
    const colours = ['text-amber-300', 'text-sky-300'];

    return (
        <div className='overflow-x-auto'>
            <svg
                className='w-full'
                height={height}
                preserveAspectRatio='none'
                role='img'
                aria-label={t('Amber and forged keys over the game')}
                viewBox={`0 0 ${width} ${height}`}
            >
                {byPlayer.map((series, index) => (
                    <polyline
                        key={series.name}
                        fill='none'
                        stroke='currentColor'
                        strokeWidth='2'
                        className={colours[index % colours.length]}
                        points={series.points
                            .map((point, position) => {
                                const x =
                                    series.points.length === 1
                                        ? width / 2
                                        : (position / (series.points.length - 1)) * width;

                                return `${x.toFixed(1)},${(
                                    height -
                                    (point.value / max) * height
                                ).toFixed(1)}`;
                            })
                            .join(' ')}
                    />
                ))}
            </svg>
            <div className='flex flex-wrap gap-3 text-[11px] text-muted'>
                {byPlayer.map((series, index) => (
                    <span key={series.name} className={colours[index % colours.length]}>
                        ● <span className='text-muted'>{series.name}</span>
                    </span>
                ))}
                <span>
                    {t('Forged keys counted at 6 amber each — the currency the game is played in.')}
                </span>
            </div>
        </div>
    );
};

AmberChart.propTypes = { players: PropTypes.array, t: PropTypes.func, turns: PropTypes.array };

const Analysis = ({ analysis, onJump, t }) => {
    const { players, turns, summary, decisive } = analysis;

    return (
        <div className='space-y-3 p-1'>
            {/* Each player's game in four numbers. */}
            {players.map((player) => {
                const own = summary[player.name] || {};
                const houses = Object.entries(own.houses || {}).sort((a, b) => b[1] - a[1]);

                return (
                    <div key={player.name} className='space-y-2'>
                        <div className='flex flex-wrap items-baseline gap-2 text-sm'>
                            <span className='font-semibold text-foreground'>{player.name}</span>
                            {player.won === true && (
                                <span className='text-xs text-emerald-300'>{t('Winner')}</span>
                            )}
                            {player.deckName && (
                                <span className='text-xs text-muted'>{player.deckName}</span>
                            )}
                        </div>

                        <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
                            <Stat label={t('Turns')} value={own.turns ?? '—'} />
                            <Stat
                                label={t('Amber per turn')}
                                value={num(own.amberPerTurn)}
                                hint={t('turns that gained any')}
                            />
                            <Stat
                                label={t('Keys')}
                                value={own.keys ?? 0}
                                hint={
                                    own.firstKeyRound
                                        ? t('first on turn {{round}}', { round: own.firstKeyRound })
                                        : t('none forged')
                                }
                            />
                            <Stat
                                label={t('Creatures')}
                                value={num(own.avgCreatures)}
                                hint={t('average on board')}
                            />
                        </div>

                        {houses.length > 0 && (
                            <div className='flex flex-wrap items-center gap-1.5 text-xs'>
                                <span className='uppercase tracking-wide text-muted'>
                                    {t('Houses called')}
                                </span>
                                {houses.map(([house, count]) => (
                                    <span
                                        key={house}
                                        className='rounded bg-surface-secondary/60 px-1.5 py-0.5 text-foreground'
                                    >
                                        {t(house)} ×{count}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}

            <AmberChart players={players} t={t} turns={turns} />

            {/* The one judgement this makes, and it is labelled as one. */}
            {decisive && (
                <div className='rounded border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm'>
                    {decisive.wireToWire ? (
                        <span className='text-foreground'>
                            {t('{{player}} was never behind on amber and keys.', {
                                player: decisive.player
                            })}
                        </span>
                    ) : (
                        <span className='text-foreground'>
                            {t(
                                '{{player}} took the lead on turn {{round}} and never gave it back.',
                                { player: decisive.player, round: decisive.round }
                            )}
                        </span>
                    )}{' '}
                    {onJump && (
                        <button
                            className='underline decoration-dotted underline-offset-2 text-amber-300'
                            type='button'
                            onClick={() => onJump(decisive.messageIndex)}
                        >
                            {t('Go to that turn')}
                        </button>
                    )}
                    <p className='m-0 mt-1 text-[11px] text-muted'>
                        {t(
                            'Measured on amber plus forged keys only. It says when the game stopped ' +
                                'changing hands, not why — board, hand and deck are not in it.'
                        )}
                    </p>
                </div>
            )}

            {analysis.thinned && (
                <p className='m-0 text-[11px] text-muted'>
                    {t(
                        'This game ran long enough that board states were recorded at reduced ' +
                            'resolution, so per-turn figures are coarser than usual.'
                    )}
                </p>
            )}

            {/* Turn by turn, and clicking a row moves the viewer to it. */}
            <div className='overflow-x-auto'>
                <table className='w-full min-w-[520px] text-xs'>
                    <thead>
                        <tr className='border-b border-border/70 text-left text-muted'>
                            <th className='py-1 pr-2 font-medium'>{t('Turn')}</th>
                            <th className='py-1 pr-2 font-medium'>{t('Player')}</th>
                            <th className='py-1 pr-2 font-medium'>{t('House')}</th>
                            <th className='py-1 pr-2 text-right font-medium'>{t('Amber')}</th>
                            <th className='py-1 pr-2 text-right font-medium'>{t('Keys')}</th>
                            <th className='py-1 pr-2 text-right font-medium'>{t('Creatures')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {turns.map((turn) => (
                            <tr
                                key={`${turn.round}-${turn.player}-${turn.index}`}
                                className='cursor-pointer border-b border-border/40 hover:bg-surface-secondary/50'
                                onClick={() => onJump && onJump(turn.messageIndex)}
                            >
                                <td className='py-1 pr-2 text-muted'>{turn.round}</td>
                                <td className='py-1 pr-2 text-foreground'>{turn.player}</td>
                                <td className='py-1 pr-2 text-amber-300'>
                                    {turn.house ? t(turn.house) : '—'}
                                </td>
                                <td className='py-1 pr-2 text-right text-foreground'>
                                    {turn.amberEnd}
                                    {turn.amberGained > 0 && (
                                        <span className='ml-1 text-emerald-300'>
                                            +{turn.amberGained}
                                        </span>
                                    )}
                                </td>
                                <td className='py-1 pr-2 text-right text-muted'>
                                    {turn.keysEnd}
                                    {turn.forged > 0 && (
                                        <span className='ml-1 text-amber-300'>+{turn.forged}</span>
                                    )}
                                </td>
                                <td className='py-1 pr-2 text-right text-muted'>
                                    {turn.creatures}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

Analysis.propTypes = { analysis: PropTypes.object, onJump: PropTypes.func, t: PropTypes.func };

/** Blurred sample behind the lock, so the panel demonstrates its own value. */
const SamplePanel = ({ t }) => (
    <div className='space-y-2 p-3'>
        <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
            {[
                [t('Turns'), '11'],
                [t('Amber per turn'), '3.4'],
                [t('Keys'), '3'],
                [t('Creatures'), '2.8']
            ].map(([label, value]) => (
                <Stat key={label} label={label} value={value} />
            ))}
        </div>
        <div className='space-y-1'>
            {[0, 1, 2, 3].map((index) => (
                <div key={index} className='h-4 rounded bg-surface-secondary/70' />
            ))}
        </div>
    </div>
);

SamplePanel.propTypes = { t: PropTypes.func };

ReplayAnalysis.propTypes = {
    gameId: PropTypes.string,
    onJump: PropTypes.func,
    shareToken: PropTypes.string
};

ReplayAnalysis.displayName = 'ReplayAnalysis';

export default ReplayAnalysis;
