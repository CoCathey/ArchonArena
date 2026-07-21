import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Input, Label, toast } from '@heroui/react';
import { useNavigate } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import { useCreateClubMutation, useGetClubsQuery } from '../redux/api';

const inputClass =
    'w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none dark:border-border/80 dark:bg-surface-secondary/85';

/**
 * ARCHON: clubs list + creation (Phase 9). Open membership for local
 * scenes, stores, and communities.
 */
const Clubs = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const user = useSelector((state) => state.account.user);
    const [query, setQuery] = useState('');
    const [showCreate, setShowCreate] = useState(false);
    const [form, setForm] = useState({ name: '', description: '' });

    const { data } = useGetClubsQuery(query ? { query } : undefined);
    const [createClub, createState] = useCreateClubMutation();

    const clubs = data?.clubs || [];

    const onCreate = async () => {
        try {
            const result = await createClub(form).unwrap();

            if (result.success) {
                toast.success(t('Club created'));
                navigate(`/community/clubs/${result.id}`);
            } else {
                toast.error(result.message || t('Could not create club'));
            }
        } catch {
            toast.error(t('Could not create club'));
        }
    };

    return (
        <div className='mx-auto w-full max-w-3xl space-y-4'>
            <Panel title={t('Clubs')}>
                <div className='mb-3 flex gap-2'>
                    <Input
                        className='flex-1'
                        placeholder={t('Search clubs...')}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                    {user && (
                        <HeroButton
                            size='sm'
                            variant='primary'
                            onPress={() => setShowCreate((open) => !open)}
                        >
                            {showCreate ? t('Close') : t('Create Club')}
                        </HeroButton>
                    )}
                </div>

                {showCreate && (
                    <div className='mb-4 space-y-3 rounded-md border border-border/60 bg-surface-secondary/50 p-3'>
                        <div>
                            <Label htmlFor='clubName'>{t('Name')}</Label>
                            <Input
                                id='clubName'
                                value={form.name}
                                onChange={(event) => setForm({ ...form, name: event.target.value })}
                                placeholder={t('Austin Archons')}
                            />
                        </div>
                        <div>
                            <Label htmlFor='clubDescription'>{t('Description')}</Label>
                            <textarea
                                id='clubDescription'
                                className={`${inputClass} min-h-20`}
                                maxLength={2000}
                                value={form.description}
                                onChange={(event) =>
                                    setForm({ ...form, description: event.target.value })
                                }
                            />
                        </div>
                        <HeroButton
                            size='sm'
                            variant='primary'
                            isPending={createState.isLoading}
                            onPress={onCreate}
                        >
                            {t('Create')}
                        </HeroButton>
                    </div>
                )}

                {clubs.length === 0 ? (
                    <div className='py-6 text-center text-sm text-muted'>
                        {t('No clubs yet - found one for your scene!')}
                    </div>
                ) : (
                    <div className='space-y-2'>
                        {clubs.map((club) => (
                            <Link
                                key={club.id}
                                href={`/community/clubs/${club.id}`}
                                className='block rounded-md border border-border/60 bg-surface-secondary/50 px-3 py-2 transition hover:border-amber-300/60'
                            >
                                <div className='flex items-center gap-3'>
                                    <span className='font-semibold text-foreground'>
                                        {club.name}
                                    </span>
                                    <span className='ml-auto text-xs text-muted'>
                                        {t('{{count}} members', { count: club.memberCount })}
                                    </span>
                                </div>
                                {club.description && (
                                    <div className='mt-1 line-clamp-2 text-sm text-muted'>
                                        {club.description}
                                    </div>
                                )}
                            </Link>
                        ))}
                    </div>
                )}
            </Panel>
        </div>
    );
};

Clubs.displayName = 'Clubs';

export default Clubs;
