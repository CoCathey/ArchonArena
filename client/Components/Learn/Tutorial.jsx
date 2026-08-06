import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import classNames from 'classnames';

import Panel from '../Site/Panel';
import Link from '../Navigation/Link';
import RichText from './RichText';
import TutorialBoard, { highlightedCardIds } from './TutorialBoard';
import TutorialCard from './TutorialCard';
import { TutorialCards } from './tutorialCards';
import { TutorialSteps } from './tutorialScript';
import { buildTutorialStates, houseLabel } from './tutorialEngine';
import { cardNumber } from './tutorialDecks';
import { houseIcon } from './learnIcons';
import { readSavedStep, writeSavedStep } from './tutorialProgress';

/**
 * ARCHON (N11): the interactive Learn-to-Play tutorial.
 *
 * A reader clicks Next; each click advances one step of the official two-player
 * starter set walkthrough. The board on the left is the real position after
 * that step and the cards the step is about are spotlit on it, with their full
 * rules text pulled into the panel on the right - which is the answer to the
 * thing that makes a card game hard to learn from a video: you cannot pause a
 * video on the card you did not understand.
 *
 * Progress is kept in localStorage (see tutorialProgress.js) so that a visitor
 * who has not signed up yet can still leave and come back.
 */

/** Chapters in script order, with the step each one starts at. */
const buildChapters = () => {
    const chapters = [];

    TutorialSteps.forEach((step, index) => {
        const last = chapters[chapters.length - 1];

        if (!last || last.title !== step.chapter) {
            chapters.push({ title: step.chapter, start: index, count: 1 });
        } else {
            last.count += 1;
        }
    });

    return chapters;
};

const CardDetail = ({ cardId, side }) => {
    const card = TutorialCards[cardId];

    if (!card) {
        return null;
    }

    return (
        <div className='flex gap-3 rounded-md border border-border/60 bg-surface-secondary/30 p-2'>
            <div className='w-20 shrink-0'>
                <TutorialCard cardId={cardId} side={side} width='100%' />
            </div>
            <div className='min-w-0 flex-1'>
                <div className='flex items-center gap-1.5'>
                    <img src={houseIcon(card.house)} alt='' className='h-4 w-4 shrink-0' />
                    <span className='min-w-0 truncate text-sm font-semibold text-foreground'>
                        {card.name}
                    </span>
                </div>
                <div className='text-[11px] text-muted'>
                    {houseLabel(card.house)} · {card.type}
                    {card.type === 'creature' && ` · ${card.power} power`}
                    {card.type === 'creature' && card.armor > 0 && ` · ${card.armor} armor`}
                    {` · card ${cardNumber(side, cardId)} of 18`}
                </div>
                {card.traits.length > 0 && (
                    <div className='text-[11px] text-muted italic capitalize'>
                        {card.traits.join(' · ')}
                    </div>
                )}
                <RichText
                    text={card.text}
                    className='mt-1 text-xs leading-snug text-foreground/90'
                />
            </div>
        </div>
    );
};

const Tutorial = () => {
    const states = useMemo(() => buildTutorialStates(TutorialSteps), []);
    const chapters = useMemo(buildChapters, []);
    const [index, setIndex] = useState(readSavedStep);
    const [inspected, setInspected] = useState(null);
    const [showLog, setShowLog] = useState(false);
    const logRef = useRef(null);

    const step = TutorialSteps[index];
    const state = states[index];
    const total = TutorialSteps.length;

    const goTo = useCallback(
        (next) => {
            const clamped = Math.min(Math.max(next, 0), total - 1);

            setIndex(clamped);
            setInspected(null);
            writeSavedStep(clamped);
        },
        [total]
    );

    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.target instanceof HTMLElement && event.target.closest('input, textarea')) {
                return;
            }

            if (event.key === 'ArrowRight' || event.key === 'PageDown') {
                event.preventDefault();
                goTo(index + 1);
            } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
                event.preventDefault();
                goTo(index - 1);
            }
        };

        window.addEventListener('keydown', onKeyDown);

        return () => window.removeEventListener('keydown', onKeyDown);
    }, [goTo, index]);

    useEffect(() => {
        if (showLog && logRef.current) {
            logRef.current.scrollTop = logRef.current.scrollHeight;
        }
    }, [showLog, index]);

    // With nothing hovered, the panel explains whatever this step spotlights.
    const focusCards = inspected ? [inspected] : highlightedCardIds(step.highlight).slice(0, 3);

    const progress = Math.round(((index + 1) / total) * 100);
    const chapterIndex = chapters.reduce(
        (found, chapter, position) => (chapter.start <= index ? position : found),
        0
    );

    return (
        <div className='flex min-h-0 w-full flex-col gap-3'>
            <Panel
                title='Learn to Play KeyForge'
                contentClassName='!overflow-visible gap-2'
                className='shrink-0'
            >
                <div className='flex flex-wrap items-center justify-between gap-2'>
                    <div className='text-sm text-muted'>
                        The two-player starter set walkthrough, one click at a time.{' '}
                        <span className='whitespace-nowrap'>
                            Step {index + 1} of {total}
                        </span>
                    </div>
                    <div className='flex items-center gap-2'>
                        <Button variant='tertiary' onPress={() => goTo(0)}>
                            Start over
                        </Button>
                        <Button variant='tertiary' onPress={() => goTo(index - 1)}>
                            Back
                        </Button>
                        <Button
                            variant='primary'
                            onPress={() => goTo(index + 1)}
                            isDisabled={index >= total - 1}
                        >
                            {index >= total - 1 ? 'Finished' : 'Next'}
                        </Button>
                    </div>
                </div>
                <div
                    className='h-1.5 w-full overflow-hidden rounded-full bg-surface-secondary/70'
                    role='progressbar'
                    aria-valuenow={progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                >
                    <div
                        className='h-full rounded-full bg-[color:var(--brand)] transition-all duration-300'
                        style={{ width: `${progress}%` }}
                    />
                </div>
                <div className='-mx-1 flex flex-wrap gap-1'>
                    {chapters.map((chapter, position) => (
                        <button
                            key={chapter.title}
                            type='button'
                            onClick={() => goTo(chapter.start)}
                            className={classNames(
                                'rounded px-1.5 py-0.5 text-[11px] transition-colors',
                                position === chapterIndex
                                    ? 'bg-[color:var(--brand)] font-semibold text-[color:var(--brand-strong)]'
                                    : position < chapterIndex
                                    ? 'text-muted hover:bg-surface-secondary/60'
                                    : 'text-muted/70 hover:bg-surface-secondary/60'
                            )}
                        >
                            {chapter.title}
                        </button>
                    ))}
                </div>
            </Panel>

            <div className='grid min-h-0 gap-3 lg:grid-cols-[minmax(0,1fr)_23rem]'>
                <div className='order-2 min-w-0 lg:order-1'>
                    <Panel contentClassName='!overflow-visible'>
                        <TutorialBoard
                            state={state}
                            highlight={step.highlight}
                            onInspect={setInspected}
                        />
                    </Panel>
                </div>

                <div className='order-1 flex min-w-0 flex-col gap-3 lg:order-2'>
                    <Panel title={step.chapter} contentClassName='!overflow-visible gap-2'>
                        <h3 className='text-base leading-tight font-semibold text-foreground'>
                            {step.title}
                        </h3>
                        {step.body.map((paragraph, position) => (
                            <RichText
                                key={position}
                                text={paragraph}
                                className='text-sm leading-relaxed text-foreground/90'
                            />
                        ))}
                        {step.rule && (
                            <div className='rounded-md border-s-2 border-[color:var(--brand)] bg-[color:var(--brand)]/10 px-2.5 py-1.5'>
                                <div className='text-[10px] tracking-widest text-muted uppercase'>
                                    Rule
                                </div>
                                <RichText
                                    text={step.rule}
                                    className='text-sm leading-snug text-foreground'
                                />
                            </div>
                        )}
                        {step.platform && (
                            <div className='rounded-md border border-border/60 bg-surface-secondary/30 px-2.5 py-1.5'>
                                <div className='text-[10px] tracking-widest text-muted uppercase'>
                                    On Archon Arena
                                </div>
                                <RichText
                                    text={step.platform}
                                    className='text-sm leading-snug text-foreground/90'
                                />
                            </div>
                        )}
                        <div className='flex items-center justify-between gap-2 pt-1'>
                            <span className='text-[11px] text-muted'>
                                Tip: the ← and → keys move between steps.
                            </span>
                            {/* The last step is where a reader is most ready to
                                play, so it ends in a door rather than a disabled
                                button. */}
                            {index >= total - 1 ? (
                                <Link
                                    href='/play'
                                    className='inline-flex items-center rounded-md bg-[color:var(--brand)] px-4 py-2 text-sm font-semibold text-[color:var(--brand-strong)] no-underline hover:brightness-105'
                                >
                                    Find a game
                                </Link>
                            ) : (
                                <Button variant='primary' onPress={() => goTo(index + 1)}>
                                    Next
                                </Button>
                            )}
                        </div>
                    </Panel>

                    {focusCards.length > 0 && (
                        <Panel
                            title={inspected ? 'Card' : 'Cards in this step'}
                            contentClassName='!overflow-visible gap-2'
                        >
                            {focusCards.map(({ side, cardId }) => (
                                <CardDetail key={`${side}-${cardId}`} cardId={cardId} side={side} />
                            ))}
                            <p className='text-[11px] text-muted'>
                                Hover or tap any card on the board to read it.
                            </p>
                        </Panel>
                    )}

                    <Panel title='Game log' contentClassName='!overflow-visible gap-1'>
                        <button
                            type='button'
                            onClick={() => setShowLog((shown) => !shown)}
                            className='self-start text-xs text-muted underline-offset-2 hover:underline'
                        >
                            {showLog ? 'Hide' : 'Show'} the log ({state.log.length}{' '}
                            {state.log.length === 1 ? 'entry' : 'entries'})
                        </button>
                        {showLog && (
                            <div
                                ref={logRef}
                                className='max-h-56 overflow-y-auto rounded border border-border/50 bg-surface-secondary/25 p-2 text-[11px] leading-relaxed text-foreground/85'
                            >
                                {state.log.map((line, position) => (
                                    <div
                                        key={position}
                                        className={classNames({
                                            'mt-1 font-semibold text-foreground':
                                                line.startsWith('---')
                                        })}
                                    >
                                        {line.replace(/^--- | ---$/g, '')}
                                    </div>
                                ))}
                            </div>
                        )}
                        <p className='text-[11px] text-muted'>
                            A real game keeps the same running log beside the board, so you can
                            always scroll back and see exactly what happened.
                        </p>
                    </Panel>
                </div>
            </div>
        </div>
    );
};

Tutorial.displayName = 'Tutorial';

export default Tutorial;
