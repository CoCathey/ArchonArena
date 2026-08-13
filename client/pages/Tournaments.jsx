import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, toast } from '@heroui/react';
import { useNavigate } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import MySchedulePanel from '../Components/Tournaments/MySchedulePanel';
import EventForm from '../Components/Tournaments/EventForm';
import {
    describeEvent,
    defaultEventForm as defaultForm
} from '../Components/Tournaments/describeEvent';
import { centsFromAmount, formatCents } from '../Components/Tournaments/prizePool';
import {
    useCreateTournamentMutation,
    useGetTournamentHistoryQuery,
    useListEventsQuery
} from '../redux/api';

const formatNames = {
    swiss: 'Swiss',
    'single-elim': 'Single Elim',
    'double-elim': 'Double Elim',
    'round-robin': 'Round Robin'
};

/**
 * ARCHON: tournament list + creation (Phase 7). Any logged-in player
 * can organize an event - that is the point for local scenes. The
 * create form covers formats (Swiss with optional top cut, single and
 * double elimination, round robin), best-of series, scheduling, player
 * caps, private events, seeding, deck registration with SAS bands,
 * round timers, and rated play.
 */
const Tournaments = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const user = useSelector((state) => state.account.user);
    const [statusFilter, setStatusFilter] = useState('');
    const [showCreate, setShowCreate] = useState(false);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [form, setForm] = useState(defaultForm);

    const { data } = useListEventsQuery(statusFilter ? { status: statusFilter } : undefined, {
        pollingInterval: 30000
    });
    const { data: historyData } = useGetTournamentHistoryQuery(user?.username, {
        skip: !user
    });
    const [createTournament, createState] = useCreateTournamentMutation();

    const tournaments = data?.tournaments || [];
    const myHistory = historyData?.events || [];
    const eventPreview = describeEvent(form);

    const statuses = [
        ['', t('All')],
        ['registration', t('Open Registration')],
        ['active', t('In Progress')],
        ['complete', t('Completed')],
        // ARCHON: cancelled events are hidden from "All" - they are tombstones
        // nobody can enter - but reachable for an organizer looking for one.
        ['cancelled', t('Cancelled')]
    ];

    const onCreate = async () => {
        try {
            const result = await createTournament({
                ...form,
                roundCount: form.roundCount || undefined,
                roundDeadlineDays:
                    form.pacing === 'async' ? form.roundDeadlineDays || undefined : undefined,
                startTime: form.startTime || undefined,
                playerCap: form.playerCap || undefined,
                cutTo: form.format === 'swiss' ? form.cutTo || undefined : undefined,
                playoffBestOf:
                    form.format === 'swiss' && form.cutTo ? form.playoffBestOf : undefined,
                roundTimerMinutes: form.roundTimerMinutes || undefined,
                gameTimeLimit: form.gameTimeLimit || undefined,
                sasMin: form.sasMin || undefined,
                sasMax: form.sasMax || undefined,
                // Money crosses the wire in integer cents; the form holds what
                // the organizer typed. A split with no fee behind it is
                // dropped rather than stored - it would divide nothing.
                entryFeeCents: centsFromAmount(form.entryFee) || undefined,
                prizeCurrency: form.prizeCurrency,
                prizeSplits: centsFromAmount(form.entryFee)
                    ? form.prizeSplits.filter((split) => split.bps > 0)
                    : undefined,
                prizeNote: form.prizeNote || undefined,
                paymentInstructions: form.paymentInstructions || undefined,
                requirePayment: !!form.requirePayment,
                chainsPerMatchWin: form.chainsPerMatchWin || undefined,
                allowedSets: form.allowedSets.length > 0 ? form.allowedSets : undefined,
                bannedHouses: form.bannedHouses.length > 0 ? form.bannedHouses : undefined,
                requiredHouses: form.requiredHouses.length > 0 ? form.requiredHouses : undefined
            }).unwrap();

            if (result.success) {
                toast.success(t('Tournament created'));
                setShowCreate(false);
                setForm(defaultForm);
                navigate(`/tournaments/${result.id}`);
            } else {
                toast.danger(result.message || t('Could not create tournament'));
            }
        } catch {
            toast.danger(t('Could not create tournament'));
        }
    };

    return (
        <div className='mx-auto w-full max-w-5xl space-y-4'>
            {/* ARCHON (N14): what you owe, before what exists. A player
                returning to an async league needs their own outstanding
                matches first, not the catalogue. */}
            {user && <MySchedulePanel />}

            <Panel title={t('Tournaments')}>
                <div className='mb-3 flex flex-wrap items-center gap-2'>
                    <div className='flex flex-wrap gap-1'>
                        {statuses.map(([key, label]) => (
                            <HeroButton
                                key={key}
                                size='sm'
                                variant={statusFilter === key ? 'primary' : 'tertiary'}
                                onPress={() => setStatusFilter(key)}
                            >
                                {label}
                            </HeroButton>
                        ))}
                    </div>
                    {user && (
                        <HeroButton
                            size='sm'
                            variant='primary'
                            className='ml-auto'
                            onPress={() => setShowCreate((open) => !open)}
                        >
                            {showCreate ? t('Close') : t('Create Tournament')}
                        </HeroButton>
                    )}
                </div>

                {showCreate && (
                    <div className='mb-4 space-y-3 rounded-md border border-border/60 bg-surface-secondary/50 p-3'>
                        <EventForm
                            form={form}
                            setForm={setForm}
                            showAdvanced={showAdvanced}
                            setShowAdvanced={setShowAdvanced}
                        />

                        {/* ARCHON: the event, said back to the organizer before
                            they commit to it. Twenty controls decide how an
                            event runs and most only matter for some of the
                            others, so a first-time organizer cannot tell which
                            of their answers will actually do anything until it
                            runs. The notes are advisory - the server validates,
                            this explains. */}
                        <div className='rounded-md border border-border/60 bg-surface-secondary/40 p-3'>
                            <div className='mb-1 text-xs font-semibold uppercase tracking-wide text-muted'>
                                {t('What you are about to run')}
                            </div>
                            {/* Rendered as-is rather than through t(): these
                                sentences are composed from the organizer's own
                                numbers, so every variant would be its own
                                translation key and none of them would ever
                                match one. */}
                            <ul className='list-disc space-y-0.5 pl-5 text-sm text-foreground/85'>
                                {eventPreview.summary.map((line) => (
                                    <li key={line}>{line}</li>
                                ))}
                            </ul>
                            {eventPreview.notes.length > 0 && (
                                <div className='mt-2 border-t border-border/50 pt-2'>
                                    <div className='mb-1 text-xs font-semibold uppercase tracking-wide text-amber-500'>
                                        {t('Settings that will not do anything')}
                                    </div>
                                    <ul className='list-disc space-y-0.5 pl-5 text-sm text-amber-600 dark:text-amber-300'>
                                        {eventPreview.notes.map((line) => (
                                            <li key={line}>{line}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>

                        <HeroButton
                            variant='primary'
                            size='sm'
                            isPending={createState.isLoading}
                            onPress={onCreate}
                        >
                            {t('Create')}
                        </HeroButton>
                    </div>
                )}

                {tournaments.length === 0 ? (
                    <div className='py-6 text-center text-sm text-muted'>
                        {t('No tournaments here yet - create the first one!')}
                    </div>
                ) : (
                    <div className='space-y-2'>
                        {tournaments.map((tournament) => (
                            <Link
                                key={tournament.id}
                                href={`/tournaments/${tournament.id}`}
                                className='flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border/60 bg-surface-secondary/50 px-3 py-2 transition hover:border-amber-300/60'
                            >
                                <span className='font-semibold text-foreground'>
                                    {tournament.name}
                                </span>
                                <span className='text-xs uppercase tracking-wide text-amber-300'>
                                    {t(formatNames[tournament.format] || tournament.format)}
                                    {tournament.cutTo ? ` → ${tournament.cutTo}` : ''}
                                    {' - '}
                                    {tournament.gameFormat}
                                    {tournament.bestOf > 1 ? ` - Bo${tournament.bestOf}` : ''}
                                    {tournament.mode === 'irl' ? ` - ${t('In Person')}` : ''}
                                </span>
                                {/* ARCHON: which decks may enter, before the
                                    player clicks in and gets refused. */}
                                {(tournament.sasMin != null || tournament.sasMax != null) && (
                                    <span
                                        className='rounded bg-amber-400/15 px-1.5 text-xs uppercase text-amber-300'
                                        title={t('Registered decks must rate inside this SAS band')}
                                    >
                                        {t('SAS')} {tournament.sasMin ?? 0}-
                                        {tournament.sasMax ?? '\u221e'}
                                    </span>
                                )}
                                {/* ARCHON: nobody should have to open an event
                                    to find out it costs money to enter. */}
                                {tournament.entryFeeCents > 0 && (
                                    <span
                                        className='rounded bg-emerald-500/15 px-1.5 text-xs uppercase text-emerald-300'
                                        title={t(
                                            'Buy-in, collected by the organizer - ArchonArena does not take payments'
                                        )}
                                    >
                                        {formatCents(
                                            tournament.entryFeeCents,
                                            tournament.prizeCurrency
                                        )}
                                    </span>
                                )}
                                {tournament.pacing === 'async' && (
                                    <span
                                        className='rounded bg-sky-500/15 px-1.5 text-xs uppercase text-sky-300'
                                        title={t(
                                            'Players have {{days}} day(s) per round to arrange their match',
                                            { days: tournament.roundDeadlineDays || 0 }
                                        )}
                                    >
                                        {t('Async')}
                                    </span>
                                )}
                                {tournament.rated && (
                                    <span className='rounded bg-amber-400/15 px-1.5 text-xs uppercase text-amber-300'>
                                        {t('Rated')}
                                    </span>
                                )}
                                {tournament.visibility === 'private' && (
                                    <span className='rounded bg-surface-tertiary/70 px-1.5 text-xs uppercase text-muted'>
                                        {t('Private')}
                                    </span>
                                )}
                                <span className='ml-auto text-xs text-muted'>
                                    {t('{{count}} players', { count: tournament.playerCount })}
                                    {tournament.playerCap ? `/${tournament.playerCap}` : ''}
                                    {' - '}
                                    {tournament.status === 'registration'
                                        ? tournament.startTime
                                            ? t('Starts {{time}}', {
                                                  time: new Date(
                                                      tournament.startTime
                                                  ).toLocaleString()
                                              })
                                            : t('Open Registration')
                                        : tournament.status === 'active'
                                        ? t('Round {{round}}', { round: tournament.currentRound })
                                        : t(tournament.status)}
                                    {' - '}
                                    {tournament.organizer}
                                </span>
                            </Link>
                        ))}
                    </div>
                )}
            </Panel>

            {user && myHistory.length > 0 && (
                <Panel title={t('Your Tournament Record')}>
                    <div className='space-y-1'>
                        {myHistory.map((event) => (
                            <Link
                                key={event.id}
                                href={`/tournaments/${event.id}`}
                                className='flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 text-sm transition hover:bg-surface-secondary/60'
                            >
                                <span
                                    className={`w-14 font-bold ${
                                        event.finalRank === 1
                                            ? 'text-amber-300'
                                            : event.finalRank && event.finalRank <= 3
                                            ? 'text-amber-500'
                                            : 'text-muted'
                                    }`}
                                >
                                    {event.finalRank
                                        ? event.finalRank === 1
                                            ? `🏆 ${t('1st')}`
                                            : t('#{{rank}}', { rank: event.finalRank })
                                        : '-'}
                                </span>
                                <span className='text-foreground'>{event.name}</span>
                                <span className='ml-auto text-xs text-muted'>
                                    {t(formatNames[event.format] || event.format)}
                                    {' - '}
                                    {t('{{count}} players', { count: event.playerCount })}
                                    {event.finishedAt
                                        ? ` - ${new Date(event.finishedAt).toLocaleDateString()}`
                                        : ''}
                                </span>
                            </Link>
                        ))}
                    </div>
                </Panel>
            )}
        </div>
    );
};

Tournaments.displayName = 'Tournaments';

export default Tournaments;
