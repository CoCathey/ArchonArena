import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Input } from '@heroui/react';

/**
 * ARCHON (N14): agreeing a time to play, for asynchronous events.
 *
 * An async round runs for days and the two players have to find an hour in it
 * between themselves. Without this the only channels are the event chat and
 * whatever Discord the organizer runs, and the platform - which knows the
 * deadline, both players and the match - contributes nothing.
 *
 * A player offers one or more times; the other picks one, or adds more of
 * their own. It used to be a single live offer that a counter-proposal
 * replaced, which is one round trip per candidate time between two people who
 * are usually asleep when the other is awake - two players three zones apart
 * could spend a day of a three-day round finding out that Thursday does not
 * work either.
 *
 * All times are entered and shown in the reader's OWN timezone - the input is
 * a plain datetime-local, converted to UTC on the way out and back on the way
 * in. A cross-timezone event is the normal case for an async league, so a
 * screen that quietly meant "server time" would book the wrong hour.
 *
 * And an offer carries the zone it was made from, so it can be read back as
 * "8pm your time, 3am theirs" - the sentence that stops somebody agreeing to a
 * match at three in the morning. The browser knows both without anybody
 * configuring anything.
 */

/** Timestamps come back from Postgres without a zone; they are UTC. */
const asUtc = (value) => {
    if (!value) {
        return null;
    }

    const text = typeof value === 'string' ? value : String(value);
    const time = new Date(text.endsWith('Z') ? text : `${text}Z`);

    return Number.isNaN(time.getTime()) ? null : time;
};

/** A Date as the local-time string `<input type="datetime-local">` expects. */
const toLocalInputValue = (date) => {
    const pad = (value) => String(value).padStart(2, '0');

    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `T${pad(date.getHours())}:${pad(date.getMinutes())}`
    );
};

/** Tomorrow evening, as a starting point that is nearly always in the window. */
const defaultProposal = () => {
    const date = new Date();

    date.setDate(date.getDate() + 1);
    date.setHours(19, 0, 0, 0);

    return toLocalInputValue(date);
};

/** The reader's own zone, as the browser knows it. */
const myZone = () => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
        return undefined;
    }
};

/**
 * The same instant in somebody else's zone, when that is a different answer.
 *
 * Returns nothing when the two zones agree on the wall clock - which is the
 * common case even across different zone NAMES, and appending "(also 8pm their
 * time)" to every offer would be noise that trains people to stop reading it.
 */
const inTheirZone = (date, zone) => {
    if (!date || !zone || zone === myZone()) {
        return null;
    }

    try {
        const theirs = date.toLocaleString(undefined, {
            timeZone: zone,
            weekday: 'short',
            hour: 'numeric',
            minute: '2-digit'
        });
        const mine = date.toLocaleString(undefined, {
            weekday: 'short',
            hour: 'numeric',
            minute: '2-digit'
        });

        return theirs === mine ? null : theirs;
    } catch {
        // An unrecognised zone costs the sentence and nothing else.
        return null;
    }
};

const formatWhen = (date, t) => {
    if (!date) {
        return '';
    }

    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    if (sameDay) {
        return t('today at {{time}}', { time });
    }

    return date.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
};

const MatchScheduler = ({ match, user, opponentName, act, deadline, compact = false }) => {
    const { t } = useTranslation();
    const [proposing, setProposing] = useState(false);
    const [time, setTime] = useState(defaultProposal);
    const [note, setNote] = useState('');

    if (!match || !user) {
        return null;
    }

    const scheduled = asUtc(match.scheduledAt);
    // Every time currently on the table. Older payloads carry only the single
    // proposedTime, so it is folded in as one offer - otherwise upgrading the
    // server would blank the scheduler for any client still holding an old
    // event in memory.
    const offers =
        match.timeSlots && match.timeSlots.length > 0
            ? match.timeSlots
            : match.proposedTime
            ? [
                  {
                      id: null,
                      time: match.proposedTime,
                      proposedById: match.proposedBy
                  }
              ]
            : [];
    const deadlineDate = asUtc(deadline);
    const pastDeadline = deadlineDate && deadlineDate.getTime() < Date.now();

    const send = async (action, body, message) => {
        const ok = await act(`matches/${match.id}/${action}`, body, message);

        if (ok) {
            setProposing(false);
            setNote('');
        }

        return ok;
    };

    const submitProposal = () => {
        if (!time) {
            return;
        }

        // datetime-local is local wall-clock; the Date carries the offset, and
        // toISOString hands the server unambiguous UTC.
        const when = new Date(time);

        if (Number.isNaN(when.getTime())) {
            return;
        }

        send(
            'propose-time',
            {
                time: when.toISOString(),
                note: note.trim() || undefined,
                // So the other player can be shown "8pm your time, 3am theirs".
                zone: myZone()
            },
            t('Time offered - your opponent has been notified')
        );
    };

    const proposeForm = (
        <div className='mt-2 space-y-2 rounded-md border border-border/60 bg-surface-secondary/40 p-2'>
            <div className='flex flex-wrap items-end gap-2'>
                <div className='min-w-0 flex-1'>
                    <label
                        className='mb-1 block text-xs text-muted'
                        htmlFor={`schedule-time-${match.id}`}
                    >
                        {t('Your local time')}
                    </label>
                    <Input
                        id={`schedule-time-${match.id}`}
                        type='datetime-local'
                        value={time}
                        onChange={(event) => setTime(event.target.value)}
                    />
                </div>
                <div className='min-w-0 flex-1'>
                    <label
                        className='mb-1 block text-xs text-muted'
                        htmlFor={`schedule-note-${match.id}`}
                    >
                        {t('Note (optional)')}
                    </label>
                    <Input
                        id={`schedule-note-${match.id}`}
                        value={note}
                        maxLength={280}
                        placeholder={t('Any time after 6 works for me')}
                        onChange={(event) => setNote(event.target.value)}
                    />
                </div>
            </div>
            <div className='flex flex-wrap gap-2'>
                <HeroButton size='sm' variant='primary' onPress={submitProposal}>
                    {t('Send proposal')}
                </HeroButton>
                <HeroButton size='sm' variant='tertiary' onPress={() => setProposing(false)}>
                    {t('Cancel')}
                </HeroButton>
            </div>
        </div>
    );

    // Agreed: show it, and let either side clear it if plans change.
    if (scheduled) {
        return (
            <div className={compact ? '' : 'mt-2 border-t border-border/40 pt-2'}>
                <div className='flex flex-wrap items-center gap-2 text-sm'>
                    <span className='rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-xs font-semibold text-sky-300'>
                        {t('Scheduled')}
                    </span>
                    <span className='text-foreground'>{formatWhen(scheduled, t)}</span>
                    <span className='text-xs text-muted'>{t('your local time')}</span>
                    {!proposing && (
                        <button
                            type='button'
                            className='ml-auto text-xs text-muted underline-offset-2 hover:text-foreground hover:underline'
                            onClick={() => {
                                setTime(toLocalInputValue(scheduled));
                                setProposing(true);
                            }}
                        >
                            {t('reschedule')}
                        </button>
                    )}
                </div>
                {proposing && proposeForm}
            </div>
        );
    }

    // Live offers: the recipient picks one or adds their own; the proposer
    // waits, or takes one back without cancelling the whole negotiation.
    if (offers.length > 0) {
        return (
            <div className={compact ? '' : 'mt-2 border-t border-border/40 pt-2'}>
                <div className='mb-1 flex flex-wrap items-center gap-2 text-sm'>
                    <span className='rounded border border-amber-400/50 bg-amber-400/10 px-1.5 py-0.5 text-xs font-semibold text-amber-300'>
                        {offers.length === 1
                            ? t('1 time offered')
                            : t('{{count}} times offered', { count: offers.length })}
                    </span>
                    {match.scheduleNote && (
                        <span className='text-xs italic text-muted'>
                            &ldquo;{match.scheduleNote}&rdquo;
                        </span>
                    )}
                    {!proposing && (
                        <HeroButton
                            size='sm'
                            variant='tertiary'
                            className='!h-7 !px-2 text-xs'
                            onPress={() => setProposing(true)}
                        >
                            {t('Offer another time')}
                        </HeroButton>
                    )}
                </div>

                <div className='space-y-1'>
                    {offers.map((offer) => {
                        const when = asUtc(offer.time);
                        const mine = offer.proposedById === user.id;
                        const theirs = inTheirZone(when, offer.zone);

                        return (
                            <div
                                key={offer.id}
                                className='flex flex-wrap items-center gap-2 rounded border border-border/50 bg-surface-secondary/40 px-2 py-1 text-sm'
                            >
                                <span className='text-foreground'>{formatWhen(when, t)}</span>
                                {/* The one sentence the stored zone exists for.
                                    Only when the two zones actually disagree -
                                    otherwise it is noise on every row. */}
                                {theirs && (
                                    <span className='text-xs text-muted'>
                                        {t('({{time}} for {{name}})', {
                                            time: theirs,
                                            name: mine ? t('you') : opponentName || t('them')
                                        })}
                                    </span>
                                )}
                                <span className='ml-auto flex flex-wrap gap-2'>
                                    {mine ? (
                                        <HeroButton
                                            size='sm'
                                            variant='tertiary'
                                            className='!h-6 !px-2 text-xs'
                                            onPress={() =>
                                                send(
                                                    'withdraw-time',
                                                    { slotId: offer.id },
                                                    t('Time withdrawn')
                                                )
                                            }
                                        >
                                            {t('Withdraw')}
                                        </HeroButton>
                                    ) : (
                                        <HeroButton
                                            size='sm'
                                            variant='primary'
                                            className='!h-6 !px-2 text-xs'
                                            onPress={() =>
                                                send(
                                                    'accept-time',
                                                    { slotId: offer.id },
                                                    t('Match time agreed')
                                                )
                                            }
                                        >
                                            {t('Play then')}
                                        </HeroButton>
                                    )}
                                </span>
                            </div>
                        );
                    })}
                </div>

                {offers.every((offer) => offer.proposedById === user.id) && (
                    <div className='mt-1 text-xs text-muted'>
                        {t('Waiting for {{name}} to pick one or offer their own', {
                            name: opponentName || t('your opponent')
                        })}
                    </div>
                )}

                {proposing && proposeForm}
            </div>
        );
    }

    return (
        <div className={compact ? '' : 'mt-2 border-t border-border/40 pt-2'}>
            <div className='flex flex-wrap items-center gap-2 text-sm'>
                <span className={pastDeadline ? 'text-red-400' : 'text-muted'}>
                    {pastDeadline
                        ? t('No time set and the round deadline has passed.')
                        : t('No time set yet.')}
                </span>
                {!proposing && (
                    <HeroButton
                        size='sm'
                        variant={pastDeadline ? 'primary' : 'tertiary'}
                        className='!h-7 !px-2 text-xs'
                        onPress={() => setProposing(true)}
                    >
                        {t('Propose a time')}
                    </HeroButton>
                )}
            </div>
            {proposing && proposeForm}
        </div>
    );
};

MatchScheduler.displayName = 'MatchScheduler';

export default MatchScheduler;
