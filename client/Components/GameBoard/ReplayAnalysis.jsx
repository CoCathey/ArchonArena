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

/**
 * ARCHON (F3): one flagged moment, as a sentence a player can act on.
 *
 * The copy is composed here rather than on the server so it localises, and it
 * is deliberately phrased as an observation - what the recording shows - not
 * as a verdict. The caveat under the list says why.
 */
const momentText = (moment, t) => {
    switch (moment.type) {
        case 'house-call':
            return t(
                'Called {{house}} worth {{potential}} in cards, pips and reaps — {{bestHouse}} offered {{bestPotential}}.',
                {
                    house: t(moment.house),
                    potential: moment.potential,
                    bestHouse: t(moment.bestHouse),
                    bestPotential: moment.bestPotential
                }
            );
        case 'answer-held': {
            const toolLabels = {
                'amber-control': t('a steal or capture'),
                'forge-denial': t('a key-cost raiser'),
                'board-wipe': t('a board wipe')
            };
            const tool = t('{{card}} — {{what}}', {
                card: moment.card?.name,
                what:
                    toolLabels[moment.role] ||
                    (moment.pressure === 'check'
                        ? toolLabels['amber-control']
                        : toolLabels['board-wipe'])
            });
            const threat =
                moment.pressure === 'check'
                    ? t('They forged that key')
                    : t('Their board stayed wide');

            if (moment.houseWasCalled) {
                return t('{{threat}} while {{tool}} stayed unplayed in your called house.', {
                    threat,
                    tool
                });
            }

            return t(
                '{{threat}} while {{tool}} sat in your {{zone}} — a {{house}} call could have reached it.',
                {
                    threat,
                    tool,
                    zone: moment.fromArchives ? t('archives') : t('hand'),
                    house: t(moment.card?.house)
                }
            );
        }
        case 'unused-creatures':
            return t(
                '{{count}} ready {{house}} creature(s) went unused ({{creatures}}) — a reap each, left on the table.',
                {
                    count: moment.count,
                    house: t(moment.house),
                    creatures: (moment.creatures || []).join(', ')
                }
            );
        case 'held-cards':
            return t(
                'Ended the turn still holding {{held}} ({{count}} playable {{house}} card(s)) — {{missed}} fewer fresh card(s) drawn.',
                {
                    held: (moment.held || []).map((card) => card.name).join(', '),
                    count: (moment.held || []).length,
                    house: t(moment.house),
                    missed: moment.missedDraws
                }
            );
        case 'clogged-hand':
            return t(
                '{{house}} sat at {{peak}} cards in hand for {{turns}} straight turns without being called.',
                {
                    house: t(moment.house),
                    peak: moment.peak,
                    turns: moment.turnsHeld
                }
            );
        default:
            return null;
    }
};

/**
 * ARCHON (F3): what the deck showed, house by house - the reading a player
 * plans house calls with. "As revealed" by this game's zones, not the
 * decklist: cards that never left the deck are not in it.
 */
const Toolbox = ({ toolbox, t }) => {
    const players = Object.entries(toolbox || {});

    if (players.length === 0) {
        return null;
    }

    return (
        <div className='space-y-2'>
            {players.map(([name, profile]) => {
                const houses = Object.entries(profile?.houses || {}).sort(
                    (a, b) => b[1].cards - a[1].cards
                );

                if (houses.length === 0) {
                    return null;
                }

                return (
                    <div key={name}>
                        <div className='text-xs uppercase tracking-wide text-muted'>
                            {t('What {{player}}’s deck showed', { player: name })}
                        </div>
                        <div className='mt-1 flex flex-wrap gap-1.5 text-xs'>
                            {houses.map(([house, counts]) => (
                                <span
                                    key={house}
                                    className='rounded bg-surface-secondary/60 px-1.5 py-0.5 text-muted'
                                >
                                    <span className='text-amber-300'>{t(house)}</span>{' '}
                                    {t('{{cards}} cards', { cards: counts.cards })}
                                    {counts.pips > 0 &&
                                        ` · ${t('{{pips}} pips', { pips: counts.pips })}`}
                                    {counts.amberControl > 0 &&
                                        ` · ${t('{{n}} steal/capture', {
                                            n: counts.amberControl
                                        })}`}
                                    {counts.forgeDenial > 0 &&
                                        ` · ${t('{{n}} forge denial', { n: counts.forgeDenial })}`}
                                    {counts.boardWipes > 0 &&
                                        ` · ${t('{{n}} wipes', { n: counts.boardWipes })}`}
                                    {counts.keyCheats > 0 &&
                                        ` · ${t('{{n}} key cheats', { n: counts.keyCheats })}`}
                                </span>
                            ))}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

Toolbox.propTypes = { t: PropTypes.func, toolbox: PropTypes.object };

/**
 * The misplay review: the moments worth a second look, each one a jump into
 * the replay at the frame it was read from. Own-game replays only - the
 * server never attaches this section to a shared replay's analysis.
 */
const Misplays = ({ misplays, onJump, t }) => {
    if (!misplays || !misplays.available) {
        return null;
    }

    const moments = (misplays.moments || []).filter((moment) => momentText(moment, t));
    // An empty list earns more trust when it can say how much was checked:
    // every justification that fired is a candidate moment the review looked
    // at and cleared for a reason it could see.
    const cleared = Object.values(misplays.suppressed || {}).reduce((sum, count) => sum + count, 0);

    return (
        <div className='space-y-2'>
            <div className='text-xs uppercase tracking-wide text-muted'>
                {t('Worth a second look')}
            </div>

            {moments.length === 0 ? (
                <p className='m-0 text-sm text-muted'>
                    {!misplays.handsRecorded
                        ? t(
                              'This game was recorded before hands were captured, so only the ' +
                                  'board could be checked — and nothing stood out there.'
                          )
                        : cleared > 0
                        ? t(
                              'Nothing stood out — {{count}} possible moment(s) were checked and ' +
                                  'had a visible reason.',
                              { count: cleared }
                          )
                        : t('Nothing stood out — no turn left an obvious question behind.')}
                </p>
            ) : (
                <ul className='m-0 list-none space-y-1.5 p-0'>
                    {moments.map((moment, index) => (
                        <li
                            key={`${moment.type}-${moment.player}-${moment.messageIndex}-${index}`}
                            className='rounded border border-border/55 bg-surface-secondary/40 px-2.5 py-1.5 text-sm'
                        >
                            <span className='text-muted'>
                                {t('Turn {{round}}, {{player}}:', {
                                    round: moment.round,
                                    player: moment.player
                                })}
                            </span>{' '}
                            <span className='text-foreground'>{momentText(moment, t)}</span>{' '}
                            {onJump && (
                                <button
                                    className='underline decoration-dotted underline-offset-2 text-amber-300'
                                    type='button'
                                    onClick={() => onJump(moment.messageIndex)}
                                >
                                    {t('Look')}
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            <Toolbox toolbox={misplays.toolbox} t={t} />

            {misplays.thinned && (
                <p className='m-0 text-[11px] text-muted'>
                    {t(
                        'This game was recorded at reduced resolution, so the end-of-turn checks ' +
                            'were skipped.'
                    )}
                </p>
            )}

            <p className='m-0 text-[11px] text-muted'>
                {t(
                    'Read from the recorded board, hands and archives, plus what each card’s ' +
                        'own text says it does — steals, wipes, key cheats. Conditions, costs ' +
                        'and the plan you were on are still invisible, so “was in hand” never ' +
                        'means “would have worked”. Moments with a visible reason are dropped ' +
                        'automatically: forced or restricted house calls, thin calls that ' +
                        'forged or denied a check or out-earned the fuller house, holds of pure ' +
                        'answers, holds that got played within two turns, and long holds that ' +
                        'cashed out. What remains are still questions, not verdicts.'
                )}
            </p>
        </div>
    );
};

Misplays.propTypes = { misplays: PropTypes.object, onJump: PropTypes.func, t: PropTypes.func };

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

            {/* ARCHON (F3): the misplay review - your own side only, and only
                on your own games; a shared replay's analysis never carries it. */}
            <Misplays misplays={analysis.misplays} onJump={onJump} t={t} />

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
