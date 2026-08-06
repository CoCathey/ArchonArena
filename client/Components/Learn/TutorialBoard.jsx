import React from 'react';
import classNames from 'classnames';

import { TutorialCards } from './tutorialCards';
import { TurnSteps, houseLabel, keyCostFor } from './tutorialEngine';
import { KeyColours, KeyImages, LearnIcons, houseIcon } from './learnIcons';
import TutorialCard from './TutorialCard';
import RichText from './RichText';

/**
 * ARCHON (N11): the tutorial board.
 *
 * It is laid out and styled like the real game board rather than like a
 * document: your opponent above, you below, a flat stats strip on each outside
 * edge, creatures nearest the middle, artifacts behind them, your hand along
 * the bottom. The rows carry no headings, no frames and no "nothing here"
 * placeholders, for the same reason a real table does not - the cards are the
 * content, and a caption over every row is what turns a board into a form.
 *
 * It renders from the plain state object in tutorialEngine.js rather than from
 * redux, which is what lets a step be replayed, rewound, or shown to a
 * signed-out visitor.
 *
 * The one deliberate difference from a real game: Onyx's hand is face up. This
 * is a walkthrough, and the reason a play is good is usually the card that was
 * not played.
 */

const GAP = 5;
const MAX_CARD_WIDTH = 82;
const MAX_HAND_WIDTH = 88;
const MAX_ENEMY_HAND_WIDTH = 52;
const MIN_CARD_WIDTH = 32;

/** Cards shrink to fit their row, so a ten-creature battleline never scrolls. */
const widthFor = (count, max) => {
    const n = Math.max(count, 1);

    return `min(${max}px, max(${MIN_CARD_WIDTH}px, calc((100% - ${(n - 1) * GAP}px) / ${n})))`;
};

/**
 * One row of the play area. Deliberately unlabelled: an empty row is just
 * empty space, the way it is on a table.
 */
const CardRow = ({
    zone,
    cards,
    side,
    highlight,
    dimOthers,
    onInspect,
    isTarget,
    onAct,
    align = 'center',
    maxWidth = MAX_CARD_WIDTH,
    minHeight = 30
}) => {
    const zoneHighlighted = highlight.zones.has(zone);

    return (
        <div
            className={classNames('flex items-end rounded px-2 py-1 transition-colors', {
                'justify-center': align === 'center',
                'justify-start': align === 'start',
                'bg-[color:var(--brand)]/10 inset-ring-1 inset-ring-[color:var(--brand)]/45':
                    zoneHighlighted
            })}
            style={{ gap: GAP, minHeight }}
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
                            onActivate={isTarget?.(cardId) ? onAct : undefined}
                        />
                    </div>
                );
            })}
        </div>
    );
};

/**
 * One cell of a stats strip. The real board separates these with a dotted rule
 * rather than boxing each one, and a spotlit cell tints rather than outlines,
 * so the strip stays a strip.
 */
const Stat = ({ children, label, highlighted, onAct, className }) => (
    <div
        title={onAct ? `${label} - click to play this step` : label}
        role={onAct ? 'button' : undefined}
        tabIndex={onAct ? 0 : undefined}
        onClick={onAct}
        onKeyDown={(event) => {
            if (onAct && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                onAct();
            }
        }}
        className={classNames(
            'flex h-7 shrink-0 items-center gap-1 border-e-2 border-dotted border-border/50 px-2 last:border-e-0',
            highlighted && 'rounded-sm bg-[color:var(--brand)]/25',
            onAct &&
                'animate-pulse cursor-pointer rounded-sm ring-2 ring-[color:var(--brand)] hover:animate-none',
            className
        )}
    >
        {children}
    </div>
);

const Value = ({ children }) => (
    <span className='text-sm leading-none font-semibold text-foreground tabular-nums'>
        {children}
    </span>
);

const PileCount = ({ title, count, highlighted, onAct }) => (
    <Stat label={title} highlighted={highlighted} onAct={onAct}>
        <span className='text-[11px] text-muted'>{title}</span>
        <Value>{count}</Value>
    </Stat>
);

const StatsStrip = ({ state, side, highlight, isMe, action, onAct }) => {
    const player = state.players[side];
    const active = state.activePlayer === side;
    // Only your own strip is ever clickable: you never take Onyx's turn.
    const targetOf = (kind, name) => (isMe && action?.[kind]?.includes(name) ? onAct : undefined);

    return (
        <div
            className={classNames(
                'flex items-center overflow-x-auto px-1.5 py-1',
                isMe ? 'border-t border-border/45' : 'border-b border-border/45'
            )}
        >
            <Stat label={player.deckName} highlighted={highlight.stats.has('identity')}>
                <span
                    className={classNames(
                        'text-[10px] leading-none text-[color:var(--brand)]',
                        !active && 'invisible'
                    )}
                    aria-hidden
                >
                    ▶
                </span>
                <span
                    className={classNames(
                        'text-xs leading-none font-bold whitespace-nowrap',
                        active ? 'text-foreground' : 'text-muted'
                    )}
                >
                    {player.name}
                </span>
            </Stat>

            <Stat
                label={`${player.keys} of 3 keys forged`}
                highlighted={highlight.stats.has('keys')}
                onAct={targetOf('stats', 'keys')}
            >
                {KeyColours.map((colour, index) => (
                    <img
                        key={colour}
                        src={KeyImages[colour][index < player.keys ? 'forged' : 'unforged']}
                        alt={`${colour} key`}
                        className={classNames('h-5 w-5', index >= player.keys && 'opacity-40')}
                    />
                ))}
            </Stat>

            <Stat label='Æmber in pool' highlighted={highlight.stats.has('amber')}>
                <img src={LearnIcons.amber} alt='Æmber' className='h-4 w-4' />
                <Value>{player.amber}</Value>
            </Stat>

            <Stat label='Current key cost' highlighted={highlight.stats.has('keyCost')}>
                <img src={LearnIcons.keyCost} alt='Key cost' className='h-4 w-4' />
                <Value>{keyCostFor(state, side)}</Value>
            </Stat>

            <Stat label='Houses in this deck' highlighted={highlight.stats.has('houses')}>
                {player.houses.map((house) => {
                    const pick = targetOf('houses', house);

                    return (
                        <img
                            key={house}
                            src={houseIcon(house)}
                            alt={houseLabel(house)}
                            title={
                                pick
                                    ? `${houseLabel(house)} - click to choose this house`
                                    : houseLabel(house)
                            }
                            onClick={pick}
                            className={classNames('h-6 w-6 transition-all', {
                                'drop-shadow-[0_0_5px_rgba(239,197,74,0.9)]':
                                    player.activeHouse === house,
                                'opacity-35 grayscale':
                                    player.activeHouse && player.activeHouse !== house,
                                'animate-pulse cursor-pointer rounded-full ring-2 ring-[color:var(--brand)] hover:animate-none':
                                    !!pick
                            })}
                        />
                    );
                })}
            </Stat>

            <PileCount
                title='Deck'
                count={player.deck.length}
                highlighted={highlight.zones.has('deck')}
            />
            <PileCount
                title='Discard'
                count={player.discard.length}
                highlighted={highlight.zones.has('discard')}
            />
            <PileCount
                title='Archives'
                count={player.archives.length}
                highlighted={highlight.zones.has('archives')}
                onAct={targetOf('piles', 'archives')}
            />
            <Stat label={`${player.deckName}: cards in hand`}>
                <span className='text-[11px] text-muted'>Hand</span>
                <Value>{player.hand.length}</Value>
            </Stat>
        </div>
    );
};

/** The five-step turn structure, tracked live. This is a teaching aid, not a
 *  part of the real board - it sits above it rather than inside it. */
const TurnStrip = ({ state, highlighted }) => (
    <div
        className={classNames(
            'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2 py-1.5 transition-colors',
            highlighted ? 'bg-[color:var(--brand)]/15' : 'bg-surface-secondary/35'
        )}
    >
        <span className='text-xs font-semibold whitespace-nowrap text-foreground'>
            {state.turn ? `Turn ${state.turn}` : 'Setup'}
            {state.activePlayer ? ` · ${state.players[state.activePlayer].name}` : ''}
        </span>
        <div className='flex flex-wrap items-center gap-1'>
            {TurnSteps.map((step, index) => (
                <span
                    key={step}
                    className={classNames(
                        'rounded px-1.5 py-0.5 text-[10px] whitespace-nowrap transition-colors',
                        state.phase === step
                            ? 'bg-[color:var(--brand)] font-semibold text-[color:var(--brand-strong)]'
                            : 'text-muted'
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

const TutorialBoard = ({ state, highlight, action, onAct, onInspect }) => {
    const lit = parseHighlight(highlight);
    // Dim the rest of the board only when a specific card is spotlit; a zone
    // highlight tints the row itself, which is quieter than ringing ten cards.
    const dimOthers = lit.radiant.cards.size > 0 || lit.onyx.cards.size > 0;
    // The cards this step asks you to click. `cards` are yours, `enemyCards`
    // are the ones you are attacking or pointing an effect at.
    const isTarget = (side) => (cardId) =>
        (side === 'radiant' ? action?.cards : action?.enemyCards)?.includes(cardId) || false;
    const rowProps = (side) => ({
        side,
        highlight: lit[side],
        dimOthers,
        isTarget: isTarget(side),
        onAct,
        onInspect: (cardId) => onInspect?.({ side, cardId })
    });

    return (
        <div className='flex flex-col gap-2'>
            <TurnStrip state={state} highlighted={lit.global.has('turnsteps')} />

            <div className='relative overflow-hidden rounded-md border border-border/60 bg-[color:var(--panel)]'>
                {/* The same vignette the real board uses to settle the edges. */}
                <div
                    className='pointer-events-none absolute inset-0 z-0'
                    style={{
                        background:
                            'radial-gradient(circle at center, color-mix(in oklab, var(--foreground) 3%, transparent) 0%, color-mix(in oklab, var(--foreground) 13%, transparent) 80%)'
                    }}
                />

                <div className='relative z-10 flex flex-col'>
                    <StatsStrip state={state} side='onyx' highlight={lit.onyx} />

                    <div className='px-1 pt-1'>
                        <div className='px-2 pb-0.5 text-[10px] text-muted/70'>
                            Onyx’s hand, face up for the tutorial
                        </div>
                        <CardRow
                            {...rowProps('onyx')}
                            zone='hand'
                            cards={state.players.onyx.hand}
                            align='start'
                            maxWidth={MAX_ENEMY_HAND_WIDTH}
                            minHeight={24}
                        />
                        <CardRow
                            {...rowProps('onyx')}
                            zone='other'
                            cards={state.players.onyx.other}
                            minHeight={0}
                        />
                        <CardRow
                            {...rowProps('onyx')}
                            zone='artifacts'
                            cards={state.players.onyx.artifacts}
                            align='start'
                        />
                        <CardRow
                            {...rowProps('onyx')}
                            zone='creatures'
                            cards={state.players.onyx.creatures}
                        />
                    </div>

                    {/* The centre line, as on the real board. */}
                    <div
                        className='mx-2 my-1 h-0.5 shrink-0'
                        style={{
                            background:
                                'linear-gradient(90deg, color-mix(in oklab, var(--border) 30%, transparent) 0%, color-mix(in oklab, var(--border) 75%, transparent) 50%, color-mix(in oklab, var(--border) 30%, transparent) 100%)'
                        }}
                    />

                    <div className='px-1 pb-1'>
                        <CardRow
                            {...rowProps('radiant')}
                            zone='creatures'
                            cards={state.players.radiant.creatures}
                        />
                        <CardRow
                            {...rowProps('radiant')}
                            zone='artifacts'
                            cards={state.players.radiant.artifacts}
                            align='start'
                        />
                        <CardRow
                            {...rowProps('radiant')}
                            zone='other'
                            cards={state.players.radiant.other}
                            minHeight={0}
                        />
                        <CardRow
                            {...rowProps('radiant')}
                            zone='hand'
                            cards={state.players.radiant.hand}
                            align='start'
                            maxWidth={MAX_HAND_WIDTH}
                            minHeight={40}
                        />
                    </div>

                    <StatsStrip
                        state={state}
                        side='radiant'
                        highlight={lit.radiant}
                        isMe
                        action={action}
                        onAct={onAct}
                    />
                </div>
            </div>

            {action?.prompt && (
                <div
                    className={classNames(
                        'flex flex-wrap items-center gap-2 rounded-md px-3 py-2',
                        action.yours
                            ? 'bg-[color:var(--brand)]/15 inset-ring-1 inset-ring-[color:var(--brand)]/50'
                            : 'bg-surface-secondary/40'
                    )}
                >
                    <span
                        className={classNames(
                            'text-[10px] font-semibold tracking-widest uppercase',
                            action.yours ? 'text-[color:var(--brand)]' : 'text-muted'
                        )}
                    >
                        {action.yours ? 'Your move' : 'Onyx'}
                    </span>
                    <RichText
                        text={action.prompt}
                        as='span'
                        className='min-w-0 flex-1 text-sm text-foreground'
                    />
                    <button
                        type='button'
                        onClick={onAct}
                        className={classNames(
                            'shrink-0 rounded-md px-3 py-1 text-sm font-semibold transition-colors',
                            action.yours
                                ? 'bg-[color:var(--brand)] text-[color:var(--brand-strong)] hover:brightness-105'
                                : 'bg-surface-secondary text-foreground hover:bg-surface-secondary/70'
                        )}
                    >
                        {action.button || 'Continue'}
                    </button>
                </div>
            )}
        </div>
    );
};

TutorialBoard.displayName = 'TutorialBoard';

export default TutorialBoard;
