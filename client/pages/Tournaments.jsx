import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Input, Label, toast } from '@heroui/react';
import { useNavigate } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import { useCreateTournamentMutation, useListEventsQuery } from '../redux/api';

const selectClass =
    'w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none dark:border-border/80 dark:bg-surface-secondary/85';

/**
 * ARCHON: tournament list + creation (Phase 7). Any logged-in player can
 * organize an event - that is the point for local scenes.
 */
const Tournaments = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const user = useSelector((state) => state.account.user);
    const [statusFilter, setStatusFilter] = useState('');
    const [showCreate, setShowCreate] = useState(false);
    const [form, setForm] = useState({
        name: '',
        description: '',
        format: 'swiss',
        gameFormat: 'archon',
        mode: 'online',
        roundCount: ''
    });

    const { data } = useListEventsQuery(statusFilter ? { status: statusFilter } : undefined);
    const [createTournament, createState] = useCreateTournamentMutation();

    const tournaments = data?.tournaments || [];

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
                roundCount: form.roundCount || undefined
            }).unwrap();

            if (result.success) {
                toast.success(t('Tournament created'));
                setShowCreate(false);
                navigate(`/tournaments/${result.id}`);
            } else {
                toast.error(result.message || t('Could not create tournament'));
            }
        } catch {
            toast.error(t('Could not create tournament'));
        }
    };

    return (
        <div className='mx-auto w-full max-w-4xl space-y-4'>
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
                                    onChange={(event) =>
                                        setForm({ ...form, name: event.target.value })
                                    }
                                    placeholder={t('Friday Night Archon')}
                                />
                            </div>
                            <div>
                                <Label htmlFor='tournamentFormat'>{t('Format')}</Label>
                                <select
                                    id='tournamentFormat'
                                    className={selectClass}
                                    value={form.format}
                                    onChange={(event) =>
                                        setForm({ ...form, format: event.target.value })
                                    }
                                >
                                    <option value='swiss'>{t('Swiss')}</option>
                                    <option value='single-elim'>{t('Single Elimination')}</option>
                                </select>
                            </div>
                            <div>
                                <Label htmlFor='tournamentGameFormat'>{t('Game Format')}</Label>
                                <select
                                    id='tournamentGameFormat'
                                    className={selectClass}
                                    value={form.gameFormat}
                                    onChange={(event) =>
                                        setForm({ ...form, gameFormat: event.target.value })
                                    }
                                >
                                    <option value='archon'>{t('Archon')}</option>
                                    <option value='sealed'>{t('Sealed')}</option>
                                    <option value='alliance'>{t('Alliance')}</option>
                                </select>
                            </div>
                            <div>
                                <Label htmlFor='tournamentMode'>{t('Mode')}</Label>
                                <select
                                    id='tournamentMode'
                                    className={selectClass}
                                    value={form.mode}
                                    onChange={(event) =>
                                        setForm({ ...form, mode: event.target.value })
                                    }
                                >
                                    <option value='online'>{t('Online')}</option>
                                    <option value='irl'>{t('In Person')}</option>
                                </select>
                            </div>
                            {form.format === 'swiss' && (
                                <div>
                                    <Label htmlFor='tournamentRounds'>
                                        {t('Rounds (blank = automatic)')}
                                    </Label>
                                    <Input
                                        id='tournamentRounds'
                                        type='number'
                                        min='1'
                                        max='20'
                                        value={form.roundCount}
                                        onChange={(event) =>
                                            setForm({ ...form, roundCount: event.target.value })
                                        }
                                    />
                                </div>
                            )}
                        </div>
                        <div>
                            <Label htmlFor='tournamentDescription'>{t('Description')}</Label>
                            <textarea
                                id='tournamentDescription'
                                className={`${selectClass} min-h-20`}
                                value={form.description}
                                maxLength={2000}
                                onChange={(event) =>
                                    setForm({ ...form, description: event.target.value })
                                }
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
                                    {tournament.format === 'swiss' ? t('Swiss') : t('Single Elim')}
                                    {' - '}
                                    {tournament.gameFormat}
                                    {tournament.mode === 'irl' ? ` - ${t('In Person')}` : ''}
                                </span>
                                <span className='ml-auto text-xs text-muted'>
                                    {t('{{count}} players', { count: tournament.playerCount })}
                                    {' - '}
                                    {tournament.status === 'registration'
                                        ? t('Open Registration')
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
        </div>
    );
};

Tournaments.displayName = 'Tournaments';

export default Tournaments;
