import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';
import { Link } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import AlertPanel from '../Components/Site/AlertPanel';
import PremiumLock from '../Components/Membership/PremiumLock';
import SetFilter from '../Components/Site/SetFilter';
import { CAPABILITIES, hasCapability } from '../membership';
// The endpoint keeps its working name - the API path is a contract the
// released phone builds also call.
import { useGetTournamentLabQuery } from '../redux/api';

/**
 * ARCHON (N12): the Deep Probe.
 *
 * "Which of my decks should I bring?" - answered from the player's own results
 * rather than from a rating anybody could look up. Pick up to four decks, see
 * them side by side on record, rating swing, recent form and matchups, with the
 * current meta underneath so the matchup columns mean something.
 *
 * Two deliberate refusals:
 *
 *  - No recommendation. The Lab does not say "bring this one". It lays the
 *    evidence out and lets the player weigh it, because the thing it cannot
 *    know - who is going to be at this event - is usually the deciding factor.
 *  - No confident-looking numbers over tiny samples. A deck under the game
 *    threshold is shown with its record AND a warning, rather than being
 *    silently ranked next to a deck with forty games.
 *
 * The set filter is the first thing on the page rather than a refinement,
 * because most events restrict which sets may be brought and a comparison that
 * includes decks the player cannot legally register is not a weaker answer - it
 * is the wrong one. Scoped to a set, everything downstream narrows with it: the
 * candidates, and the meta panel describing the field they would meet.
 */

const MAX_SELECTED = 4;

const pct = (value) =>
    value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
const signed = (value) =>
    value === null || value === undefined ? '—' : `${value >= 0 ? '+' : ''}${Math.round(value)}`;

/** Recent results as a W/L strip, newest last so it reads left to right. */
const FormStrip = ({ results }) => (
    <div className='flex flex-wrap gap-0.5'>
        {[...results].reverse().map((result, index) => (
            <span
                className={[
                    'inline-flex h-4 w-4 items-center justify-center rounded-[3px] text-[9px] font-bold',
                    result.won ? 'bg-emerald-500/25 text-emerald-300' : 'bg-red-500/25 text-red-300'
                ].join(' ')}
                key={index}
                title={new Date(result.at).toLocaleDateString()}
            >
                {result.won ? 'W' : 'L'}
            </span>
        ))}
        {!results.length && <span className='text-xs text-muted'>—</span>}
    </div>
);

FormStrip.propTypes = { results: PropTypes.array };

const SampleLab = () => (
    <div className='grid gap-2 p-3 sm:grid-cols-3'>
        {[1, 2, 3].map((index) => (
            <div
                className='rounded border border-border/70 bg-surface-secondary/60 p-3'
                key={index}
            >
                <div className='mb-2 h-3 w-2/3 rounded bg-surface' />
                <div className='mb-1 h-6 w-1/2 rounded bg-surface' />
                <div className='mb-1 h-2 w-full rounded bg-surface' />
                <div className='h-2 w-4/5 rounded bg-surface' />
            </div>
        ))}
    </div>
);

const DeckColumn = ({ deck, t }) => (
    <div className='flex flex-col rounded-md border border-border/70 bg-surface-secondary/50 p-3'>
        <div className='mb-2'>
            <div className='truncate text-sm font-semibold text-foreground'>{deck.deckName}</div>
            <div className='text-[11px] text-muted'>
                {deck.set?.name ? `${deck.set.name} · ` : ''}
                {deck.sas ? t('SAS {{sas}}', { sas: deck.sas }) : t('SAS unknown')}
            </div>
        </div>

        <div className='mb-2 grid grid-cols-2 gap-2'>
            <div>
                <div className='text-[10px] uppercase tracking-wide text-muted'>{t('Record')}</div>
                <div className='text-base font-semibold text-foreground'>
                    {deck.overview.wins ?? 0}–{deck.overview.losses ?? 0}
                </div>
            </div>
            <div>
                <div className='text-[10px] uppercase tracking-wide text-muted'>
                    {t('Win rate')}
                </div>
                <div className='text-base font-semibold text-foreground'>
                    {pct(deck.overview.winRate)}
                </div>
            </div>
            <div>
                <div className='text-[10px] uppercase tracking-wide text-muted'>
                    {t('Rating swing')}
                </div>
                <div
                    className={[
                        'text-base font-semibold',
                        (deck.rating?.netSwing ?? 0) >= 0 ? 'text-emerald-300' : 'text-red-300'
                    ].join(' ')}
                >
                    {deck.rating?.available ? signed(deck.rating.netSwing) : '—'}
                </div>
            </div>
            <div>
                <div className='text-[10px] uppercase tracking-wide text-muted'>
                    {t('vs expected')}
                </div>
                <div
                    className={[
                        'text-base font-semibold',
                        (deck.rating?.vsExpectation ?? 0) >= 0 ? 'text-emerald-300' : 'text-red-300'
                    ].join(' ')}
                >
                    {deck.rating?.available && deck.rating.vsExpectation !== null
                        ? `${
                              deck.rating.vsExpectation >= 0 ? '+' : ''
                          }${deck.rating.vsExpectation.toFixed(1)}`
                        : '—'}
                </div>
            </div>
        </div>

        <div className='mb-2'>
            <div className='mb-1 text-[10px] uppercase tracking-wide text-muted'>
                {t('Recent form')}
            </div>
            <FormStrip results={deck.form?.results || []} />
        </div>

        {!!deck.bestMatchups?.length && (
            <div className='mb-1.5'>
                <div className='text-[10px] uppercase tracking-wide text-muted'>
                    {t('Strong against')}
                </div>
                <div className='text-xs text-emerald-300'>
                    {deck.bestMatchups
                        .map((row) => `${row.houseName || row.house} ${pct(row.winRate)}`)
                        .join(', ')}
                </div>
            </div>
        )}

        {!!deck.worstMatchups?.length && (
            <div className='mb-1.5'>
                <div className='text-[10px] uppercase tracking-wide text-muted'>
                    {t('Struggles against')}
                </div>
                <div className='text-xs text-red-300'>
                    {deck.worstMatchups
                        .map((row) => `${row.houseName || row.house} ${pct(row.winRate)}`)
                        .join(', ')}
                </div>
            </div>
        )}

        {!!deck.vsScopedSets?.length && (
            <div className='mb-1.5'>
                <div className='text-[10px] uppercase tracking-wide text-muted'>
                    {t('Against the sets in play')}
                </div>
                <div className='text-xs text-foreground'>
                    {deck.vsScopedSets
                        .map((row) => `${row.set?.code || '—'} ${pct(row.winRate)} (${row.games}g)`)
                        .join(', ')}
                </div>
            </div>
        )}

        {!deck.confident && (
            <div className='mt-auto rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300'>
                {t('Only {{games}} games — too few to lean on. {{min}}+ is a usable sample.', {
                    games: deck.overview.games || 0,
                    min: deck.minConfidentGames
                })}
            </div>
        )}
    </div>
);

DeckColumn.propTypes = { deck: PropTypes.object, t: PropTypes.func };

const DeepProbe = () => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    const unlocked = hasCapability(user, CAPABILITIES.TOURNAMENT_LAB);
    const [selected, setSelected] = useState([]);
    const [sets, setSets] = useState([]);

    const { data, isFetching } = useGetTournamentLabQuery(
        { decks: selected, sets },
        { skip: !user || !unlocked }
    );

    const toggle = (deckId) =>
        setSelected((current) =>
            current.includes(deckId)
                ? current.filter((id) => id !== deckId)
                : current.length >= MAX_SELECTED
                ? current
                : [...current, deckId]
        );

    /**
     * Narrowing the sets can strand a selected deck outside the filter, and
     * leaving it selected would quietly compare a deck that is now illegal.
     * Dropping it is the honest behaviour, so the selection always means "decks
     * I could actually bring".
     */
    const changeSets = (next) => {
        setSets(next);

        if (next.length) {
            const legal = new Set(
                (data?.candidates || [])
                    .filter((candidate) => candidate.set && next.includes(candidate.set.id))
                    .map((candidate) => candidate.deckId)
            );

            setSelected((current) => current.filter((deckId) => legal.has(deckId)));
        }
    };

    if (!user) {
        return (
            <div className='mx-auto max-w-5xl p-3'>
                <AlertPanel
                    type='info'
                    message={t(
                        'The Deep Probe compares your own decks using your own results. Sign in to use it.'
                    )}
                />
                <div className='mt-3'>
                    <Link className='text-sm text-accent hover:underline' to='/membership'>
                        {t('See what the Deep Probe does')}
                    </Link>
                </div>
            </div>
        );
    }

    const candidates = data?.candidates || [];
    const decks = data?.decks || [];
    const scoping = data?.scoping;

    return (
        <div className='mx-auto max-w-6xl space-y-3 p-3'>
            <Panel type='default' compactHeader title={t('Deep Probe')}>
                <p className='m-0 text-sm text-muted'>
                    {t(
                        'Which of your decks should you bring? Pick up to {{max}} and compare them on ' +
                            'what they have actually done for you — record, rating swing, recent form ' +
                            'and matchups.',
                        { max: MAX_SELECTED }
                    )}
                </p>
            </Panel>

            <PremiumLock
                capability={CAPABILITIES.TOURNAMENT_LAB}
                preview={<SampleLab />}
                minHeight={260}
            >
                <div className='space-y-3'>
                    <Panel
                        type='default'
                        compactHeader
                        title={t('Which sets does the event allow?')}
                    >
                        <SetFilter
                            hint={
                                scoping?.tournament
                                    ? t('Scoped to {{event}}.', { event: scoping.tournament.name })
                                    : sets.length
                                    ? t(
                                          'Only decks from these sets are offered below, and the field ' +
                                              'is measured in the same sets.'
                                      )
                                    : t(
                                          'Most events restrict this. Set it to match, and only decks ' +
                                              'you could actually register are offered.'
                                      )
                            }
                            selected={sets}
                            t={t}
                            onChange={changeSets}
                        />
                        {scoping?.tournamentAllowsAllSets && (
                            <p className='m-0 pt-1.5 text-[11px] text-muted'>
                                {t('That event does not restrict sets, so nothing was filtered.')}
                            </p>
                        )}
                    </Panel>

                    <Panel type='default' compactHeader title={t('Choose decks')}>
                        {candidates.length ? (
                            <div className='flex flex-wrap gap-1.5'>
                                {candidates.map((candidate) => {
                                    const isOn = selected.includes(candidate.deckId);
                                    const atLimit = !isOn && selected.length >= MAX_SELECTED;

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
                                            key={candidate.deckId}
                                            onClick={() => toggle(candidate.deckId)}
                                            type='button'
                                        >
                                            {candidate.deckName}
                                            <span className='ml-1.5 text-muted'>
                                                {candidate.set?.code
                                                    ? `${candidate.set.code} · `
                                                    : ''}
                                                {candidate.games}g · {pct(candidate.winRate)}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className='text-sm text-muted'>
                                {sets.length
                                    ? t(
                                          'You have no played decks from those sets. Widen the set ' +
                                              'filter, or play a game with one you would bring.'
                                      )
                                    : t(
                                          'No decks with recorded games yet. Play some games and your decks appear here.'
                                      )}
                            </div>
                        )}
                        {selected.length > 0 && (
                            <div className='mt-2'>
                                <HeroButton
                                    size='sm'
                                    variant='tertiary'
                                    onPress={() => setSelected([])}
                                >
                                    {t('Clear selection')}
                                </HeroButton>
                            </div>
                        )}
                    </Panel>

                    {isFetching && <div className='text-sm text-muted'>{t('Comparing…')}</div>}

                    {/* The side-by-side grid IS the deck_comparison promise, so
                        it is gated on that capability rather than only on
                        TOURNAMENT_LAB. Both are Archon today, so nothing
                        changes for anyone - but the promise is now enforced
                        where it is delivered, instead of being advertised with
                        nothing checking it. */}
                    {decks.length > 0 && hasCapability(user, CAPABILITIES.DECK_COMPARISON) && (
                        <div
                            className='grid gap-2'
                            style={{
                                gridTemplateColumns: `repeat(auto-fit, minmax(200px, 1fr))`
                            }}
                        >
                            {decks.map((deck) => (
                                <DeckColumn deck={deck} key={deck.deckId} t={t} />
                            ))}
                        </div>
                    )}

                    {decks.length > 0 && data?.meta?.available && (
                        <Panel
                            type='default'
                            compactHeader
                            title={t('What you would be walking into')}
                        >
                            <div className='space-y-1.5'>
                                {data.meta.rows.slice(0, 7).map((row) => (
                                    <div
                                        className='flex items-center gap-2 text-xs'
                                        key={row.house}
                                    >
                                        <div className='w-28 shrink-0 truncate text-foreground'>
                                            {row.houseName || row.house}
                                        </div>
                                        <div className='h-2 flex-1 overflow-hidden rounded bg-surface-secondary'>
                                            <div
                                                className='h-full bg-accent/60'
                                                style={{
                                                    width: `${Math.round(
                                                        (row.prevalence ?? 0) * 100 * 3
                                                    )}%`
                                                }}
                                            />
                                        </div>
                                        <div className='w-14 shrink-0 text-right text-muted'>
                                            {pct(row.prevalence)}
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <p className='m-0 pt-2 text-[11px] text-muted'>
                                {sets.length
                                    ? t(
                                          'Share of house slots across the last 30 days, counting only ' +
                                              'games played in the sets above — the field of this ' +
                                              'format rather than the field at large. Every deck ' +
                                              'contributes three houses, so these sum to 300%.'
                                      )
                                    : t(
                                          'Share of house slots played across the last 30 days. Every deck ' +
                                              'contributes three, so these sum to 300%.'
                                      )}
                            </p>
                        </Panel>
                    )}

                    {!selected.length && candidates.length > 0 && (
                        <div className='rounded border border-dashed border-border/70 p-6 text-center text-sm text-muted'>
                            {t('Pick a deck above to start comparing.')}
                        </div>
                    )}
                </div>
            </PremiumLock>
        </div>
    );
};

DeepProbe.displayName = 'DeepProbe';

export default DeepProbe;
