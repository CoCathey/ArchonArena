import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Input, Label } from '@heroui/react';

import {
    bpsFromPercent,
    centsFromAmount,
    computePrizePool,
    formatCents,
    ordinal,
    percentFromBps,
    presetIdFor,
    PRIZE_CURRENCIES,
    PRIZE_PRESETS
} from './prizePool';

const selectClass =
    'w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none dark:border-border/80 dark:bg-surface-secondary/85';

/**
 * ARCHON: the buy-in and how the pot divides.
 *
 * THE PLATFORM DOES NOT TOUCH THE MONEY, and this says so next to the field
 * where the money is set rather than in a policy page nobody opens. The event
 * records what was announced; the organizer collects and pays out however they
 * already do. Holding it would mean KYC on every payee, 1099s every January,
 * chargeback liability on every buy-in and geo-restriction kept current as
 * contest law changes - permanently, for a few dollars an event.
 *
 * What an organizer actually wants from a platform here is not to do the
 * arithmetic in their head at the end of the night, in front of people who have
 * already paid. So this shows the pot and the table in money, live, while they
 * are still deciding - and those same numbers are what everyone sees on the
 * event page and what the final standings pay out against.
 */
const PrizePoolFields = ({ form, setForm, entrantCount }) => {
    const { t } = useTranslation();

    /**
     * Shares are stored as basis points, but a share is TYPED one character at
     * a time and "7." is not a number. Normalising on every keystroke eats the
     * decimal point the moment it is typed, so an organizer physically cannot
     * enter 7.5%. The raw text lives here until the field is left, and the
     * stored basis points follow it.
     */
    const [typing, setTyping] = useState({});

    const splits = form.prizeSplits || [];
    const feeCents = centsFromAmount(form.entryFee);
    const currency = form.prizeCurrency || 'USD';
    const presetId = presetIdFor(splits);

    // What to price the preview at. Once people have registered that is the
    // real number; before that the cap is the organizer's own guess, and
    // failing that a round eight so the table reads in money rather than
    // percentages.
    const previewCount = entrantCount || Number(form.playerCap) || 8;
    const pool = computePrizePool({
        entryFeeCents: feeCents,
        splits,
        entrantCount: previewCount
    });

    const setSplits = (next) => {
        setTyping({});
        setForm((current) => ({
            ...current,
            // Places renumbered from the top on every change, so the table
            // cannot end up paying 1st and 3rd with nothing between them -
            // which reads as a missing prize rather than a deliberate gap.
            prizeSplits: next.map((split, index) => ({ rank: index + 1, bps: split.bps }))
        }));
    };

    const onPreset = (event) => {
        const preset = PRIZE_PRESETS.find((entry) => entry.id === event.target.value);

        setTyping({});

        if (!preset || preset.splits === null) {
            // "Custom" keeps whatever is on screen and hands over the controls:
            // picking a preset and then adjusting it is the whole point.
            setForm((current) => ({
                ...current,
                prizeSplits: current.prizeSplits?.length
                    ? current.prizeSplits
                    : [{ rank: 1, bps: 10000 }]
            }));

            return;
        }

        setForm((current) => ({
            ...current,
            prizeSplits: preset.splits.map((split) => ({ ...split }))
        }));
    };

    const onShareTyped = (index, text) => {
        const bps = bpsFromPercent(text);

        setTyping((current) => ({ ...current, [index]: text }));
        setForm((current) => ({
            ...current,
            prizeSplits: (current.prizeSplits || []).map((entry, position) =>
                position === index ? { ...entry, bps: bps === null ? 0 : bps } : entry
            )
        }));
    };

    const shareText = (index, bps) => {
        if (typing[index] !== undefined) {
            return typing[index];
        }

        // Zero shows as empty, not "0" - otherwise a new row starts with a
        // character the organizer has to delete before they can type.
        return bps ? percentFromBps(bps) : '';
    };

    const allocated = splits.reduce((sum, split) => sum + (split.bps || 0), 0);
    const overAllocated = allocated > 10000;

    return (
        <div className='space-y-3 rounded-md border border-border/60 bg-surface-secondary/40 p-3'>
            <div className='flex flex-wrap items-baseline gap-x-2'>
                <div className='text-xs font-semibold uppercase tracking-wide text-muted'>
                    {t('Buy-in and prizes')}
                </div>
                <div className='text-xs text-muted'>
                    {t('Optional - leave the entry fee blank for a free event.')}
                </div>
            </div>

            <div className='grid gap-3 md:grid-cols-2'>
                <div>
                    <Label htmlFor='tournamentEntryFee'>{t('Entry fee per player')}</Label>
                    <div className='flex items-center gap-2'>
                        <Input
                            id='tournamentEntryFee'
                            inputMode='decimal'
                            placeholder='0.00'
                            aria-label={t('Entry fee per player')}
                            value={form.entryFee}
                            onChange={(event) =>
                                setForm((current) => ({
                                    ...current,
                                    entryFee: event.target.value
                                }))
                            }
                        />
                        <select
                            className={`${selectClass} w-28`}
                            aria-label={t('Currency')}
                            value={currency}
                            onChange={(event) =>
                                setForm((current) => ({
                                    ...current,
                                    prizeCurrency: event.target.value
                                }))
                            }
                        >
                            {PRIZE_CURRENCIES.map((code) => (
                                <option key={code} value={code}>
                                    {code}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>

                {feeCents > 0 && (
                    <div>
                        <Label htmlFor='tournamentPrizePreset'>{t('How the pot divides')}</Label>
                        <select
                            id='tournamentPrizePreset'
                            className={selectClass}
                            value={presetId}
                            onChange={onPreset}
                        >
                            {PRIZE_PRESETS.map((preset) => (
                                <option key={preset.id} value={preset.id}>
                                    {t(preset.label)}
                                </option>
                            ))}
                        </select>
                    </div>
                )}
            </div>

            {feeCents > 0 && (
                <>
                    {/* The table, in money. Percentages are what gets stored;
                        amounts are what the conversation at the end of the
                        night is actually about. */}
                    <div className='space-y-1'>
                        {splits.map((split, index) => (
                            <div key={split.rank} className='flex flex-wrap items-center gap-2'>
                                <span className='w-10 text-sm font-semibold text-foreground'>
                                    {ordinal(split.rank)}
                                </span>
                                <Input
                                    className='w-24'
                                    inputMode='decimal'
                                    aria-label={t('Share for {{place}} place', {
                                        place: ordinal(split.rank)
                                    })}
                                    value={shareText(index, split.bps)}
                                    onChange={(event) => onShareTyped(index, event.target.value)}
                                    onBlur={() =>
                                        setTyping((current) => {
                                            const next = { ...current };

                                            delete next[index];

                                            return next;
                                        })
                                    }
                                />
                                <span className='text-sm text-muted'>%</span>
                                <span className='text-sm text-foreground/85'>
                                    {formatCents(
                                        pool.places.find((place) => place.rank === split.rank)
                                            ?.amountCents || 0,
                                        currency
                                    )}
                                </span>
                                <HeroButton
                                    size='sm'
                                    variant='tertiary'
                                    className='ml-auto'
                                    onPress={() =>
                                        setSplits(
                                            splits.filter((entry, position) => position !== index)
                                        )
                                    }
                                >
                                    {t('Remove')}
                                </HeroButton>
                            </div>
                        ))}
                        <HeroButton
                            size='sm'
                            variant='tertiary'
                            onPress={() =>
                                setSplits([...splits, { rank: splits.length + 1, bps: 0 }])
                            }
                        >
                            {t('Add a place')}
                        </HeroButton>
                    </div>

                    <div className='rounded-md border border-border/50 bg-surface-tertiary/30 p-2 text-sm'>
                        <div className='text-foreground'>
                            {entrantCount
                                ? t('{{count}} entered so far - a pot of {{pot}}.', {
                                      count: previewCount,
                                      pot: formatCents(pool.poolCents, currency)
                                  })
                                : t('At {{count}} players the pot is {{pot}}.', {
                                      count: previewCount,
                                      pot: formatCents(pool.poolCents, currency)
                                  })}
                        </div>
                        {overAllocated ? (
                            <div className='mt-0.5 text-amber-600 dark:text-amber-300'>
                                {t(
                                    'These shares add up to {{total}}% - more than the pot. The event will not save until they come down.',
                                    { total: (allocated / 100).toFixed(2) }
                                )}
                            </div>
                        ) : (
                            pool.retainedCents > 0 && (
                                <div className='mt-0.5 text-muted'>
                                    {t('{{amount}} is not handed out and stays with you.', {
                                        amount: formatCents(pool.retainedCents, currency)
                                    })}
                                </div>
                            )
                        )}
                    </div>

                    <div>
                        <Label htmlFor='tournamentPrizeNote'>
                            {t('How and when you will pay out (shown to players)')}
                        </Label>
                        {/* Wrapped, like the fee above: a bare Input beside a
                            Label lays out inline, and this label is a whole
                            sentence - the field ends up a stub at the end of
                            it. */}
                        <div className='flex'>
                            <Input
                                id='tournamentPrizeNote'
                                className='w-full'
                                maxLength={500}
                                placeholder={t('Cash at the counter when the event finishes')}
                                value={form.prizeNote}
                                onChange={(event) =>
                                    setForm((current) => ({
                                        ...current,
                                        prizeNote: event.target.value
                                    }))
                                }
                            />
                        </div>
                    </div>

                    {/* ARCHON: unmissable, and beside the money rather than in a
                        policy page. Nobody should be able to set a buy-in here
                        and believe the platform is going to collect it. */}
                    <div className='rounded-md border border-amber-400/40 bg-amber-400/10 p-2 text-xs text-amber-700 dark:text-amber-200'>
                        {t(
                            'ArchonArena records these numbers and nothing else - it does not collect entry fees or pay out prizes. Taking the money and handing it out is yours to do, and so is anything your local law says about running a paid event.'
                        )}
                    </div>
                </>
            )}
        </div>
    );
};

PrizePoolFields.displayName = 'PrizePoolFields';

export default PrizePoolFields;
