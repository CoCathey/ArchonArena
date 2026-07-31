import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Label, toast } from '@heroui/react';
import { useNavigate } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import {
    useCreateTeamMutation,
    useGetTeamLeaderboardQuery,
    useGetTeamsQuery,
    useJoinTeamByCodeMutation
} from '../redux/api';

const inputClass =
    'w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none';

/**
 * ARCHON (N7): teams - rosters that enter events as a unit, with their own
 * ladder. Deliberately separate from clubs: a club is a place you belong to,
 * a team is a roster you compete with, and the same player is usually in one
 * of each.
 */
const Teams = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const user = useSelector((state) => state.account.user);
    const [query, setQuery] = useState('');
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [code, setCode] = useState('');
    const { data, refetch } = useGetTeamsQuery({ query: query || undefined });
    const { data: ladder } = useGetTeamLeaderboardQuery({ pool: 'archon' });
    const [createTeam] = useCreateTeamMutation();
    const [joinByCode] = useJoinTeamByCodeMutation();

    const onCreate = async () => {
        try {
            const result = await createTeam({ name, description }).unwrap();

            if (result.success) {
                toast.success(t('Team created'));
                setName('');
                setDescription('');
                navigate(`/community/teams/${result.id}`);
            } else {
                toast.danger(result.message || t('Could not create the team'));
            }
        } catch {
            toast.danger(t('Could not create the team'));
        }
    };

    const onJoin = async () => {
        try {
            const result = await joinByCode(code).unwrap();

            if (result.success) {
                toast.success(t('Joined {{name}}', { name: result.name }));
                setCode('');
                navigate(`/community/teams/${result.id}`);
            } else {
                toast.danger(result.message || t('Could not join'));
            }
        } catch {
            toast.danger(t('Could not join'));
        }
    };

    return (
        <div className='mx-auto w-full max-w-3xl space-y-4'>
            <Panel title={t('Teams')}>
                <p className='mb-3 text-xs text-muted'>
                    {t(
                        'A team enters events as a unit and carries its own rating, earned only from team events - never averaged from its members.'
                    )}
                </p>
                <div className='flex gap-2'>
                    <input
                        type='text'
                        className={inputClass}
                        placeholder={t('Search teams')}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                    <HeroButton size='sm' variant='tertiary' onPress={() => refetch()}>
                        {t('Search')}
                    </HeroButton>
                </div>
                <div className='mt-3 space-y-1'>
                    {(data?.teams || []).map((team) => (
                        <div
                            key={team.id}
                            className='flex items-center gap-2 rounded bg-surface-secondary/50 px-2 py-1.5 text-sm'
                        >
                            <Link
                                href={`/community/teams/${team.id}`}
                                className='font-semibold text-foreground hover:text-amber-300 hover:underline'
                            >
                                {team.name}
                            </Link>
                            {team.clubName && (
                                <span className='text-xs text-muted'>{team.clubName}</span>
                            )}
                            <span className='ml-auto text-xs text-muted'>
                                {t('{{count}} members', { count: team.memberCount })}
                            </span>
                            {team.rating !== null && (
                                <span className='text-xs text-amber-300'>{team.rating}</span>
                            )}
                        </div>
                    ))}
                    {data?.teams?.length === 0 && (
                        <div className='text-sm text-muted'>{t('No teams yet.')}</div>
                    )}
                </div>
            </Panel>

            {ladder?.entries?.length > 0 && (
                <Panel title={t('Team ladder')}>
                    <table className='w-full text-sm'>
                        <thead>
                            <tr className='text-left text-xs uppercase text-muted'>
                                <th className='py-1'>{t('#')}</th>
                                <th>{t('Team')}</th>
                                <th className='text-right'>{t('Rating')}</th>
                                <th className='text-right'>{t('Events')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {ladder.entries.map((entry) => (
                                <tr key={entry.teamId} className='border-t border-border/40'>
                                    <td className='py-1 text-muted'>{entry.rank}</td>
                                    <td>
                                        <Link
                                            href={`/community/teams/${entry.teamId}`}
                                            className='font-semibold text-foreground hover:text-amber-300 hover:underline'
                                        >
                                            {entry.name}
                                        </Link>
                                    </td>
                                    <td className='text-right text-amber-300'>{entry.rating}</td>
                                    <td className='text-right text-muted'>{entry.eventsPlayed}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </Panel>
            )}

            {user && (
                <>
                    <Panel title={t('Join a team')}>
                        <div className='flex gap-2'>
                            <input
                                type='text'
                                className={inputClass + ' uppercase'}
                                placeholder={t('Join code')}
                                value={code}
                                onChange={(event) => setCode(event.target.value.toUpperCase())}
                            />
                            <HeroButton
                                size='sm'
                                variant='primary'
                                isDisabled={code.length < 4}
                                onPress={onJoin}
                            >
                                {t('Join')}
                            </HeroButton>
                        </div>
                    </Panel>

                    <Panel title={t('Start a team')}>
                        <div className='space-y-2'>
                            <div>
                                <Label>{t('Name')}</Label>
                                <input
                                    type='text'
                                    className={inputClass}
                                    value={name}
                                    maxLength={40}
                                    onChange={(event) => setName(event.target.value)}
                                />
                            </div>
                            <div>
                                <Label>{t('Description')}</Label>
                                <textarea
                                    className={inputClass + ' min-h-20'}
                                    value={description}
                                    maxLength={2000}
                                    onChange={(event) => setDescription(event.target.value)}
                                />
                            </div>
                            <HeroButton
                                size='sm'
                                variant='primary'
                                isDisabled={name.trim().length < 3}
                                onPress={onCreate}
                            >
                                {t('Create Team')}
                            </HeroButton>
                        </div>
                    </Panel>
                </>
            )}
        </div>
    );
};

Teams.displayName = 'Teams';

export default Teams;
