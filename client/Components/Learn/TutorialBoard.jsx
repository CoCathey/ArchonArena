import React from 'react';
import classNames from 'classnames';

import { TutorialCards } from './tutorialCards';
import { TurnSteps, houseLabel, keyCostFor } from './tutorialEngine';
import { KeyColours, KeyImages, LearnIcons, houseIcon } from './learnIcons';
import TutorialCard from './TutorialCard';

/**
 * ARCHON (N11): the tutorial board.
 *
 * It is laid out exactly like the real game board - your opponent above, you
 * below, stats bar on the outside edge, creatures nearest the middle, artifacts
 * behind them, hand along the bottom - so that finishing the tutorial and
 * opening a real game feels like the same screen. It renders from the plain
 * state object in tutorialEngine.js rather than from redux, which is what lets
 * a step be replayed, rewound, or shown to a signed-out visitor.
 *
 * The one deliberate difference from a real game: Onyx's hand is face up. This
 * is a walkthrough, and the reason a play is good is usually the card that was
 * not played.
 */

const GAP = 4;
const MAX_CARD_WIDTH = 84;
const MIN_CARD_WIDTH = 34;

/** Cards shrink to fit their row, so a ten-creature battleline never scrolls. */
const widthFor = (count, max = MAX_CARD_WIDTH) =>
    `min(${max}px, max(${MIN_CARD_WIDTH}px, calc((100% - ${
        (Math.max(count, 1) - 1) * GAP
    }px) / ${Math.max(count, 1)})))`;

const CardRow = ({
    label,
    cards,
    side,
    highlight,
    dimOthers,
    onInspect,
    align = 'center',
    maxWidth,
    emptyHint
}) => {
    const zoneHighlighted = highlight.zones.has(label.zone);

    return (
        <div
            className={classNames('rounded-md px-1 py-1 transition-all', {
                'bg-[color:var(--brand)]/12 ring-1 ring-[color:var(--brand)]/60': zoneHighlighted
            })}
        >
            <div className='mb-0.5 flex items-center gap-2'>
                <span className='text-[10px] tracking-wide text-muted uppercase'>{label.text}</span>
                {cards.length > 0 && (
                    <span className='text-[10px] text-muted/70 tabular-nums'>{cards.length}</span>
                )}
            </div>
            {cards.length === 0 ? (
                <div className='flex h-9 items-center rounded border border-dashed border-border/50 px-2 text-[10px] text-muted/70'>
                    {emptyHint}
                </div>
            ) : (
                <div
                    className={classNames('flex items-end', {
                        'justify-center': align === 'center',
                        'justify-start': align === 'start'
                    })}
                    style={{ gap: GAP }}
                >
                    {cards.map((entry, index) => {
                        const cardId = typeof entry === 'string' ? entry : entry.id;

                        return (
                            <div
                                key={`${cardId}-${index}`}
                                style={{ width: widthFor(cards.length, maxWidth) }}
                            >
                                <TutorialCard
                                    cardId={cardId}
                                    side={side}
                                    permanent={typeof entry === 'string' ? undefined : entry}
                                    width='100%'
                                    highlighted={highlight.cards.has(cardId)}
                                    dimmed={dimOthers && !zoneHighlighted}
                                    onInspect={onInspect}
                                />
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

const Pile = ({ title, count, highlighted }) => (
    <div
        title={title}
        className={classNames(
            'flex min-w-11 flex-col items-center gap-0.5 rounded border px-1.5 py-1 transition-all',
            // A ternary, not two object keys: both sets carry a border colour,
            // so listing them together lets stylesheet order decide the winner
            // and the highlight silently loses.
            highlighted
                ? 'border-[color:var(--brand)] bg-[color:var(--brand)]/15'
                : 'border-border/60 bg-surface-secondary/40'
        )}
    >
        <span className='text-[9px] tracking-wide text-muted uppercase'>{title}</span>
        <span className='text-sm leading-none font-semibold text-foreground tabular-nums'>
            {count}
        </span>
    </div>
);

const Stat = ({ icon, label, value, highlighted }) => (
    <div
        title={label}
        className={classNames(
            'flex items-center gap-1 rounded border px-1.5 py-1 transition-all',
            highlighted
                ? 'border-[color:var(--brand)] bg-[color:var(--brand)]/15'
                : 'border-border/60 bg-surface-secondary/40'
        )}
    >
        <img src={icon} alt='' className='h-4 w-4' />
        <span className='text-sm leading-none font-semibold text-foreground tabular-nums'>
            {value}
        </span>
    </div>
);

const Keys = ({ forged, highlighted }) => (
    <div
        title={`${forged} of 3 keys forged`}
        className={classNames(
            'flex items-center gap-0.5 rounded border px-1.5 py-1 transition-all',
            highlighted
                ? 'border-[color:var(--brand)] bg-[color:var(--brand)]/15'
                : 'border-border/60 bg-surface-secondary/40'
        )}
    >
        {KeyColours.map((colour, index) => (
            <img
                key={colour}
                src={KeyImages[colour][index < forged ? 'forged' : 'unforged']}
                alt={`${colour} key`}
                className={classNames('h-5 w-5', { 'opacity-45': index >= forged })}
            />
        ))}
    </div>
);

const Identity = ({ player, activeHouse, highlight }) => (
    <div
        className={classNames(
            'flex items-center gap-2 rounded border px-2 py-1 transition-all',
            highlight.stats.has('identity')
                ? 'border-[color:var(--brand)] bg-[color:var(--brand)]/15'
                : 'border-border/60 bg-surface-secondary/40'
        )}
    >
        <div className='flex flex-col'>
            <span className='text-xs leading-tight font-semibold text-foreground'>
                {player.name}
            </span>
            <span className='text-[9px] leading-tight text-muted'>{player.deckName}</span>
        </div>
        <div
            className={classNames('flex items-center gap-0.5 rounded px-0.5 transition-all', {
                'bg-[color:var(--brand)]/25 ring-1 ring-[color:var(--brand)]':
                    highlight.stats.has('houses')
            })}
        >
            {player.houses.map((house) => (
                <img
                    key={house}
                    src={houseIcon(house)}
                    alt={houseLabel(house)}
                    title={houseLabel(house)}
                    className={classNames('h-6 w-6 transition-all', {
                        'scale-110 drop-shadow-[0_0_5px_rgba(239,197,74,0.9)]':
                            activeHouse === house,
                        'opacity-40 grayscale': activeHouse && activeHouse !== house
                    })}
                />
            ))}
        </div>
    </div>
);

const PlayerStats = ({ state, side, highlight }) => {
    const player = state.players[side];

    return (
        <div className='flex flex-wrap items-center gap-1.5'>
            <Identity player={player} activeHouse={player.activeHouse} highlight={highlight} />
            <Keys forged={player.keys} highlighted={highlight.stats.has('keys')} />
            <Stat
                icon={LearnIcons.amber}
                label='Æmber in pool'
                value={player.amber}
                highlighted={highlight.stats.has('amber')}
            />
            <Stat
                icon={LearnIcons.keyCost}
                label='Current key cost'
                value={keyCostFor(state, side)}
                highlighted={highlight.stats.has('keyCost')}
            />
            <Pile
                title='Deck'
                count={player.deck.length}
                highlighted={highlight.zones.has('deck')}
            />
            <Pile
                title='Discard'
                count={player.discard.length}
                highlighted={highlight.zones.has('discard')}
            />
            <Pile
                title='Archives'
                count={player.archives.length}
                highlighted={highlight.zones.has('archives')}
            />
        </div>
    );
};

const TurnStrip = ({ state, highlighted }) => (
    <div
        className={classNames(
            'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2 py-1.5 transition-all',
            highlighted
                ? 'border-[color:var(--brand)] bg-[color:var(--brand)]/12'
                : 'border-border/60 bg-surface-secondary/30'
        )}
    >
        <span className='text-xs font-semibold text-foreground'>
            {state.turn ? `Turn ${state.turn}` : 'Setup'}
            {state.activePlayer ? ` · ${state.players[state.activePlayer].name}` : ''}
        </span>
        <div className='flex flex-wrap items-center gap-1'>
            {TurnSteps.map((step, index) => (
                <span
                    key={step}
                    className={classNames(
                        'rounded px-1.5 py-0.5 text-[10px] whitespace-nowrap transition-all',
                        state.phase === step
                            ? 'bg-[color:var(--brand)] font-semibold text-[color:var(--brand-strong)]'
                            : 'bg-surface-secondary/60 text-muted'
                    )}
                >
                    {index + 1}. {step}
                </span>
            ))}
        </div>
    </div>
);

/**
 * Splits the step's highlight strings into something the board can ask
 * questions of: which cards, which zones and which stats are lit, per side.
 */
export const parseHighlight = (targets = []) => {
    const perSide = {
        radiant: { cards: new Set(), zones: new Set(), stats: new Set() },
        onyx: { cards: new Set(), zones: new Set(), stats: new Set() }
    };
    const global = new Set();

    for (const target of targets) {
        const [side, kind, name] = target.split('.');

        if (!perSide[side] || !name) {
            global.add(target);
            continue;
        }

        perSide[side][`${kind}s`]?.add(name);
    }

    return { ...perSide, global };
};

/** Every card id spotlit by a step, in board order, for the detail panel. */
export const highlightedCardIds = (targets = []) =>
    targets
        .map((target) => target.split('.'))
        .filter(([side, kind, name]) => kind === 'card' && side && TutorialCards[name])
        .map(([side, , name]) => ({ side, cardId: name }));

const TutorialBoard = ({ state, highlight, onInspect }) => {
    const lit = parseHighlight(highlight);
    // Dim the rest of the board only when a specific card is spotlit; a zone
    // highlight rings the row itself, which is quieter than ringing ten cards.
    const dimOthers = lit.radiant.cards.size > 0 || lit.onyx.cards.size > 0;
    const rowProps = (side) => ({
        side,
        highlight: lit[side],
        dimOthers,
        onInspect: (cardId) => onInspect?.({ side, cardId })
    });

    return (
        <div className='flex flex-col gap-2'>
            <TurnStrip state={state} highlighted={lit.global.has('turnsteps')} />

            {/* Opponent: stats on the outside, battleline nearest the middle. */}
            <div className='rounded-md border border-border/60 bg-surface-secondary/20 p-2'>
                <PlayerStats state={state} side='onyx' highlight={lit.onyx} />
                <div className='mt-1.5 flex flex-col gap-1'>
                    <CardRow
                        {...rowProps('onyx')}
                        label={{ text: 'Onyx hand (face up for the tutorial)', zone: 'hand' }}
                        cards={state.players.onyx.hand}
                        align='start'
                        maxWidth={56}
                        emptyHint='No cards in hand'
                    />
                    {state.players.onyx.other.length > 0 && (
                        <CardRow
                            {...rowProps('onyx')}
                            label={{ text: 'Resolving', zone: 'other' }}
                            cards={state.players.onyx.other}
                            emptyHint=''
                        />
                    )}
                    <CardRow
                        {...rowProps('onyx')}
                        label={{ text: 'Onyx artifacts', zone: 'artifacts' }}
                        cards={state.players.onyx.artifacts}
                        emptyHint='No artifacts in play'
                    />
                    <CardRow
                        {...rowProps('onyx')}
                        label={{ text: 'Onyx battleline', zone: 'creatures' }}
                        cards={state.players.onyx.creatures}
                        emptyHint='No creatures in play'
                    />
                </div>
            </div>

            <div className='flex items-center gap-2'>
                <div className='h-px flex-1 bg-border/60' />
                <span className='text-[10px] tracking-widest text-muted uppercase'>
                    The Crucible
                </span>
                <div className='h-px flex-1 bg-border/60' />
            </div>

            {/* You. */}
            <div className='rounded-md border border-[color:var(--brand)]/40 bg-surface-secondary/20 p-2'>
                <div className='flex flex-col gap-1'>
                    <CardRow
                        {...rowProps('radiant')}
                        label={{ text: 'Your battleline', zone: 'creatures' }}
                        cards={state.players.radiant.creatures}
                        emptyHint='No creatures in play'
                    />
                    <CardRow
                        {...rowProps('radiant')}
                        label={{ text: 'Your artifacts', zone: 'artifacts' }}
                        cards={state.players.radiant.artifacts}
                        emptyHint='No artifacts in play'
                    />
                    {state.players.radiant.other.length > 0 && (
                        <CardRow
                            {...rowProps('radiant')}
                            label={{ text: 'Resolving', zone: 'other' }}
                            cards={state.players.radiant.other}
                            emptyHint=''
                        />
                    )}
                    <CardRow
                        {...rowProps('radiant')}
                        label={{ text: 'Your hand', zone: 'hand' }}
                        cards={state.players.radiant.hand}
                        align='start'
                        maxWidth={96}
                        emptyHint='No cards in hand'
                    />
                </div>
                <div className='mt-1.5'>
                    <PlayerStats state={state} side='radiant' highlight={lit.radiant} />
                </div>
            </div>
        </div>
    );
};

TutorialBoard.displayName = 'TutorialBoard';

export default TutorialBoard;
