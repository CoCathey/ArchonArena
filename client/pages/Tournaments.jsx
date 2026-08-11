import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Input, Label, toast } from '@heroui/react';
import { useNavigate } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import MySchedulePanel from '../Components/Tournaments/MySchedulePanel';
import { Constants } from '../constants';
import {
    useCreateTournamentMutation,
    useGetTournamentHistoryQuery,
    useListEventsQuery
} from '../redux/api';

const selectClass =
    'w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none dark:border-border/80 dark:bg-surface-secondary/85';

const formatNames = {
    swiss: 'Swiss',
    'single-elim': 'Single Elim',
    'double-elim': 'Double Elim',
    'round-robin': 'Round Robin'
};

const houseOptions = [
    ['brobnar', 'Brobnar'],
    ['dis', 'Dis'],
    ['ekwidon', 'Ekwidon'],
    ['geistoid', 'Geistoid'],
    ['logos', 'Logos'],
    ['mars', 'Mars'],
    ['ouboros', 'Ouboros'],
    ['redemption', 'Redemption'],
    ['sanctum', 'Sanctum'],
    ['saurian', 'Saurian'],
    ['shadows', 'Shadows'],
    ['skyborn', 'Skyborn'],
    ['staralliance', 'Star Alliance'],
    ['unfathomable', 'Unfathomable'],
    ['untamed', 'Untamed']
];

const defaultForm = {
    name: '',
    description: '',
    format: 'swiss',
    gameFormat: 'archon',
    mode: 'online',
    pacing: 'live',
    roundDeadlineDays: '3',
    roundCount: '',
    startTime: '',
    playerCap: '',
    bestOf: '1',
    playoffBestOf: '3',
    cutTo: '',
    seedMethod: 'registration',
    visibility: 'public',
    roundTimerMinutes: '',
    gameTimeLimit: '',
    ratedGames: false,
    requireDeckRegistration: false,
    hideDecklists: false,
    sasMin: '',
    sasMax: '',
    deckSwapPolicy: 'locked',
    triad: false,
    sasChainHandicap: false,
    chainsPerMatchWin: '',
    allowedSets: [],
    bannedHouses: [],
    requiredHouses: []
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
    const set = (field) => (event) => setForm({ ...form, [field]: event.target.value });

    const statuses = [
        ['', t('All')],
        ['registration', t('Open Registration')],
        ['active', t('In Progress')],
        ['complete', t('Completed')]
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
                        <div className='grid gap-3 md:grid-cols-2'>
                            <div>
                                <Label htmlFor='tournamentName'>{t('Name')}</Label>
                                <Input
                                    id='tournamentName'
                                    value={form.name}
                                    onChange={set('name')}
                                    placeholder={t('Friday Night Archon')}
                                />
                            </div>
                            <div>
                                <Label htmlFor='tournamentFormat'>{t('Format')}</Label>
                                <select
                                    id='tournamentFormat'
                                    className={selectClass}
                                    value={form.format}
                                    onChange={set('format')}
                                >
                                    <option value='swiss'>{t('Swiss')}</option>
                                    <option value='single-elim'>{t('Single Elimination')}</option>
                                    <option value='double-elim'>{t('Double Elimination')}</option>
                                    <option value='round-robin'>{t('Round Robin')}</option>
                                </select>
                            </div>
                            <div>
                                <Label htmlFor='tournamentGameFormat'>{t('Game Format')}</Label>
                                <select
                                    id='tournamentGameFormat'
                                    className={selectClass}
                                    value={form.gameFormat}
                                    onChange={set('gameFormat')}
                                >
                                    <option value='archon'>{t('Archon')}</option>
                                    <option value='sealed'>{t('Sealed')}</option>
                                    <option value='alliance'>{t('Alliance')}</option>
                                    {/* ARCHON: Reversal is hidden from the UI for
                                        now; the engine still supports it. */}
                                    <option value='adaptive-bo1'>
                                        {t('Adaptive (play, swap, chain bid)')}
                                    </option>
                                </select>
                            </div>
                            <div>
                                <Label htmlFor='tournamentMode'>{t('Mode')}</Label>
                                <select
                                    id='tournamentMode'
                                    className={selectClass}
                                    value={form.mode}
                                    onChange={set('mode')}
                                >
                                    <option value='online'>
                                        {t('Online (games created automatically)')}
                                    </option>
                                    <option value='irl'>{t('In Person')}</option>
                                    {/* ARCHON: one standing, played both ways.
                                        Tables open on demand rather than at
                                        pairing, because the organizer cannot
                                        know from here which matches are being
                                        played across a table with cards. */}
                                    <option value='hybrid'>
                                        {t('Hybrid (players open their own online tables)')}
                                    </option>
                                </select>
                            </div>
                            {/* ARCHON (N14): pacing is the single biggest
                                decision about how an event will feel to play
                                in, so it sits with format and mode rather than
                                behind "advanced". */}
                            <div>
                                <Label htmlFor='tournamentPacing'>{t('Pacing')}</Label>
                                <select
                                    id='tournamentPacing'
                                    className={selectClass}
                                    value={form.pacing}
                                    onChange={set('pacing')}
                                >
                                    <option value='live'>
                                        {t('Live - played in one sitting')}
                                    </option>
                                    <option value='async'>
                                        {t('Asynchronous - players schedule their own matches')}
                                    </option>
                                </select>
                            </div>
                            {form.pacing === 'async' && (
                                <div>
                                    <Label htmlFor='tournamentDeadlineDays'>
                                        {t('Days per round')}
                                    </Label>
                                    <Input
                                        id='tournamentDeadlineDays'
                                        type='number'
                                        min='1'
                                        max='30'
                                        value={form.roundDeadlineDays}
                                        onChange={set('roundDeadlineDays')}
                                    />
                                    <div className='mt-1 text-xs text-muted'>
                                        {t(
                                            'Players arrange their own match time inside this window. You are told when a deadline passes with matches outstanding.'
                                        )}
                                    </div>
                                </div>
                            )}
                            {form.format === 'swiss' && (
                                <>
                                    <div>
                                        <Label htmlFor='tournamentRounds'>
                                            {t('Swiss rounds (blank = automatic)')}
                                        </Label>
                                        <Input
                                            id='tournamentRounds'
                                            type='number'
                                            min='1'
                                            max='20'
                                            value={form.roundCount}
                                            onChange={set('roundCount')}
                                        />
                                    </div>
                                    <div>
                                        <Label htmlFor='tournamentCut'>
                                            {t('Cut to top (blank = no playoff)')}
                                        </Label>
                                        <select
                                            id='tournamentCut'
                                            className={selectClass}
                                            value={form.cutTo}
                                            onChange={set('cutTo')}
                                        >
                                            <option value=''>{t('No cut')}</option>
                                            <option value='2'>{t('Top 2')}</option>
                                            <option value='4'>{t('Top 4')}</option>
                                            <option value='8'>{t('Top 8')}</option>
                                            <option value='16'>{t('Top 16')}</option>
                                        </select>
                                    </div>
                                </>
                            )}
                            <div>
                                <Label htmlFor='tournamentStart'>{t('Scheduled start')}</Label>
                                <Input
                                    id='tournamentStart'
                                    type='datetime-local'
                                    value={form.startTime}
                                    onChange={set('startTime')}
                                />
                            </div>
                            <div>
                                <Label htmlFor='tournamentBestOf'>{t('Match length')}</Label>
                                <select
                                    id='tournamentBestOf'
                                    className={selectClass}
                                    value={form.bestOf}
                                    onChange={set('bestOf')}
                                >
                                    <option value='1'>{t('Best of 1')}</option>
                                    <option value='3'>{t('Best of 3')}</option>
                                    <option value='5'>{t('Best of 5')}</option>
                                </select>
                            </div>
                        </div>

                        <button
                            type='button'
                            className='text-xs text-muted underline-offset-2 hover:text-foreground hover:underline'
                            onClick={() => setShowAdvanced((open) => !open)}
                        >
                            {showAdvanced ? t('Hide advanced options') : t('Advanced options…')}
                        </button>

                        {showAdvanced && (
                            <div className='grid gap-3 border-t border-border/50 pt-3 md:grid-cols-2'>
                                {form.format === 'swiss' && form.cutTo && (
                                    <div>
                                        <Label htmlFor='tournamentPlayoffBestOf'>
                                            {t('Playoff match length')}
                                        </Label>
                                        <select
                                            id='tournamentPlayoffBestOf'
                                            className={selectClass}
                                            value={form.playoffBestOf}
                                            onChange={set('playoffBestOf')}
                                        >
                                            <option value='1'>{t('Best of 1')}</option>
                                            <option value='3'>{t('Best of 3')}</option>
                                            <option value='5'>{t('Best of 5')}</option>
                                        </select>
                                    </div>
                                )}
                                <div>
                                    <Label htmlFor='tournamentCap'>
                                        {t('Player cap (blank = unlimited; extras waitlist)')}
                                    </Label>
                                    <Input
                                        id='tournamentCap'
                                        type='number'
                                        min='2'
                                        value={form.playerCap}
                                        onChange={set('playerCap')}
                                    />
                                </div>
                                <div>
                                    <Label htmlFor='tournamentSeed'>{t('Seeding')}</Label>
                                    <select
                                        id='tournamentSeed'
                                        className={selectClass}
                                        value={form.seedMethod}
                                        onChange={set('seedMethod')}
                                    >
                                        <option value='registration'>
                                            {t('Registration order')}
                                        </option>
                                        <option value='rating'>{t('By Amber rating')}</option>
                                        <option value='random'>{t('Random')}</option>
                                        <option value='manual'>
                                            {t('Manual (set on roster)')}
                                        </option>
                                    </select>
                                </div>
                                <div>
                                    <Label htmlFor='tournamentVisibility'>{t('Visibility')}</Label>
                                    <select
                                        id='tournamentVisibility'
                                        className={selectClass}
                                        value={form.visibility}
                                        onChange={set('visibility')}
                                    >
                                        <option value='public'>{t('Public')}</option>
                                        <option value='private'>
                                            {t('Private (join code required)')}
                                        </option>
                                    </select>
                                </div>
                                <div>
                                    <Label htmlFor='tournamentTimer'>
                                        {t('Round timer minutes (blank = none)')}
                                    </Label>
                                    <Input
                                        id='tournamentTimer'
                                        type='number'
                                        min='5'
                                        max='240'
                                        value={form.roundTimerMinutes}
                                        onChange={set('roundTimerMinutes')}
                                    />
                                </div>
                                {form.mode !== 'irl' && (
                                    <div>
                                        <Label htmlFor='tournamentGameClock'>
                                            {t('In-game clock minutes per player (blank = none)')}
                                        </Label>
                                        <Input
                                            id='tournamentGameClock'
                                            type='number'
                                            min='10'
                                            max='180'
                                            value={form.gameTimeLimit}
                                            onChange={set('gameTimeLimit')}
                                        />
                                    </div>
                                )}
                                <div>
                                    <Label htmlFor='tournamentSasMin'>
                                        {t('Minimum deck SAS (blank = none)')}
                                    </Label>
                                    <Input
                                        id='tournamentSasMin'
                                        type='number'
                                        min='0'
                                        max='200'
                                        value={form.sasMin}
                                        onChange={set('sasMin')}
                                    />
                                </div>
                                <div>
                                    <Label htmlFor='tournamentSasMax'>
                                        {t('Maximum deck SAS (blank = none)')}
                                    </Label>
                                    <Input
                                        id='tournamentSasMax'
                                        type='number'
                                        min='0'
                                        max='200'
                                        value={form.sasMax}
                                        onChange={set('sasMax')}
                                    />
                                </div>
                                <div>
                                    <Label htmlFor='tournamentSwapPolicy'>{t('Deck rules')}</Label>
                                    <select
                                        id='tournamentSwapPolicy'
                                        className={selectClass}
                                        value={form.triad ? 'triad' : form.deckSwapPolicy}
                                        onChange={(event) => {
                                            const value = event.target.value;
                                            setForm({
                                                ...form,
                                                triad: value === 'triad',
                                                deckSwapPolicy:
                                                    value === 'triad' ? 'locked' : value,
                                                requireDeckRegistration:
                                                    value === 'triad'
                                                        ? true
                                                        : form.requireDeckRegistration
                                            });
                                        }}
                                    >
                                        <option value='locked'>
                                            {t('One deck, locked for the event (Archon standard)')}
                                        </option>
                                        <option value='between-rounds'>
                                            {t('Deck may change between rounds')}
                                        </option>
                                        <option value='triad'>
                                            {t('Triad: 3 decks, opponent bans one each match')}
                                        </option>
                                    </select>
                                </div>
                                <div>
                                    <Label htmlFor='tournamentChainsPerWin'>
                                        {t('Chains gained per match win (Chainbound style)')}
                                    </Label>
                                    <Input
                                        id='tournamentChainsPerWin'
                                        type='number'
                                        min='0'
                                        max='6'
                                        value={form.chainsPerMatchWin}
                                        onChange={set('chainsPerMatchWin')}
                                    />
                                </div>
                                <div className='md:col-span-2'>
                                    <Label>{t('Allowed sets (none checked = all sets)')}</Label>
                                    <div className='flex flex-wrap gap-x-3 gap-y-1'>
                                        {Constants.Expansions.map((expansion) => (
                                            <label
                                                key={expansion.value}
                                                className='flex items-center gap-1 text-sm text-foreground'
                                            >
                                                <input
                                                    type='checkbox'
                                                    checked={form.allowedSets.includes(
                                                        parseInt(expansion.value, 10)
                                                    )}
                                                    onChange={(event) => {
                                                        const id = parseInt(expansion.value, 10);
                                                        setForm({
                                                            ...form,
                                                            allowedSets: event.target.checked
                                                                ? [...form.allowedSets, id]
                                                                : form.allowedSets.filter(
                                                                      (entry) => entry !== id
                                                                  )
                                                        });
                                                    }}
                                                />
                                                {expansion.label}
                                            </label>
                                        ))}
                                    </div>
                                </div>
                                <div className='md:col-span-2'>
                                    <Label>{t('Banned houses')}</Label>
                                    <div className='flex flex-wrap gap-x-3 gap-y-1'>
                                        {houseOptions.map(([code, label]) => (
                                            <label
                                                key={code}
                                                className='flex items-center gap-1 text-sm text-foreground'
                                            >
                                                <input
                                                    type='checkbox'
                                                    checked={form.bannedHouses.includes(code)}
                                                    onChange={(event) =>
                                                        setForm({
                                                            ...form,
                                                            bannedHouses: event.target.checked
                                                                ? [...form.bannedHouses, code]
                                                                : form.bannedHouses.filter(
                                                                      (entry) => entry !== code
                                                                  ),
                                                            requiredHouses:
                                                                form.requiredHouses.filter(
                                                                    (entry) => entry !== code
                                                                )
                                                        })
                                                    }
                                                />
                                                {t(label)}
                                            </label>
                                        ))}
                                    </div>
                                </div>
                                <div className='md:col-span-2'>
                                    <Label>{t('Required houses (max 3)')}</Label>
                                    <div className='flex flex-wrap gap-x-3 gap-y-1'>
                                        {houseOptions.map(([code, label]) => (
                                            <label
                                                key={code}
                                                className='flex items-center gap-1 text-sm text-foreground'
                                            >
                                                <input
                                                    type='checkbox'
                                                    checked={form.requiredHouses.includes(code)}
                                                    disabled={
                                                        !form.requiredHouses.includes(code) &&
                                                        form.requiredHouses.length >= 3
                                                    }
                                                    onChange={(event) =>
                                                        setForm({
                                                            ...form,
                                                            requiredHouses: event.target.checked
                                                                ? [...form.requiredHouses, code]
                                                                : form.requiredHouses.filter(
                                                                      (entry) => entry !== code
                                                                  ),
                                                            bannedHouses: form.bannedHouses.filter(
                                                                (entry) => entry !== code
                                                            )
                                                        })
                                                    }
                                                />
                                                {t(label)}
                                            </label>
                                        ))}
                                    </div>
                                </div>
                                <label className='flex items-center gap-2 text-sm text-foreground'>
                                    <input
                                        type='checkbox'
                                        checked={form.sasChainHandicap}
                                        onChange={(event) =>
                                            setForm({
                                                ...form,
                                                sasChainHandicap: event.target.checked
                                            })
                                        }
                                    />
                                    {t('SAS chain handicap (stronger deck starts chained)')}
                                </label>
                                <label className='flex items-center gap-2 text-sm text-foreground'>
                                    <input
                                        type='checkbox'
                                        checked={form.ratedGames}
                                        onChange={(event) =>
                                            setForm({ ...form, ratedGames: event.target.checked })
                                        }
                                    />
                                    {t('Rated event (games move Amber)')}
                                </label>
                                <label className='flex items-center gap-2 text-sm text-foreground'>
                                    <input
                                        type='checkbox'
                                        checked={form.requireDeckRegistration}
                                        onChange={(event) =>
                                            setForm({
                                                ...form,
                                                requireDeckRegistration: event.target.checked
                                            })
                                        }
                                    />
                                    {t('Require deck registration (decks lock at start)')}
                                </label>
                                <label className='flex items-center gap-2 text-sm text-foreground'>
                                    <input
                                        type='checkbox'
                                        checked={form.hideDecklists}
                                        onChange={(event) =>
                                            setForm({
                                                ...form,
                                                hideDecklists: event.target.checked
                                            })
                                        }
                                    />
                                    {t('Hide registered decks from other players')}
                                </label>
                            </div>
                        )}

                        <div>
                            <Label htmlFor='tournamentDescription'>{t('Description')}</Label>
                            <textarea
                                id='tournamentDescription'
                                className={`${selectClass} min-h-20`}
                                value={form.description}
                                maxLength={4000}
                                onChange={set('description')}
                            />
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
