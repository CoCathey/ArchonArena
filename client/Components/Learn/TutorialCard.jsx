import React, { useState } from 'react';
import classNames from 'classnames';

import { TutorialCards } from './tutorialCards';
import { armorOf, powerOf } from './tutorialEngine';
import { bonusIcons } from './tutorialDecks';
import { BonusIcons, LearnIcons, houseIcon } from './learnIcons';
import RichText from './RichText';

/**
 * ARCHON (N11): one card on the tutorial board.
 *
 * The art comes from the same /img/cards path the real game board uses, so a
 * deployment that can show a game can show the tutorial. If an image is missing
 * - a fresh environment before the card-image fetch job has run, or an offline
 * dev box - the card falls back to a readable text face built from the card
 * data rather than a broken image, because the tutorial is the one place on the
 * site that has to work for someone who has never seen KeyForge before.
 */

const cardImageUrl = (cardId) => `/img/cards/${cardId}.png`;

const HOUSE_TINTS = {
    brobnar: 'from-[#7a3410]/70',
    ekwidon: 'from-[#0f6b63]/70',
    mars: 'from-[#2f6f2c]/70',
    sanctum: 'from-[#1f4f8f]/70',
    staralliance: 'from-[#7a1f2a]/70',
    unfathomable: 'from-[#123a63]/70'
};

/** A readable stand-in for the card art when the image cannot be loaded. */
const FallbackFace = ({ card, side }) => (
    <div
        className={classNames(
            'relative flex h-full w-full flex-col gap-0.5 overflow-hidden rounded-[6%] border border-black/40 bg-gradient-to-b to-black/85 p-[6%] text-left',
            HOUSE_TINTS[card.house] || 'from-black/60'
        )}
    >
        <div className='flex items-start gap-[4%]'>
            <img src={houseIcon(card.house)} alt='' className='mt-[2px] h-2.5 w-2.5 shrink-0' />
            <span className='min-w-0 flex-1 truncate text-[7px] leading-tight font-semibold text-white'>
                {card.name}
            </span>
        </div>
        <div className='text-[6px] tracking-wide text-white/70 uppercase'>{card.type}</div>
        <RichText
            text={card.text}
            className='mt-auto line-clamp-6 text-[6px] leading-[1.15] text-white/85'
        />
        {card.type === 'creature' && (
            <div className='flex items-center justify-between text-[8px] font-semibold text-white'>
                <span>{card.power}</span>
                {card.armor > 0 && <span className='text-white/80'>{card.armor}</span>}
            </div>
        )}
        {bonusIcons(side, card.id).length > 0 && (
            <div className='absolute top-[6%] right-[6%] flex flex-col gap-px'>
                {bonusIcons(side, card.id).map((icon, index) => (
                    <img key={index} src={BonusIcons[icon]} alt={icon} className='h-2 w-2' />
                ))}
            </div>
        )}
    </div>
);

/** A counter sitting on a card: an icon with a number over it. */
const TokenBadge = ({ icon, count, label, className }) => (
    <span
        title={`${count} ${label}`}
        className={classNames(
            'pointer-events-none flex items-center justify-center rounded-full bg-black/70 p-px shadow',
            className
        )}
    >
        <img src={icon} alt='' className='h-3.5 w-3.5' />
        {count > 1 && (
            <span className='ms-px pe-0.5 text-[9px] leading-none font-bold text-white'>
                {count}
            </span>
        )}
    </span>
);

/**
 * @param {object} props
 * @param {string} props.cardId
 * @param {'radiant'|'onyx'} props.side Which deck the card belongs to
 * @param {object} [props.permanent] Board state for a card in play
 * @param {number} [props.width] Rendered width in px
 * @param {boolean} [props.highlighted] Spotlit by the current step
 * @param {boolean} [props.dimmed] Something else is spotlit
 * @param {boolean} [props.faceDown]
 * @param {(cardId: string) => void} [props.onInspect]
 */
const TutorialCard = ({
    cardId,
    side,
    permanent,
    width = 72,
    highlighted,
    dimmed,
    faceDown,
    onInspect
}) => {
    const [imageFailed, setImageFailed] = useState(false);
    const card = TutorialCards[cardId];
    const upgrades = permanent?.upgrades || [];
    const enhancements = (bonusIcons(side, cardId) || []).filter((icon) => icon !== 'amber');

    if (!card) {
        return null;
    }

    const inspect = () => onInspect?.(cardId);

    return (
        <div
            className={classNames('relative shrink-0 transition-all duration-200', {
                'z-10': highlighted,
                'opacity-60': dimmed && !highlighted
            })}
            style={{ width }}
            onMouseEnter={inspect}
            onFocus={inspect}
        >
            {upgrades.length > 0 && (
                <div className='flex flex-col'>
                    {upgrades.map((upgradeId) => (
                        <div
                            key={upgradeId}
                            title={TutorialCards[upgradeId]?.name}
                            className='-mb-px flex items-center gap-1 rounded-t-sm border border-b-0 border-black/40 bg-surface-secondary/90 px-1 py-px'
                        >
                            <img
                                src={houseIcon(TutorialCards[upgradeId]?.house)}
                                alt=''
                                className='h-2 w-2 shrink-0'
                            />
                            <span className='min-w-0 flex-1 truncate text-[7px] leading-tight text-foreground'>
                                {TutorialCards[upgradeId]?.name}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            <div
                role={onInspect ? 'button' : undefined}
                tabIndex={onInspect ? 0 : undefined}
                onClick={inspect}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        inspect();
                    }
                }}
                className={classNames(
                    'relative aspect-[65/91] w-full rounded-[6%] transition-all duration-200',
                    {
                        'cursor-pointer': !!onInspect,
                        'ring-2 shadow-[0_0_18px_2px_rgba(239,197,74,0.55)] ring-[color:var(--brand)]':
                            highlighted
                    }
                )}
            >
                <div
                    className='h-full w-full origin-center transition-transform duration-300'
                    style={
                        permanent?.exhausted
                            ? { transform: 'rotate(90deg) scale(0.7143)' }
                            : undefined
                    }
                >
                    {faceDown ? (
                        <div className='flex h-full w-full items-center justify-center rounded-[6%] border border-black/50 bg-gradient-to-br from-[#2b2f3a] to-[#11141b]'>
                            <span className='text-[8px] tracking-widest text-white/40 uppercase'>
                                Keyforge
                            </span>
                        </div>
                    ) : imageFailed ? (
                        <FallbackFace card={card} side={side} />
                    ) : (
                        <img
                            src={cardImageUrl(cardId)}
                            alt={card.name}
                            title={card.name}
                            loading='lazy'
                            onError={() => setImageFailed(true)}
                            className='h-full w-full rounded-[6%] object-contain'
                        />
                    )}
                </div>

                {!faceDown && enhancements.length > 0 && (
                    <div className='pointer-events-none absolute top-[4%] left-[4%] flex flex-col gap-px'>
                        {enhancements.map((icon, index) => (
                            <img
                                key={index}
                                src={BonusIcons[icon]}
                                alt={icon}
                                title={`${icon} bonus icon`}
                                className='h-2.5 w-2.5 drop-shadow'
                            />
                        ))}
                    </div>
                )}

                {permanent && (
                    /* An exhausted card is drawn rotated and scaled to fit, so
                       its visible edges sit inside the slot. Inset the counters
                       to match, or they float off the card. */
                    <div
                        className={classNames('pointer-events-none absolute inset-x-0', {
                            'inset-y-0': !permanent.exhausted,
                            'inset-y-[21.5%]': permanent.exhausted
                        })}
                    >
                        {permanent.amber > 0 && (
                            <TokenBadge
                                icon={LearnIcons.amber}
                                count={permanent.amber}
                                label='captured Æmber'
                                className='absolute top-0 left-0'
                            />
                        )}
                        {permanent.damage > 0 && (
                            <TokenBadge
                                icon={LearnIcons.damage}
                                count={permanent.damage}
                                label='damage'
                                className='absolute top-0 right-0'
                            />
                        )}
                        {permanent.ward && (
                            <TokenBadge
                                icon={LearnIcons.ward}
                                count={1}
                                label='ward'
                                className='absolute bottom-0 left-0'
                            />
                        )}
                        {permanent.stun && (
                            <TokenBadge
                                icon={LearnIcons.stun}
                                count={1}
                                label='stun'
                                className='absolute right-0 bottom-0'
                            />
                        )}
                    </div>
                )}
            </div>

            {permanent && card.type === 'creature' && permanent.damage > 0 && (
                <div className='mt-0.5 text-center text-[9px] leading-none text-muted tabular-nums'>
                    {powerOf(permanent) - permanent.damage}/{powerOf(permanent)}
                    {armorOf(permanent) > 0 ? ` · ${armorOf(permanent)} armor` : ''}
                </div>
            )}
        </div>
    );
};

TutorialCard.displayName = 'TutorialCard';

export default TutorialCard;
