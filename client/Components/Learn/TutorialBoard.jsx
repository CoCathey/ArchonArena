import React from 'react';
import classNames from 'classnames';

import { Constants } from '../../constants';
import { TutorialCards } from './tutorialCards';
import { TurnSteps, houseLabel, keyCostFor } from './tutorialEngine';
import { KeyColours, KeyImages, LearnIcons } from './learnIcons';
import TutorialCard from './TutorialCard';
import RichText from './RichText';

/**
 * ARCHON (N11): the tutorial board.
 *
 * Built to sit where the real one sits. The two stats bars are their own strips
 * outside the table - your opponent's along the top, yours along the bottom -
 * carrying the same cells in the same order as the game's: avatar and name,
 * keys, Aember, chains, key cost, house symbols, identity card, then the deck,
 * discard and archives counts. Between them is the table itself: their
 * battleline above the centre line, yours below it, artifacts behind each
 * battleline, your hand along the bottom. No row headings, no frames, no
 * "nothing here" placeholders - an empty row is empty space, as on a table.
 *
 * Nothing on the board is decorated to illustrate the prose. The only thing
 * that lights up is the card, house symbol or counter the current step asks you
 * to click, because a board where six things glow tells you nothing about which
 * one to touch. Whatever the step is *about* is read in the panel beside the
 * board instead.
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

const CardRow = ({
    cards,
    side,
    onInspect,
    isTarget,
    onAct,
    align = 'center',
    maxWidth = MAX_CARD_WIDTH,
    minHeight = 30
}) => (
    <div
        className={classNames('flex items-end px-2 py-1', {
            'justify-center': align === 'center',
            'justify-start': align === 'start'
        })}
        style={{ gap: GAP, minHeight }}
    >
        {cards.map((entry, index) => {
            const cardId = typeof entry === 'string' ? entry : entry.id;

            return (
                <div key={`${cardId}-${index}`} style={{ width: widthFor(cards.length, maxWidth) }}>
                    <TutorialCard
                        cardId={cardId}
                        side={side}
                        permanent={typeof entry === 'string' ? undefined : entry}
                        width='100%'
                        onInspect={onInspect}
                        onActivate={isTarget?.(cardId) ? onAct : undefined}
                    />
                </div>
            );
        })}
    </div>
);

/**
 * One cell of a stats bar. The real board separates these with a dotted rule
 * rather than boxing each one, so the bar stays a bar.
 */
const Stat = ({ children, label, onAct, className }) => (
    <div
        title={onAct ? `${label} - click to make this move` : label}
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
            'flex h-8 shrink-0 items-center gap-1 border-e-2 border-dotted border-border/50 px-2 last:border-e-0',
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

const PileCount = ({ title, count, onAct }) => (
    <Stat label={title} onAct={onAct}>
        <span className='text-[11px] text-muted'>{title}</span>
        <Value>{count}</Value>
    </Stat>
);

/**
 * A stand-in for the deck's identity card, composed the way the real one is:
 * the archon card back with the deck's three house crests across the foot.
 */
const IdentityCard = ({ player }) => (
    <div
        title={player.deckName}
        className='relative h-9 w-[26px] shrink-0 overflow-hidden rounded-[2px] border border-black/60'
    >
        <img
            src={Constants.IdBackBlanksPaths[1]}
            alt=''
            className='absolute inset-0 h-full w-full object-cover'
        />
        <div className='absolute inset-x-0 bottom-0 flex justify-center gap-px bg-black/60 py-[1px]'>
            {player.houses.map((house) => (
                <img
                    key={house}
                    src={Constants.IdBackHousePaths[house]}
                    alt=''
                    className='h-2 w-2'
                />
            ))}
        </div>
    </div>
);

const StatsBar = ({ state, side, isMe, action, onAct }) => {
    const player = state.players[side];
    const active = state.activePlayer === side;
    // Only your own bar is ever clickable: you never take Onyx's turn.
    const targetOf = (kind, name) => (isMe && action?.[kind]?.includes(name) ? onAct : undefined);
    // Forged keys sort to the front, as they do on the real board.
    const keys = KeyColours.map((colour, index) => ({ colour, forged: index < player.keys })).sort(
        (a, b) => Number(b.forged) - Number(a.forged)
    );

    return (
        <div className='flex items-center overflow-x-auto bg-[color:var(--panel)] px-1.5 py-1'>
            <Stat label={player.deckName}>
                <span
                    className={classNames(
                        'flex size-6 items-center justify-center rounded-full bg-surface-secondary text-[10px] font-bold text-muted',
                        !active && 'opacity-40'
                    )}
                    aria-hidden
                >
                    {player.name[0]}
                </span>
                <span
                    className={classNames(
                        'text-xs leading-none font-bold whitespace-nowrap',
                        active ? 'text-foreground' : 'text-muted opacity-60'
                    )}
                >
                    {active ? '▶ ' : ''}
                    {player.name}
                </span>
            </Stat>

            <Stat
                label={`${player.keys} of 3 keys forged`}
                onAct={targetOf('stats', 'keys')}
                className='gap-0'
            >
                {keys.map(({ colour, forged }) => (
                    <img
                        key={colour}
                        src={KeyImages[colour][forged ? 'forged' : 'unforged']}
                        alt={`${colour} key`}
                        className={classNames('h-6 w-6', !forged && 'opacity-60')}
                    />
                ))}
            </Stat>

            <Stat label='Æmber in pool'>
                <img src={LearnIcons.amber} alt='Æmber' className='h-5 w-5' />
                <Value>{player.amber}</Value>
            </Stat>

            <Stat label='Chains'>
                <img src={LearnIcons.chains} alt='Chains' className='h-5 w-5' />
                <Value>0</Value>
            </Stat>

            <Stat label='Current key cost'>
                <img src={LearnIcons.keyCost} alt='Key cost' className='h-5 w-5' />
                <Value>{keyCostFor(state, side)}</Value>
            </Stat>

            <Stat label='Houses in this deck' className='gap-0.5'>
                {player.houses.map((house) => {
                    const pick = targetOf('houses', house);

                    return (
                        <img
                            key={house}
                            src={Constants.IdBackHousePaths[house]}
                            alt={houseLabel(house)}
                            title={
                                pick
                                    ? `${houseLabel(house)} - click to choose this house`
                                    : houseLabel(house)
                            }
                            onClick={pick}
                            className={classNames('h-7 w-7 transition-opacity', {
                                'opacity-20': player.activeHouse && player.activeHouse !== house,
                                'animate-pulse cursor-pointer rounded-full ring-2 ring-[color:var(--brand)] hover:animate-none':
                                    !!pick
                            })}
                        />
                    );
                })}
            </Stat>

            <Stat label={player.deckName}>
                <IdentityCard player={player} />
            </Stat>

            {!isMe && <PileCount title='Hand' count={player.hand.length} />}
            <PileCount title='Deck' count={player.deck.length} />
            <PileCount title='Discard' count={player.discard.length} />
            <PileCount
                title='Archives'
                count={player.archives.length}
                onAct={targetOf('piles', 'archives')}
            />
        </div>
    );
};

/** The five-step turn structure, tracked live. A teaching aid, not part of the
 *  real board - so it sits above it rather than inside it. */
const TurnStrip = ({ state }) => (
    <div className='flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-surface-secondary/35 px-2 py-1.5'>
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

/** Every card id a step is about, for the card-detail panel beside the board. */
export const highlightedCardIds = (targets = []) =>
    targets
        .map((target) => target.split('.'))
        .filter(([side, kind, name]) => kind === 'card' && side && TutorialCards[name])
        .map(([side, , name]) => ({ side, cardId: name }));

const TutorialBoard = ({ state, action, onAct, onInspect }) => {
    // The cards this step asks you to click. `cards` are yours, `enemyCards`
    // are the ones you are attacking or pointing an effect at.
    const isTarget = (side) => (cardId) =>
        (side === 'radiant' ? action?.cards : action?.enemyCards)?.includes(cardId) || false;
    const rowProps = (side) => ({
        side,
        isTarget: isTarget(side),
        onAct,
        onInspect: (cardId) => onInspect?.({ side, cardId })
    });

    return (
        <div className='flex flex-col gap-2'>
            <TurnStrip state={state} />

            <div className='overflow-hidden rounded-md border border-border/60'>
                <StatsBar state={state} side='onyx' />

                {/* The table: darker than the bars, as the real board is. */}
                <div className='relative bg-[color:var(--bg)]'>
                    <div
                        className='pointer-events-none absolute inset-0 z-0'
                        style={{
                            background:
                                'radial-gradient(circle at center, transparent 0%, color-mix(in oklab, black 22%, transparent) 85%)'
                        }}
                    />
                    <div className='relative z-10 flex flex-col py-1'>
                        <CardRow
                            {...rowProps('onyx')}
                            cards={state.players.onyx.hand}
                            align='start'
                            maxWidth={MAX_ENEMY_HAND_WIDTH}
                            minHeight={24}
                        />
                        <CardRow
                            {...rowProps('onyx')}
                            cards={state.players.onyx.other}
                            minHeight={0}
                        />
                        <CardRow
                            {...rowProps('onyx')}
                            cards={state.players.onyx.artifacts}
                            align='start'
                        />
                        <CardRow {...rowProps('onyx')} cards={state.players.onyx.creatures} />

                        {/* The centre line, as on the real board. */}
                        <div
                            className='mx-2 my-1 h-0.5 shrink-0'
                            style={{
                                background:
                                    'linear-gradient(90deg, color-mix(in oklab, var(--border) 25%, transparent) 0%, color-mix(in oklab, var(--border) 70%, transparent) 50%, color-mix(in oklab, var(--border) 25%, transparent) 100%)'
                            }}
                        />

                        <CardRow {...rowProps('radiant')} cards={state.players.radiant.creatures} />
                        <CardRow
                            {...rowProps('radiant')}
                            cards={state.players.radiant.artifacts}
                            align='start'
                        />
                        <CardRow
                            {...rowProps('radiant')}
                            cards={state.players.radiant.other}
                            minHeight={0}
                        />
                        <CardRow
                            {...rowProps('radiant')}
                            cards={state.players.radiant.hand}
                            align='start'
                            maxWidth={MAX_HAND_WIDTH}
                            minHeight={40}
                        />
                    </div>
                </div>

                <StatsBar state={state} side='radiant' isMe action={action} onAct={onAct} />
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
