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
    useGetChampionsChallengeQuery,
    useEnrollChampionsChallengeDeckMutation,
    useEnrollRandomChampionsChallengeDeckMutation,
    useWithdrawChampionsChallengeDeckMutation
} from '../redux/api';
import { serverMessage } from '../redux/apiError';

/**
 * ARCHON (N18): the Champion’s Challenge.
 *
 * A computer plays a Vault Master's enrolled decks against each other in the
 * background - practice games on the real engine, never rated ones - and this
 * page reads out what those games found: each deck's simulated record, how it
 * compares with what its SAS predicted, and which decks keep winning more than
 * their rating says they should. Those are the hidden gems.
 *
 * Two deliberate refusals, matching Deep Probe:
 *
 *  - No confident-looking numbers over tiny samples. A deck below the game
 *    threshold shows its record and a warning, and is never called a gem or a
 *    dud until the sample can carry the claim.
 *  - The page never calls a sparring result an official one. Simulated games
 *    touch no Amber, no deck record and no leaderboard, and the copy says so
 *    where the numbers are shown, not in a footnote.
 */

const pct = (value) =>
    value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;

/** The blurred skeleton a locked account sees behind the overlay. */
const SampleGrounds = () => (
    <div className='space-y-2 p-3'>
        <div className='flex flex-wrap gap-1.5'>
            {[1, 2, 3, 4].map((index) => (
                <div className='h-6 w-28 rounded-full bg-surface-secondary/80' key={index} />
            ))}
        </div>
        <div className='rounded border border-border/70 bg-surface-secondary/60 p-3'>
            {[1, 2, 3].map((index) => (
                <div className='mb-2 flex items-center gap-2' key={index}>
                    <div className='h-3 w-1/3 rounded bg-surface' />
                    <div className='h-3 w-10 rounded bg-surface' />
                    <div className='h-3 w-14 rounded bg-surface' />
                    <div className='h-3 w-10 rounded bg-surface' />
                </div>
            ))}
        </div>
    </div>
);

/** One small stat, matching the Archon Intelligence tile. */
const Stat = ({ label, value, tone }) => (
    <div className='rounded-md border border-border/70 bg-surface-secondary/50 p-2.5'>
        <div className='text-[11px] uppercase tracking-wide text-muted'>{label}</div>
        <div
            className={[
                'text-lg font-semibold',
                tone === 'good' ? 'text-emerald-300' : '',
                tone === 'bad' ? 'text-red-300' : '',
                !tone ? 'text-foreground' : ''
            ].join(' ')}
        >
            {value}
        </div>
    </div>
);

Stat.propTypes = { label: PropTypes.node, value: PropTypes.node, tone: PropTypes.string };

/**
 * The verdict cell. The decision is made on the server (`hiddenGem`,
 * `confident`, `delta`) - this only maps it to pixels, so the threshold for
 * "gem" lives in exactly one testable place.
 */
const Verdict = ({ deck, t }) => {
    if (!deck.confident) {
        return <span className='text-xs text-muted'>{t('Still proving')}</span>;
    }

    if (deck.hiddenGem) {
        return (
            <span className='inline-flex items-center rounded-full border border-violet-500/40 bg-violet-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-300'>
                {t('Hidden gem')}
            </span>
        );
    }

    if (deck.delta !== null && deck.delta !== undefined) {
        if (deck.delta >= 0.05) {
            return <span className='text-xs text-emerald-300'>{t('Plays above its SAS')}</span>;
        }

        if (deck.delta <= -0.05) {
            return <span className='text-xs text-red-300'>{t('Plays below its SAS')}</span>;
        }
    }

    return <span className='text-xs text-muted'>{t('About as rated')}</span>;
};

Verdict.propTypes = { deck: PropTypes.object, t: PropTypes.func };

const ChampionsChallenge = () => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    const unlocked = hasCapability(user, CAPABILITIES.CHAMPIONS_CHALLENGE);
    const [actionError, setActionError] = useState(null);
    // ARCHON (N21): the randomizer's swap cadence, user-configurable.
    const [randomGames, setRandomGames] = useState(20);

    const { data, isFetching } = useGetChampionsChallengeQuery(undefined, {
        skip: !user || !unlocked
    });
    const [enroll, { isLoading: enrolling }] = useEnrollChampionsChallengeDeckMutation();
    const [enrollRandom, { isLoading: randomizing }] =
        useEnrollRandomChampionsChallengeDeckMutation();
    const [withdraw, { isLoading: withdrawing }] = useWithdrawChampionsChallengeDeckMutation();

    const busy = enrolling || withdrawing || randomizing;

    const change = async (mutation, deckId, fallback) => {
        setActionError(null);

        try {
            await mutation(deckId).unwrap();
        } catch (error) {
            setActionError(serverMessage(error, fallback));
        }
    };

    if (!user) {
        return (
            <div className='mx-auto max-w-5xl p-3'>
                <AlertPanel
                    type='info'
                    message={t(
                        'The Champion’s Challenge plays your decks against each other while you are away ' +
                            'and reports which ones outperform their ratings. Sign in to use it.'
                    )}
                />
                <div className='mt-3'>
                    <Link className='text-sm text-accent hover:underline' to='/membership'>
                        {t('See what the Champion’s Challenge does')}
                    </Link>
                </div>
            </div>
        );
    }

    const decks = data?.decks || [];
    const candidates = data?.candidates || [];
    const findings = data?.findings || [];
    const gems = decks.filter((deck) => deck.hiddenGem);
    const slots = data ? `${decks.length}/${data.maxEnrolled}` : null;
    const atCapacity = data ? decks.length >= data.maxEnrolled : false;

    return (
        <div className='mx-auto max-w-6xl space-y-3 p-3'>
            <Panel type='default' compactHeader title={t('Champion’s Challenge')}>
                <p className='m-0 text-sm text-muted'>
                    {t(
                        'Automated deck testing, running while you are away: enroll decks and a ' +
                            'computer plays them against each other around the clock — practice ' +
                            'games on the real engine, never rated ones. The Challenge reports ' +
                            'each deck’s simulated record against what its SAS predicts, moves ' +
                            'its ARI with every game, and points out the hidden gems: decks that ' +
                            'keep beating their own rating.'
                    )}
                </p>
                <p className='m-0 pt-1.5 text-[11px] text-muted'>
                    {t(
                        'Nothing here touches Amber, your deck records or any leaderboard. The sparring ' +
                            'partner plays honestly but plainly, so read these as a floor for a deck, ' +
                            'not a ceiling.'
                    )}
                </p>
            </Panel>

            <PremiumLock
                capability={CAPABILITIES.CHAMPIONS_CHALLENGE}
                preview={<SampleGrounds />}
                minHeight={260}
            >
                <div className='space-y-3'>
                    {data && !data.running && (
                        <AlertPanel
                            type='warning'
                            message={t(
                                'The Champion’s Challenge is paused site-wide at the moment. Enrolled decks ' +
                                    'keep their results and play resumes when the lab is switched back on.'
                            )}
                        />
                    )}

                    {actionError && <AlertPanel type='error' message={actionError} />}

                    <Panel
                        type='default'
                        compactHeader
                        title={
                            slots
                                ? t('The roster ({{slots}} slots used)', { slots })
                                : t('The roster')
                        }
                    >
                        {decks.length > 0 && (
                            <div className='mb-2 flex flex-wrap gap-1.5'>
                                {decks.map((deck) => (
                                    <button
                                        className='group inline-flex items-center gap-1.5 rounded-full border border-amber-500/60 bg-amber-500/15 px-2.5 py-1 text-xs text-amber-200 transition hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-300'
                                        disabled={busy}
                                        key={deck.deckId}
                                        onClick={() =>
                                            change(
                                                withdraw,
                                                deck.deckId,
                                                t('That deck could not be withdrawn.')
                                            )
                                        }
                                        title={
                                            deck.random
                                                ? t(
                                                      'Randomizer slot — swaps for a fresh random deck after {{target}} games. Click to withdraw.',
                                                      { target: deck.randomGamesTarget }
                                                  )
                                                : t('Withdraw from the Champion’s Challenge')
                                        }
                                        type='button'
                                    >
                                        {deck.random && <span aria-hidden='true'>🎲</span>}
                                        {deck.name}
                                        {deck.random && deck.randomGamesTarget && (
                                            <span className='text-[10px] text-amber-300/80'>
                                                {Math.min(
                                                    deck.gamesSinceEnrolled,
                                                    deck.randomGamesTarget
                                                )}
                                                /{deck.randomGamesTarget}
                                            </span>
                                        )}
                                        <span aria-hidden='true'>×</span>
                                    </button>
                                ))}
                            </div>
                        )}

                        {/* ARCHON (N21): the randomizer - fill a slot with a
                            random eligible deck; it swaps itself for a fresh
                            one after the configured number of games. */}
                        <div className='mb-2 flex flex-wrap items-center gap-2'>
                            <button
                                className={[
                                    'rounded-full border border-dashed px-2.5 py-1 text-xs transition',
                                    'border-border/70 bg-surface-secondary/60 text-foreground hover:border-border',
                                    atCapacity || busy ? 'cursor-not-allowed opacity-40' : ''
                                ].join(' ')}
                                disabled={atCapacity || busy}
                                onClick={() =>
                                    change(
                                        enrollRandom,
                                        randomGames,
                                        t('No random deck could be enrolled.')
                                    )
                                }
                                type='button'
                            >
                                🎲 {t('Add a random deck')}
                            </button>
                            <label className='flex items-center gap-1.5 text-[11px] text-muted'>
                                {t('swap it out after')}
                                <input
                                    className='w-14 rounded border border-border/70 bg-surface-secondary/60 px-1.5 py-0.5 text-xs text-foreground'
                                    max={500}
                                    min={1}
                                    type='number'
                                    value={randomGames}
                                    onChange={(event) =>
                                        setRandomGames(
                                            Math.max(
                                                1,
                                                Math.min(
                                                    500,
                                                    parseInt(event.target.value, 10) || 20
                                                )
                                            )
                                        )
                                    }
                                />
                                {t('games')}
                            </label>
                        </div>

                        {candidates.length ? (
                            <>
                                <div className='mb-1 text-[10px] uppercase tracking-wide text-muted'>
                                    {t('Add a deck')}
                                </div>
                                <div className='flex flex-wrap gap-1.5'>
                                    {candidates.map((candidate) => (
                                        <button
                                            className={[
                                                'rounded-full border px-2.5 py-1 text-xs transition',
                                                'border-border/70 bg-surface-secondary/60 text-foreground hover:border-border',
                                                atCapacity || busy
                                                    ? 'cursor-not-allowed opacity-40'
                                                    : ''
                                            ].join(' ')}
                                            disabled={atCapacity || busy}
                                            key={candidate.deckId}
                                            onClick={() =>
                                                change(
                                                    enroll,
                                                    candidate.deckId,
                                                    t('That deck could not be enrolled.')
                                                )
                                            }
                                            type='button'
                                        >
                                            {candidate.name}
                                            <span className='ml-1.5 text-muted'>
                                                {candidate.sas
                                                    ? t('SAS {{sas}}', { sas: candidate.sas })
                                                    : t('SAS unknown')}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                                {atCapacity && (
                                    <p className='m-0 pt-1.5 text-[11px] text-muted'>
                                        {t(
                                            'All {{max}} slots are in use. Withdraw a deck to enroll another.',
                                            { max: data?.maxEnrolled }
                                        )}
                                    </p>
                                )}
                            </>
                        ) : (
                            !decks.length && (
                                <div className='text-sm text-muted'>
                                    {isFetching
                                        ? t('Loading…')
                                        : t(
                                              'No decks available to enroll. Import a deck with a SAS rating and it will be offered here.'
                                          )}
                                </div>
                            )
                        )}

                        {data && decks.length > 0 && (
                            <p className='m-0 pt-2 text-[11px] text-muted'>
                                {data.unlimited
                                    ? t(
                                          'Your decks are exempt from the daily cap (site admin). ' +
                                              '{{total}} games played so far, {{today}} today.',
                                          {
                                              total: data.totals?.games ?? 0,
                                              today: data.totals?.today ?? 0
                                          }
                                      )
                                    : t(
                                          'Each enrolled deck plays up to {{perDay}} games a day against the ' +
                                              'rest of your roster. {{total}} games played so far, {{today}} today.',
                                          {
                                              perDay: data.gamesPerDeckPerDay,
                                              total: data.totals?.games ?? 0,
                                              today: data.totals?.today ?? 0
                                          }
                                      )}
                                {data.bot && data.bot.championVersion > 0 && (
                                    <>
                                        {' '}
                                        {t(
                                            'Sparring partner: learned model v{{version}}, trained on ' +
                                                '{{games}} of its own games.',
                                            {
                                                version: data.bot.championVersion,
                                                games: data.bot.championTrainedGames
                                            }
                                        )}
                                    </>
                                )}
                            </p>
                        )}
                    </Panel>

                    {gems.length > 0 && (
                        <div className='grid gap-2 sm:grid-cols-2 lg:grid-cols-4'>
                            {gems.slice(0, 4).map((deck) => (
                                <Stat
                                    key={deck.deckId}
                                    label={t('Hidden gem')}
                                    tone='good'
                                    value={
                                        <span className='text-base'>
                                            {deck.name}{' '}
                                            <span className='text-xs font-normal text-muted'>
                                                {t('{{rate}} vs {{expected}} expected', {
                                                    rate: pct(deck.winRate),
                                                    expected: pct(deck.expectedWinRate)
                                                })}
                                            </span>
                                        </span>
                                    }
                                />
                            ))}
                        </div>
                    )}

                    <Panel type='default' compactHeader title={t('How they are proving out')}>
                        {isFetching && !data ? (
                            <div className='text-sm text-muted'>{t('Loading…')}</div>
                        ) : decks.length ? (
                            <div className='overflow-x-auto'>
                                <table className='w-full min-w-[640px] text-sm'>
                                    <thead>
                                        <tr className='border-b border-border/70 text-left text-xs uppercase tracking-wide text-muted'>
                                            <th className='py-1.5 pr-2 font-medium'>{t('Deck')}</th>
                                            <th className='py-1.5 pr-2 text-right font-medium'>
                                                {t('SAS')}
                                            </th>
                                            <th className='py-1.5 pr-2 text-right font-medium'>
                                                {t('ARI')}
                                            </th>
                                            <th className='py-1.5 pr-2 text-right font-medium'>
                                                {t('Record')}
                                            </th>
                                            <th className='py-1.5 pr-2 text-right font-medium'>
                                                {t('Win rate')}
                                            </th>
                                            <th className='py-1.5 pr-2 text-right font-medium'>
                                                {t('vs SAS')}
                                            </th>
                                            <th className='py-1.5 pr-2 font-medium'>
                                                {t('Verdict')}
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {decks.map((deck) => (
                                            <tr
                                                className='border-b border-border/40'
                                                key={deck.deckId}
                                            >
                                                <td className='py-1.5 pr-2 text-foreground'>
                                                    <div className='truncate font-medium'>
                                                        {deck.name}
                                                    </div>
                                                    {!deck.confident && (
                                                        <div className='text-[11px] text-amber-300'>
                                                            {t(
                                                                '{{games}} of {{min}} games for a usable sample',
                                                                {
                                                                    games: deck.games,
                                                                    min: data?.minConfidentGames
                                                                }
                                                            )}
                                                        </div>
                                                    )}
                                                </td>
                                                <td className='py-1.5 pr-2 text-right text-muted'>
                                                    {deck.sas ?? '—'}
                                                </td>
                                                <td className='py-1.5 pr-2 text-right font-medium text-accent'>
                                                    {deck.ari !== null && deck.ari !== undefined
                                                        ? Math.round(deck.ari)
                                                        : '—'}
                                                </td>
                                                <td className='py-1.5 pr-2 text-right text-foreground'>
                                                    {deck.wins}–{deck.losses}
                                                </td>
                                                <td className='py-1.5 pr-2 text-right text-foreground'>
                                                    {pct(deck.winRate)}
                                                </td>
                                                <td
                                                    className={[
                                                        'py-1.5 pr-2 text-right',
                                                        (deck.delta ?? 0) >= 0
                                                            ? 'text-emerald-300'
                                                            : 'text-red-300'
                                                    ].join(' ')}
                                                >
                                                    {deck.delta === null || deck.delta === undefined
                                                        ? '—'
                                                        : `${
                                                              deck.delta >= 0 ? '+' : ''
                                                          }${Math.round(deck.delta * 100)}%`}
                                                </td>
                                                <td className='py-1.5 pr-2'>
                                                    <Verdict deck={deck} t={t} />
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ) : (
                            <div className='p-3 text-sm text-muted'>
                                {t(
                                    'Nothing on the roster yet. Enroll a deck above and the computer starts ' +
                                        'playing it within the hour.'
                                )}
                            </div>
                        )}
                        {decks.length > 0 && (
                            <p className='m-0 pt-2 text-[11px] text-muted'>
                                {t(
                                    'ARI is the Archon Rating Index — the platform’s own deck rating, on ' +
                                        'the same scale as SAS. It starts where SAS and AERC point and ' +
                                        'then moves with results: every rated game the deck plays, and ' +
                                        'every sparring game here, nudges it up or down. It is the deck ' +
                                        'strength your Amber calculation actually uses. "vs SAS" is the ' +
                                        'deck’s win rate against what SAS predicted for the opponents it ' +
                                        'actually faced.'
                                )}
                            </p>
                        )}
                    </Panel>

                    {(data?.showcase?.length ?? 0) > 0 && (
                        <Panel
                            type='default'
                            compactHeader
                            title={t('Showcase games — the deep bot, thinking out loud')}
                        >
                            <div className='space-y-3'>
                                {data.showcase.map((game, gameIndex) => (
                                    <div
                                        className='rounded-md border border-border/70 bg-surface-secondary/40 p-2.5'
                                        key={gameIndex}
                                    >
                                        <div className='mb-1.5 text-sm font-medium text-foreground'>
                                            {t(
                                                '{{winner}} beat {{loser}} {{wk}}–{{lk}} in {{turns}} turns',
                                                {
                                                    winner: game.winner,
                                                    loser: game.loser,
                                                    wk: game.winnerKeys,
                                                    lk: game.loserKeys,
                                                    turns: game.turns
                                                }
                                            )}
                                        </div>
                                        <ul className='m-0 list-none space-y-1 p-0'>
                                            {(game.annotations || []).map(
                                                (annotation, annotationIndex) => (
                                                    <li
                                                        className='text-xs text-muted'
                                                        key={annotationIndex}
                                                    >
                                                        <span className='text-foreground'>
                                                            {t('Turn {{turn}}:', {
                                                                turn: annotation.turn
                                                            })}
                                                        </span>{' '}
                                                        {annotation.chosen}
                                                        {annotation.winProb !== null &&
                                                            annotation.winProb !== undefined && (
                                                                <span>
                                                                    {' '}
                                                                    (
                                                                    {Math.round(
                                                                        annotation.winProb * 100
                                                                    )}
                                                                    % {t('to win')})
                                                                </span>
                                                            )}
                                                        {annotation.turningPoint && (
                                                            <span className='ml-1.5 inline-flex items-center rounded-full border border-violet-500/40 bg-violet-500/15 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-violet-300'>
                                                                {t('the game turned here')}
                                                            </span>
                                                        )}
                                                    </li>
                                                )
                                            )}
                                        </ul>
                                    </div>
                                ))}
                            </div>
                            <p className='m-0 pt-2 text-[11px] text-muted'>
                                {t(
                                    'A few games a day are played by the deep bot: at the decisions ' +
                                        'that matter it forks the live game, plays each option out with ' +
                                        'the cards’ real abilities, and keeps the road with the best ' +
                                        'odds — then shows its working here.'
                                )}
                            </p>
                        </Panel>
                    )}

                    {decks.some((deck) => deck.games > 0) && (
                        <Panel type='default' compactHeader title={t('What wins games')}>
                            {findings.length ? (
                                <ul className='m-0 list-none space-y-1.5 p-0'>
                                    {findings.map((finding, index) => (
                                        <li className='text-sm text-foreground' key={index}>
                                            <span className='mr-1.5 text-accent'>▸</span>
                                            {finding.text}
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <div className='text-sm text-muted'>
                                    {t(
                                        'Findings appear once a deck has enough games behind it — which ' +
                                            'house to call first, and where each deck’s wins actually ' +
                                            'come from.'
                                    )}
                                </div>
                            )}
                        </Panel>
                    )}
                </div>
            </PremiumLock>
        </div>
    );
};

ChampionsChallenge.displayName = 'ChampionsChallenge';

export default ChampionsChallenge;
