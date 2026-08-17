import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import AlertPanel from '../Components/Site/AlertPanel';
import PremiumLock from '../Components/Membership/PremiumLock';
import { CAPABILITIES, hasCapability } from '../membership';
import { Constants } from '../constants';
import {
    useGetChampionsChallengeQuery,
    useEnrollChampionsChallengeDeckMutation,
    useEnrollRandomChampionsChallengeDeckMutation,
    useEnrollVaultTourDeckMutation,
    useSaveChampionsChallengeGauntletMutation,
    useWithdrawChampionsChallengeDeckMutation,
    useWithdrawVaultTourDeckMutation
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

/** A togglable filter chip, used for sets, houses and strategies. */
const Chip = ({ active, children, disabled, onClick, title }) => (
    <button
        className={[
            'rounded-full border px-2.5 py-1 text-xs transition',
            active
                ? 'border-accent/60 bg-accent/20 text-amber-200'
                : 'border-border/70 bg-surface-secondary/60 text-foreground hover:border-border',
            disabled ? 'cursor-not-allowed opacity-40' : ''
        ].join(' ')}
        disabled={disabled}
        onClick={onClick}
        title={title}
        type='button'
    >
        {children}
    </button>
);

Chip.propTypes = {
    active: PropTypes.bool,
    children: PropTypes.node,
    disabled: PropTypes.bool,
    onClick: PropTypes.func,
    title: PropTypes.string
};

/**
 * ARCHON (N24): the Gauntlet panel - play the field, and choose which field.
 *
 * The honest bit is the pool line. Set and house filters are exact, because the
 * catalog knows those; a SAS window or a strategy can only match decks whose
 * Decks of KeyForge stats have been fetched, so this says how many decks the
 * current filters actually reach rather than letting a member wonder why every
 * game is still a mirror.
 */
const GauntletPanel = ({ gauntlet, onSave, saving, t }) => {
    const [draft, setDraft] = useState(null);
    const current = draft || {
        enabled: !!gauntlet?.enabled,
        fieldSharePct: gauntlet?.fieldSharePct ?? 50,
        sets: gauntlet?.sets || [],
        houses: gauntlet?.houses || [],
        strategies: gauntlet?.strategies || [],
        minSas: gauntlet?.minSas ?? '',
        maxSas: gauntlet?.maxSas ?? ''
    };
    const pool = gauntlet?.pool;
    const set = (changes) => setDraft({ ...current, ...changes });
    const toggle = (key, value) =>
        set({
            [key]: current[key].includes(value)
                ? current[key].filter((entry) => entry !== value)
                : [...current[key], value]
        });

    return (
        <Panel type='default' compactHeader title={t('The Gauntlet — play the field')}>
            <p className='m-0 pb-2 text-sm text-muted'>
                {t(
                    'Sparring against your own decks measures a deck against the company it ' +
                        'keeps. The Gauntlet plays it against decks nobody here owns — real ' +
                        'registered decks drawn from the Master Vault catalog, never yours and ' +
                        'never a friend’s. Results are reported separately, because beating your ' +
                        'collection and beating the world are different claims.'
                )}
            </p>

            <div className='flex flex-wrap items-center gap-3 pb-2'>
                <Chip active={current.enabled} onClick={() => set({ enabled: !current.enabled })}>
                    {current.enabled ? t('⚔ Playing the field') : t('Play the field')}
                </Chip>
                <label className='flex items-center gap-1.5 text-[11px] text-muted'>
                    {t('share of games')}
                    <input
                        className='w-16 rounded border border-border/70 bg-surface-secondary/60 px-1.5 py-0.5 text-xs text-foreground'
                        max={100}
                        min={0}
                        type='number'
                        value={current.fieldSharePct}
                        onChange={(event) =>
                            set({
                                fieldSharePct: Math.max(
                                    0,
                                    Math.min(100, parseInt(event.target.value, 10) || 0)
                                )
                            })
                        }
                    />
                    %
                </label>
                <label className='flex items-center gap-1.5 text-[11px] text-muted'>
                    {t('opponent SAS')}
                    <input
                        className='w-14 rounded border border-border/70 bg-surface-secondary/60 px-1.5 py-0.5 text-xs text-foreground'
                        min={0}
                        placeholder={t('min')}
                        type='number'
                        value={current.minSas}
                        onChange={(event) => set({ minSas: event.target.value })}
                    />
                    <span>–</span>
                    <input
                        className='w-14 rounded border border-border/70 bg-surface-secondary/60 px-1.5 py-0.5 text-xs text-foreground'
                        min={0}
                        placeholder={t('max')}
                        type='number'
                        value={current.maxSas}
                        onChange={(event) => set({ maxSas: event.target.value })}
                    />
                </label>
            </div>

            <div className='pb-2'>
                <div className='mb-1 text-[10px] uppercase tracking-wide text-muted'>
                    {t('Sets — any, unless you pick some')}
                </div>
                <div className='flex flex-wrap gap-1.5'>
                    {Constants.Expansions.map((expansion) => (
                        <Chip
                            active={current.sets.includes(Number(expansion.value))}
                            key={expansion.value}
                            onClick={() => toggle('sets', Number(expansion.value))}
                        >
                            {expansion.label}
                        </Chip>
                    ))}
                </div>
            </div>

            <div className='pb-2'>
                <div className='mb-1 text-[10px] uppercase tracking-wide text-muted'>
                    {t('Houses the opponent must contain')}
                </div>
                <div className='flex flex-wrap gap-1.5'>
                    {Constants.Houses.map((house, index) => (
                        <Chip
                            active={current.houses.includes(house)}
                            key={house}
                            onClick={() => toggle('houses', house)}
                        >
                            {Constants.HousesNames[index]}
                        </Chip>
                    ))}
                </div>
            </div>

            <div className='pb-2'>
                <div className='mb-1 text-[10px] uppercase tracking-wide text-muted'>
                    {t('Strategies — what the opponent should be good at')}
                </div>
                <div className='flex flex-wrap gap-1.5'>
                    {/* The menu comes from `strategyOptions`; `strategies` is
                        this member's choice. They were once the same field, so
                        the chips compared a list of objects against a key and
                        nothing was ever shown as chosen. */}
                    {(gauntlet?.strategyOptions || []).map((strategy) => (
                        <Chip
                            active={current.strategies.includes(strategy.key)}
                            key={strategy.key}
                            onClick={() => toggle('strategies', strategy.key)}
                            title={strategy.description}
                        >
                            {strategy.label}
                        </Chip>
                    ))}
                </div>
            </div>

            <div className='flex flex-wrap items-center gap-3'>
                <button
                    className={[
                        'rounded-md border border-accent/60 bg-accent/20 px-3 py-1 text-xs text-amber-200 transition',
                        saving || !draft ? 'cursor-not-allowed opacity-40' : 'hover:bg-accent/30'
                    ].join(' ')}
                    disabled={saving || !draft}
                    onClick={() =>
                        onSave({
                            ...current,
                            minSas: current.minSas === '' ? null : current.minSas,
                            maxSas: current.maxSas === '' ? null : current.maxSas
                        }).then(() => setDraft(null))
                    }
                    type='button'
                >
                    {saving ? t('Saving…') : t('Save Gauntlet settings')}
                </button>
                {pool && (
                    <span className='text-[11px] text-muted'>
                        {t('{{matching}} of {{playable}} pool decks match your filters.', {
                            matching: pool.matching,
                            playable: pool.playable
                        })}
                        {pool.needsEnrichment && (
                            <>
                                {' '}
                                {t(
                                    'A SAS window can only match decks whose SAS has been ' +
                                        'fetched from Decks of KeyForge, so this number grows as ' +
                                        'the pool is enriched.'
                                )}
                            </>
                        )}
                        {/* ARCHON (N30): strategies are read from the deck's own
                            cards now, so they reach the whole pool - but the
                            reading is a coarse one and the panel says so rather
                            than implying an archetype classifier. */}
                        {pool.usesProfiles && (
                            <>
                                {' '}
                                {t(
                                    'Strategies are read from each deck’s own cards, so they ' +
                                        'reach the whole pool — it is a rough reading of what a ' +
                                        'deck is built to do, not a verdict on how good it is.'
                                )}
                            </>
                        )}
                        {/* ARCHON (N29): which kind of empty this is. "Still being
                            built" is true of a pool that is filling and false of
                            one that never will - and the field is drawn from a
                            Master Vault crawl that ships switched off, so on a
                            default install the honest answer is that no amount of
                            waiting produces an opponent. */}
                        {!pool.playable && (
                            <>
                                {' '}
                                {pool.catalogEmpty
                                    ? t(
                                          'There is no field to draw from yet: this server is not ' +
                                              'indexing Master Vault decks, so no opponents are ' +
                                              'on the way. An admin can turn the deck catalog on.'
                                      )
                                    : t(
                                          'The pool is still being built — the site fetches ' +
                                              'catalog decks a few at a time so Master Vault is ' +
                                              'not hammered.'
                                      )}
                            </>
                        )}
                    </span>
                )}
            </div>

            {gauntlet?.recent?.length ? (
                <div className='mt-3 border-t border-border/50 pt-2'>
                    <div className='mb-1 text-[10px] uppercase tracking-wide text-muted'>
                        {t('Latest field games')}
                    </div>
                    <ul className='m-0 list-none space-y-0.5 p-0 text-[11px]'>
                        {gauntlet.recent.map((game, index) => (
                            <li key={index} className='text-muted'>
                                <span
                                    className={
                                        game.won
                                            ? 'font-semibold text-emerald-300'
                                            : 'font-semibold text-red-300'
                                    }
                                >
                                    {game.won ? t('Won') : t('Lost')}
                                </span>{' '}
                                {t('{{keys}}–{{oppKeys}} · {{deck}} vs {{opponent}}', {
                                    keys: game.myKeys,
                                    oppKeys: game.opponentKeys,
                                    deck: game.deckName || t('a deck'),
                                    opponent: game.opponentName
                                })}
                                {game.opponentSas
                                    ? ` ${t('(SAS {{sas}})', { sas: game.opponentSas })}`
                                    : ''}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </Panel>
    );
};

GauntletPanel.propTypes = {
    gauntlet: PropTypes.object,
    onSave: PropTypes.func,
    saving: PropTypes.bool,
    t: PropTypes.func
};

/**
 * ARCHON (N26): which of your decks beats which.
 *
 * The mirror lab has been playing every pair on the roster against each other
 * since N18 and nothing ever showed the result. Rows are the deck, columns the
 * opponent; a cell too thin to mean anything is left blank rather than coloured,
 * the same rule the house-matchup matrix on the stats page follows.
 */
const MatchupMatrix = ({ matchups, t }) => {
    const decks = (matchups?.decks || []).filter((deck) =>
        Object.keys(matchups.cells || {}).some((key) => key.startsWith(`${deck.deckId}|`))
    );

    if (decks.length < 2) {
        return null;
    }

    const cellClass = (cell) => {
        if (!cell || !cell.confident || cell.winRate == null) {
            return 'text-muted';
        }

        if (cell.winRate >= 0.6) {
            return 'bg-emerald-500/20 text-emerald-200';
        }

        if (cell.winRate <= 0.4) {
            return 'bg-red-500/20 text-red-200';
        }

        return 'text-foreground';
    };

    return (
        <Panel type='default' compactHeader title={t('Your decks against each other')}>
            <p className='m-0 pb-2 text-[11px] text-muted'>
                {t(
                    'How the row deck does against the column deck in sparring. Pairs with fewer ' +
                        'than {{min}} games between them are left blank.',
                    { min: matchups.minGames }
                )}
            </p>
            <div className='overflow-x-auto'>
                <table className='w-full border-collapse text-sm'>
                    <thead>
                        <tr className='text-xs uppercase tracking-wide text-muted'>
                            <th className='px-2 py-1 text-left'>{t('vs')}</th>
                            {decks.map((deck) => (
                                <th className='px-2 py-1 text-center' key={deck.deckId}>
                                    <span className='block max-w-24 truncate' title={deck.name}>
                                        {deck.name}
                                    </span>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {decks.map((row) => (
                            <tr className='border-b border-border/40' key={row.deckId}>
                                <td
                                    className='max-w-32 truncate px-2 py-1.5 text-foreground'
                                    title={row.name}
                                >
                                    {row.name}
                                </td>
                                {decks.map((column) => {
                                    const cell =
                                        row.deckId === column.deckId
                                            ? null
                                            : matchups.cells[`${row.deckId}|${column.deckId}`];

                                    return (
                                        <td
                                            className={`px-2 py-1.5 text-center ${cellClass(cell)}`}
                                            key={column.deckId}
                                            title={
                                                cell
                                                    ? t('{{wins}}-{{losses}}', {
                                                          wins: cell.wins,
                                                          losses: cell.games - cell.wins
                                                      })
                                                    : undefined
                                            }
                                        >
                                            {row.deckId === column.deckId
                                                ? '—'
                                                : !cell || !cell.confident
                                                ? '·'
                                                : pct(cell.winRate)}
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

MatchupMatrix.propTypes = { matchups: PropTypes.object, t: PropTypes.func };

/**
 * ARCHON (N26): what the bot has learned about the cards in your deck.
 *
 * Not a card's power level in the abstract - what having played it has been worth
 * across the games this site has actually played, read from the learned model's
 * per-card weights. Weights arrive already shrunk by how often the model has
 * seen each card, and cards it has barely seen are dropped upstream rather than
 * listed at nearly zero.
 */
const CardContribution = ({ cards, t }) => {
    if (!cards || !cards.best?.length) {
        return null;
    }

    const row = (entry, tone) => (
        <li className='flex items-baseline justify-between gap-2 text-sm' key={entry.cardId}>
            <span className='truncate text-foreground'>
                {entry.name}
                {entry.copies > 1 && <span className='text-muted'> ×{entry.copies}</span>}
            </span>
            <span className={tone} title={t('{{games}} games seen', { games: entry.games })}>
                {entry.weight > 0 ? '+' : ''}
                {entry.weight.toFixed(2)}
            </span>
        </li>
    );

    return (
        <Panel
            type='default'
            compactHeader
            title={t('What the bot makes of {{deck}}', { deck: cards.deckName })}
        >
            <div className='grid gap-3 sm:grid-cols-2'>
                <div>
                    <div className='mb-1 text-[10px] uppercase tracking-wide text-muted'>
                        {t('Pulling their weight')}
                    </div>
                    <ul className='m-0 list-none space-y-0.5 p-0'>
                        {cards.best.map((entry) => row(entry, 'text-emerald-300'))}
                    </ul>
                </div>
                {cards.worst?.length > 0 && (
                    <div>
                        <div className='mb-1 text-[10px] uppercase tracking-wide text-muted'>
                            {t('Doing least')}
                        </div>
                        <ul className='m-0 list-none space-y-0.5 p-0'>
                            {cards.worst.map((entry) => row(entry, 'text-red-300'))}
                        </ul>
                    </div>
                )}
            </div>
            <p className='m-0 pt-2 text-[11px] text-muted'>
                {t(
                    'Learned by the sparring model (v{{version}}) from playing these cards, not ' +
                        'from anybody’s opinion of them. Cards it has seen too few times to have ' +
                        'a view on are left out.',
                    { version: cards.modelVersion }
                )}
            </p>
        </Panel>
    );
};

CardContribution.propTypes = { cards: PropTypes.object, t: PropTypes.func };

/**
 * ARCHON (N26): the champion's line of succession.
 *
 * Every promotion had to beat the champion before it under a sequential test, so
 * this list IS the improvement, in order - the one thing that turns "the bot is
 * learning" into a claim a member can check.
 */
const StrengthCurve = ({ curve, t }) => {
    const promoted = (curve || []).filter((entry) => entry.promotedAt);

    if (promoted.length < 1) {
        return null;
    }

    return (
        <Panel type='default' compactHeader title={t('The sparring partner’s history')}>
            <ul className='m-0 list-none space-y-1 p-0 text-sm'>
                {promoted
                    .slice()
                    .reverse()
                    .map((entry) => (
                        <li className='flex flex-wrap items-baseline gap-2' key={entry.version}>
                            <span className='font-semibold text-foreground'>
                                {t('v{{version}}', { version: entry.version })}
                            </span>
                            <span className='text-muted'>
                                {t('took the title {{record}}, trained on {{games}} games', {
                                    record: `${entry.arenaWins}–${entry.arenaLosses}`,
                                    games: (entry.trainedGames || 0).toLocaleString()
                                })}
                            </span>
                            {entry.status === 'champion' && (
                                <span className='rounded-full border border-accent/50 bg-accent/15 px-1.5 text-[10px] uppercase tracking-wide text-amber-200'>
                                    {t('current')}
                                </span>
                            )}
                        </li>
                    ))}
            </ul>
            <p className='m-0 pt-2 text-[11px] text-muted'>
                {t(
                    'Each version had to beat the one before it head to head, on neutral decks, ' +
                        'by enough that a sequential test called it real — so the list only ever ' +
                        'goes one way.'
                )}
            </p>
        </Panel>
    );
};

StrengthCurve.propTypes = { curve: PropTypes.array, t: PropTypes.func };

/**
 * ARCHON (N28): the three pilots, and what each of them makes of your decks.
 *
 * Every sparring game used to be flown by one policy, so a deck's win rate meant
 * "how this deck does against this bot" - and a deck that happened to punish that
 * bot's habits carried a rating saying it was strong, with nothing on the page
 * able to show it. Three styles now rotate, which is what makes the overall rate
 * an average rather than a measurement against one opponent.
 *
 * The interesting number here is the SPREAD. A deck that wins under the Racer and
 * loses under the Bruiser is a deck whose result depends on what the opponent is
 * trying to do; one overall percentage cannot say that, and would read as
 * moderate either way.
 *
 * The ladder beneath is the honesty check: a style is the champion pulled away
 * from its own best play, so if one of the three is much the weaker player, a
 * deck's spread says more about that than about the deck.
 */
const StylePanel = ({ personas, decks, t }) => {
    const roster = personas?.roster || [];
    const withStyles = (decks || []).filter((deck) => (deck.styles || []).length > 0);

    if (roster.length === 0) {
        return null;
    }

    const ladder = personas.ladder || [];

    return (
        <Panel type='default' compactHeader title={t('Three sparring partners')}>
            <ul className='m-0 list-none space-y-1 p-0 text-sm'>
                {roster.map((persona) => (
                    <li key={persona.key}>
                        <span className='font-semibold text-foreground'>{persona.label}</span>{' '}
                        <span className='text-muted'>{persona.description}</span>
                    </li>
                ))}
            </ul>

            {withStyles.length > 0 && (
                <div className='overflow-x-auto pt-3'>
                    <table className='w-full min-w-[28rem] border-collapse text-sm'>
                        <thead>
                            <tr className='text-left text-[11px] uppercase tracking-wide text-muted'>
                                <th className='py-1 pr-2 font-normal'>{t('Deck')}</th>
                                {roster.map((persona) => (
                                    <th className='py-1 pr-2 font-normal' key={persona.key}>
                                        {persona.label}
                                    </th>
                                ))}
                                <th className='py-1 font-normal'>{t('Spread')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {withStyles.map((deck) => (
                                <tr className='border-t border-border/40' key={deck.deckId}>
                                    <td className='max-w-[12rem] truncate py-1 pr-2 text-foreground'>
                                        {deck.name}
                                    </td>
                                    {roster.map((persona) => {
                                        const style = (deck.styles || []).find(
                                            (entry) => entry.persona === persona.key
                                        );
                                        // Blank, not a percentage, below the
                                        // threshold: a five-game record next to a
                                        // forty-game one invites exactly the
                                        // comparison it cannot support.
                                        const thin =
                                            !style || style.games < (personas.minStyleGames || 10);

                                        return (
                                            <td className='py-1 pr-2' key={persona.key}>
                                                {thin ? (
                                                    <span
                                                        className='text-muted'
                                                        title={t('{{games}} games so far', {
                                                            games: style ? style.games : 0
                                                        })}
                                                    >
                                                        —
                                                    </span>
                                                ) : (
                                                    <span
                                                        className='text-foreground'
                                                        title={t('{{wins}}–{{losses}}', {
                                                            wins: style.wins,
                                                            losses: style.losses
                                                        })}
                                                    >
                                                        {pct(style.rate)}
                                                    </span>
                                                )}
                                            </td>
                                        );
                                    })}
                                    <td className='py-1'>
                                        {deck.styleSpread == null ? (
                                            <span className='text-muted'>—</span>
                                        ) : (
                                            <span
                                                className={
                                                    deck.styleSpread >= 0.15
                                                        ? 'font-semibold text-amber-200'
                                                        : 'text-muted'
                                                }
                                                title={
                                                    deck.hardestStyle
                                                        ? t('Hardest: {{label}}', {
                                                              label: deck.hardestStyle.label
                                                          })
                                                        : undefined
                                                }
                                            >
                                                {pct(deck.styleSpread)}
                                            </span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {ladder.length > 1 && (
                <p className='m-0 pt-3 text-[11px] text-muted'>
                    {t('Between themselves, on neutral decks: ')}
                    {ladder
                        .map((entry) =>
                            t('{{label}} {{rate}} ({{games}})', {
                                label: entry.label,
                                rate: pct(entry.rate),
                                games: entry.games
                            })
                        )
                        .join(' · ')}
                </p>
            )}

            <p className='m-0 pt-2 text-[11px] text-muted'>
                {t(
                    'All three are the same learned brain with a different plan, and both seats ' +
                        'of a game share one — so a result is still about the decks. A wide spread ' +
                        'means this deck cares what the opponent is trying to do.'
                )}
            </p>
        </Panel>
    );
};

StylePanel.propTypes = {
    personas: PropTypes.object,
    decks: PropTypes.array,
    t: PropTypes.func
};

/**
 * ARCHON (N32): the Vault Tour - three of your decks against a field somebody
 * won a tournament with.
 *
 * The rest of the lab answers "how does this deck do against my collection" and
 * "against a random slice of everything". This answers the question a
 * competitive player actually asks, and the answer is a MATRIX rather than a
 * percentage: against a dozen named decks, the average is the least interesting
 * number available. A deck at 60% overall that loses every game to the deck that
 * won the biggest event of the year has been told something an average hides.
 *
 * Kept visibly separate from the roster above it, because it is separate: three
 * slots not eight, its own twelve games a day, and no effect on ARI at all.
 */
const VaultTourPanel = ({ vaultTour, onAdd, onRemove, busy, t }) => {
    const [filter, setFilter] = useState('');

    if (!vaultTour || !vaultTour.enabled) {
        return null;
    }

    const {
        slate = [],
        field = [],
        matrix = { opponents: [], cells: {}, totals: {} },
        // Its own list, not the roster's: no SAS requirement, and a deck already
        // in the eight may sit here too.
        candidates = []
    } = vaultTour;
    const needle = filter.trim().toLowerCase();
    const offered = needle
        ? candidates.filter((deck) => deck.name.toLowerCase().includes(needle))
        : candidates;
    const slots = `${slate.length}/${vaultTour.slateSize}`;
    const opponents = matrix.opponents || [];

    return (
        <Panel
            type='default'
            compactHeader
            title={t('The Vault Tour ({{slots}} slots used)', { slots })}
        >
            <p className='m-0 pb-2 text-sm text-muted'>
                {t(
                    'Three decks, played over and over against a field of tournament decks an ' +
                        'admin keeps. Separate from your roster above: its own slots, its own ' +
                        '{{perDay}} games a day, and these games never move ARI — a hand-picked ' +
                        'field of winners is the opposite of the ordinary opposition a rating needs.',
                    { perDay: vaultTour.gamesPerDeckPerDay }
                )}
            </p>

            <div className='flex flex-wrap items-center gap-1.5 pb-2'>
                {slate.map((deck) => (
                    <Chip active key={deck.deckId} onClick={() => onRemove(deck.deckId)}>
                        {deck.name} ×
                    </Chip>
                ))}
            </div>

            {slate.length < vaultTour.slateSize && (
                <div className='pb-2'>
                    {/* A collection runs to hundreds of decks, so the list is
                        searched rather than scrolled - and it says how many are
                        not being shown instead of quietly truncating. */}
                    <input
                        className='mb-1.5 w-full max-w-sm rounded border border-border/70 bg-surface-secondary/60 px-2 py-1 text-sm text-foreground'
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder={t('Find a deck to add…')}
                        value={filter}
                    />
                    <div className='flex flex-wrap items-center gap-1.5'>
                        {offered.slice(0, 12).map((deck) => (
                            <Chip
                                disabled={busy}
                                key={deck.deckId}
                                onClick={() => onAdd(deck.deckId)}
                                title={deck.sas ? t('SAS {{sas}}', { sas: deck.sas }) : undefined}
                            >
                                + {deck.name}
                            </Chip>
                        ))}
                        {offered.length > 12 && (
                            <span className='text-[11px] text-muted'>
                                {t('and {{count}} more — type to narrow', {
                                    count: offered.length - 12
                                })}
                            </span>
                        )}
                        {offered.length === 0 && (
                            <span className='text-[11px] text-muted'>
                                {candidates.length
                                    ? t('No deck of yours matches that.')
                                    : t('No decks of yours are available to add.')}
                            </span>
                        )}
                    </div>
                </div>
            )}

            {field.length === 0 ? (
                <p className='m-0 text-[11px] text-muted'>
                    {t(
                        'No tournament decks have been entered yet. An admin adds them from the ' +
                            'Vault Tour panel in site administration.'
                    )}
                </p>
            ) : opponents.length === 0 ? (
                <p className='m-0 text-[11px] text-muted'>
                    {/* The gap between "in the field" and "playable" is a few
                        sweeps of Master Vault fetches, and looks like a stall if
                        nothing names it. */}
                    {vaultTour.playableField === 0
                        ? t(
                              '{{count}} decks in the field, none with their cards yet — the lab ' +
                                  'fetches a few per sweep from Master Vault. Games start as soon ' +
                                  'as the first one lands.',
                              { count: field.length }
                          )
                        : t(
                              '{{playable}} of {{count}} field decks are ready to play, waiting ' +
                                  'on games. Put a deck on the slate and the lab starts playing ' +
                                  'it through them.',
                              { playable: vaultTour.playableField, count: field.length }
                          )}
                </p>
            ) : (
                <div className='overflow-x-auto'>
                    <table className='w-full min-w-[34rem] border-collapse text-sm'>
                        <thead>
                            <tr className='text-left text-[11px] uppercase tracking-wide text-muted'>
                                <th className='py-1 pr-2 font-normal'>{t('Opponent')}</th>
                                {slate.map((deck) => (
                                    <th className='py-1 pr-2 font-normal' key={deck.deckId}>
                                        {deck.name}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {opponents.map((opponent) => (
                                <tr className='border-t border-border/40' key={opponent.uuid}>
                                    <td className='max-w-[16rem] truncate py-1 pr-2'>
                                        <span className='text-foreground'>{opponent.name}</span>{' '}
                                        <span className='text-[11px] text-muted'>
                                            {opponent.placing === 'unknown'
                                                ? opponent.event
                                                : `${opponent.event} · ${opponent.placing}`}
                                        </span>
                                    </td>
                                    {slate.map((deck) => {
                                        const cell =
                                            matrix.cells[`${deck.deckId}|${opponent.uuid}`];

                                        return (
                                            <td className='py-1 pr-2' key={deck.deckId}>
                                                {cell ? (
                                                    <span
                                                        className={
                                                            cell.winRate >= 0.5
                                                                ? 'text-emerald-300'
                                                                : 'text-red-300'
                                                        }
                                                        title={t('{{wins}}–{{losses}}', {
                                                            wins: cell.wins,
                                                            losses: cell.losses
                                                        })}
                                                    >
                                                        {pct(cell.winRate)}
                                                    </span>
                                                ) : (
                                                    <span className='text-muted'>—</span>
                                                )}
                                            </td>
                                        );
                                    })}
                                </tr>
                            ))}
                            <tr className='border-t border-border/60'>
                                <td className='py-1 pr-2 text-[11px] uppercase tracking-wide text-muted'>
                                    {t('Against the field')}
                                </td>
                                {slate.map((deck) => {
                                    const total = matrix.totals[deck.deckId];

                                    return (
                                        <td
                                            className='py-1 pr-2 font-semibold text-foreground'
                                            key={deck.deckId}
                                        >
                                            {total
                                                ? t('{{rate}} ({{games}})', {
                                                      rate: pct(total.rate),
                                                      games: total.games
                                                  })
                                                : '—'}
                                        </td>
                                    );
                                })}
                            </tr>
                        </tbody>
                    </table>
                </div>
            )}
        </Panel>
    );
};

VaultTourPanel.propTypes = {
    vaultTour: PropTypes.object,
    onAdd: PropTypes.func,
    onRemove: PropTypes.func,
    busy: PropTypes.bool,
    t: PropTypes.func
};

const ChampionsChallenge = () => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);
    const unlocked = hasCapability(user, CAPABILITIES.CHAMPIONS_CHALLENGE);
    const [actionError, setActionError] = useState(null);
    // ARCHON (N21): the randomizer's swap cadence and how many slots to fill,
    // both user-configurable.
    const [randomGames, setRandomGames] = useState(20);
    const [randomCount, setRandomCount] = useState(1);

    const { data, isFetching } = useGetChampionsChallengeQuery(undefined, {
        skip: !user || !unlocked
    });
    const [enroll, { isLoading: enrolling }] = useEnrollChampionsChallengeDeckMutation();
    const [enrollRandom, { isLoading: randomizing }] =
        useEnrollRandomChampionsChallengeDeckMutation();
    const [withdraw, { isLoading: withdrawing }] = useWithdrawChampionsChallengeDeckMutation();
    const [saveGauntlet, { isLoading: savingGauntlet }] =
        useSaveChampionsChallengeGauntletMutation();
    const [addVaultTourDeck, { isLoading: addingVaultTour }] = useEnrollVaultTourDeckMutation();
    const [removeVaultTourDeck, { isLoading: removingVaultTour }] =
        useWithdrawVaultTourDeckMutation();
    const vaultTourBusy = addingVaultTour || removingVaultTour;

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
    // The randomizer never asks for more than fits: the roster can fill up
    // between typing a number and pressing the button.
    const freeSlots = data ? Math.max(0, data.maxEnrolled - decks.length) : 0;
    const randomToAdd = Math.max(1, Math.min(randomCount, freeSlots || 1));

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

                        {/* ARCHON (N21): the randomizer - fill one or more
                            slots with random eligible decks; each swaps
                            itself for a fresh one after the configured
                            number of games. Asking for more decks than there
                            are free slots fills what fits. */}
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
                                        { games: randomGames, count: randomToAdd },
                                        t('No random deck could be enrolled.')
                                    )
                                }
                                type='button'
                            >
                                🎲{' '}
                                {randomToAdd === 1
                                    ? t('Add a random deck')
                                    : t('Add {{count}} random decks', { count: randomToAdd })}
                            </button>
                            <label className='flex items-center gap-1.5 text-[11px] text-muted'>
                                {t('how many')}
                                <input
                                    className='w-14 rounded border border-border/70 bg-surface-secondary/60 px-1.5 py-0.5 text-xs text-foreground'
                                    max={freeSlots || 1}
                                    min={1}
                                    type='number'
                                    value={randomCount}
                                    onChange={(event) =>
                                        setRandomCount(
                                            Math.max(
                                                1,
                                                Math.min(
                                                    Math.max(1, freeSlots),
                                                    parseInt(event.target.value, 10) || 1
                                                )
                                            )
                                        )
                                    }
                                />
                            </label>
                            <label className='flex items-center gap-1.5 text-[11px] text-muted'>
                                {t('swap each out after')}
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
                            {freeSlots > 0 && (
                                <span className='text-[11px] text-muted'>
                                    {t('({{count}} free)', { count: freeSlots })}
                                </span>
                            )}
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

                    <VaultTourPanel
                        vaultTour={data?.vaultTour}
                        busy={vaultTourBusy}
                        t={t}
                        onAdd={async (deckId) => {
                            setActionError(null);

                            try {
                                await addVaultTourDeck(deckId).unwrap();
                            } catch (error) {
                                setActionError(
                                    serverMessage(
                                        error,
                                        t('That deck could not be added to the Vault Tour.')
                                    )
                                );
                            }
                        }}
                        onRemove={async (deckId) => {
                            setActionError(null);

                            try {
                                await removeVaultTourDeck(deckId).unwrap();
                            } catch (error) {
                                setActionError(
                                    serverMessage(error, t('That deck could not be withdrawn.'))
                                );
                            }
                        }}
                    />
                    <StylePanel personas={data?.personas} decks={data?.decks} t={t} />
                    <MatchupMatrix matchups={data?.matchups} t={t} />
                    <CardContribution cards={data?.cards} t={t} />
                    <StrengthCurve curve={data?.strengthCurve} t={t} />

                    {/* ARCHON (N24): the Gauntlet. Sits under the roster
                        because it is a property of how the roster is played,
                        not a separate feature with its own page. */}
                    <GauntletPanel
                        gauntlet={data?.gauntlet}
                        saving={savingGauntlet}
                        t={t}
                        onSave={async (settings) => {
                            setActionError(null);

                            try {
                                await saveGauntlet(settings).unwrap();
                            } catch (error) {
                                setActionError(
                                    serverMessage(
                                        error,
                                        t('Those Gauntlet settings could not be saved.')
                                    )
                                );
                            }
                        }}
                    />

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
                                            {/* ARCHON (N24): the field, beside
                                                the mirror record - never
                                                averaged with it. */}
                                            <th
                                                className='py-1.5 pr-2 text-right font-medium'
                                                title={t(
                                                    'Record against decks nobody here owns, drawn from the Master Vault catalog.'
                                                )}
                                            >
                                                {t('vs field')}
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
                                                <td className='py-1.5 pr-2 text-right'>
                                                    {deck.field && deck.field.games ? (
                                                        <span
                                                            className={
                                                                deck.field.confident
                                                                    ? 'text-foreground'
                                                                    : 'text-muted'
                                                            }
                                                            title={t(
                                                                '{{wins}}–{{losses}} against the field, average opponent SAS {{sas}}',
                                                                {
                                                                    wins: deck.field.wins,
                                                                    losses: deck.field.losses,
                                                                    sas:
                                                                        deck.field.avgOpponentSas ??
                                                                        '—'
                                                                }
                                                            )}
                                                        >
                                                            {pct(deck.field.winRate)}
                                                            <span className='ml-1 text-[10px] text-muted'>
                                                                {t('({{games}})', {
                                                                    games: deck.field.games
                                                                })}
                                                            </span>
                                                        </span>
                                                    ) : (
                                                        <span className='text-muted'>—</span>
                                                    )}
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
