import React from 'react';
import { useTranslation } from 'react-i18next';

import { formatCents, ordinal, percentFromBps, prizeRows } from './prizePool';

/**
 * ARCHON: the prize pool, said out loud on the event page.
 *
 * Before the event it is a promise - this is what it costs and this is how the
 * pot divides. After it, the same numbers with names against them, so the
 * organizer hands out prizes from a table everybody can see instead of doing
 * the arithmetic in their head at the end of the night.
 *
 * THE PLATFORM HOLDS NONE OF IT. That is stated here, where a player reads the
 * buy-in, and not only in the form where the organizer set it - the two
 * audiences are different people and only one of them ever sees the form.
 */
const PrizePanel = ({ tournament, players }) => {
    const { t } = useTranslation();

    const entryFeeCents = tournament.entryFeeCents || 0;
    const splits = tournament.prizeSplits || [];
    const currency = tournament.prizeCurrency || 'USD';

    if (entryFeeCents <= 0) {
        return null;
    }

    const entrants = (players || []).filter((player) => !player.waitlisted);
    const finished = tournament.status === 'complete';
    // Before the event ends the pot is what has actually been paid in, which is
    // the honest number: a projection to a full house would be a bigger figure
    // than anyone has handed over. Afterwards the rows are people rather than
    // places - see prizeRows, which is where the difference is reasoned about.
    const pool = prizeRows({ entryFeeCents, splits, players: entrants, finished });

    return (
        <div className='rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3'>
            <div className='mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1'>
                <span className='text-xs font-semibold uppercase tracking-wide text-emerald-300'>
                    {finished ? t('Prizes') : t('Buy-in and prizes')}
                </span>
                <span className='text-sm font-semibold text-foreground'>
                    {t('{{amount}} to enter', {
                        amount: formatCents(entryFeeCents, currency)
                    })}
                </span>
                <span className='text-sm text-muted'>
                    {t('{{count}} in - pot of {{pot}}', {
                        count: entrants.length,
                        pot: formatCents(pool.poolCents, currency)
                    })}
                </span>
            </div>

            {pool.rows.length === 0 ? (
                <div className='text-sm text-muted'>
                    {splits.length === 0
                        ? t('The organizer has not published a prize split for this event.')
                        : t('Nobody placed, so nothing was paid out.')}
                </div>
            ) : (
                <div className='space-y-0.5'>
                    {pool.rows.map((row) => (
                        <div
                            key={row.rank}
                            className='flex flex-wrap items-baseline gap-x-2 text-sm'
                        >
                            <span className='w-10 font-semibold text-foreground'>
                                {ordinal(row.rank)}
                            </span>
                            {row.winners ? (
                                <>
                                    <span className='text-foreground'>
                                        {row.winners.map((winner) => winner.username).join(', ')}
                                    </span>
                                    {row.winners.length > 1 && (
                                        <span className='text-xs text-muted'>
                                            {t('(tied - shared evenly)')}
                                        </span>
                                    )}
                                    <span className='ml-auto font-semibold text-emerald-300'>
                                        {row.winners
                                            .map((winner) =>
                                                formatCents(winner.amountCents, currency)
                                            )
                                            .join(' + ')}
                                    </span>
                                </>
                            ) : (
                                <>
                                    <span className='w-12 text-xs text-muted'>
                                        {percentFromBps(row.bps)}%
                                    </span>
                                    <span className='ml-auto font-semibold text-emerald-300'>
                                        {formatCents(row.amountCents, currency)}
                                    </span>
                                </>
                            )}
                        </div>
                    ))}

                    {pool.retainedCents > 0 && (
                        <div className='flex flex-wrap items-baseline gap-x-2 border-t border-emerald-500/20 pt-1 text-sm text-muted'>
                            <span>{t('Kept by the organizer')}</span>
                            <span className='ml-auto'>
                                {formatCents(pool.retainedCents, currency)}
                            </span>
                        </div>
                    )}

                    {/* A prize for a place nobody reached - a 3rd prize in a
                        two-player event. Named rather than quietly folded into
                        what the organizer keeps, because the table did not pay
                        out in full and that is the organizer's call to make. */}
                    {pool.unallocatedCents > 0 && (
                        <div className='flex flex-wrap items-baseline gap-x-2 text-sm text-amber-600 dark:text-amber-300'>
                            <span>{t('Not claimed - nobody finished in those places')}</span>
                            <span className='ml-auto'>
                                {formatCents(pool.unallocatedCents, currency)}
                            </span>
                        </div>
                    )}
                </div>
            )}

            {/* ARCHON: how to pay, next to what it costs. A fee with no way to
                pay it is the most obvious question an event can leave open, and
                it was the one the buy-in used to leave. Hidden once the event
                is over, when it is no longer anything anyone can act on. */}
            {tournament.paymentInstructions && !finished && (
                <div className='mt-2 whitespace-pre-wrap rounded border border-emerald-500/25 bg-emerald-500/5 px-2 py-1.5 text-sm text-foreground/90'>
                    <span className='mr-1 font-semibold text-emerald-300'>{t('How to pay:')}</span>
                    {tournament.paymentInstructions}
                    {tournament.requirePayment && (
                        <span className='mt-1 block text-xs text-amber-600 dark:text-amber-300'>
                            {t(
                                'The event will not start until everyone entered has been marked paid.'
                            )}
                        </span>
                    )}
                </div>
            )}

            {tournament.prizeNote && (
                <div className='mt-2 whitespace-pre-wrap border-t border-emerald-500/20 pt-2 text-sm text-foreground/85'>
                    {tournament.prizeNote}
                </div>
            )}

            <div className='mt-2 text-xs text-muted'>
                {t(
                    'Collected and paid out by {{organizer}}. ArchonArena records these amounts and never handles the money.',
                    { organizer: tournament.organizer }
                )}
            </div>
        </div>
    );
};

PrizePanel.displayName = 'PrizePanel';

export default PrizePanel;
