import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Input, Label, toast } from '@heroui/react';
import { useNavigate } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import { clubJoinOutcome } from '../Components/Community/clubJoinOutcome';
import {
    useCreateClubMutation,
    useGetClubInvitationsQuery,
    useGetClubsQuery,
    useJoinClubByCodeMutation
} from '../redux/api';

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
    const [joinCode, setJoinCode] = useState('');

    const { data } = useGetClubsQuery(query ? { query } : undefined);
    const [createClub, createState] = useCreateClubMutation();
    const [joinByCode, joinByCodeState] = useJoinClubByCodeMutation();
    // An invitation raises a notification, and a notification is easy to miss.
    // This is the place a player looks when they remember someone mentioned a
    // club, so the outstanding ones are listed here too.
    const { data: invitationData } = useGetClubInvitationsQuery(undefined, { skip: !user });

    const clubs = data?.clubs || [];
    const invitations = invitationData?.invitations || [];

    const onCreate = async () => {
        try {
            const result = await createClub(form).unwrap();

            if (result.success) {
                toast.success(t('Club created'));
                navigate(`/community/clubs/${result.id}`);
            } else {
                toast.danger(result.message || t('Could not create club'));
            }
        } catch {
            toast.danger(t('Could not create club'));
        }
    };

    // ARCHON: club owners are shown an invite code and told to share it, and
    // until this existed the only box to type one into was the sign-up wizard -
    // which a player who already has an account never sees again. So a code
    // handed to an existing member went nowhere.
    const onJoinByCode = async () => {
        try {
            const result = await joinByCode(joinCode).unwrap();
            const outcome = clubJoinOutcome(result);

            if (!outcome.ok) {
                toast.danger(t(outcome.key));

                return;
            }

            toast.success(t(outcome.key, { name: outcome.name }));
            setJoinCode('');
            // Straight to the club either way: if the join is waiting on the
            // owner, that page is where it says so.
            navigate(`/community/clubs/${result.id}`);
        } catch (err) {
            // The server's reason - "No club matches that join code" - is worth
            // far more than a generic failure when the difference is usually a
            // typo in eight characters.
            toast.danger(err?.data?.message || t('Could not join club'));
        }
    };

    return (
        <div className='mx-auto w-full max-w-3xl space-y-4'>
            <Panel title={t('Grand Alliance Council')}>
                <p className='mb-3 text-sm text-muted'>
                    {t(
                        'The Grand Alliance Council is where playgroups gather. Search the clubs ' +
                            'other players have founded and ask to join, enter an invite code a ' +
                            'club owner gave you, or found a club of your own. A club gives your ' +
                            'group a shared home on the platform: a member roster, your recent ' +
                            'games — online and across the table — and a place to organize.'
                    )}
                </p>
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

                {invitations.length > 0 && (
                    <div className='mb-3 space-y-1 rounded-md border border-amber-300/50 bg-amber-300/10 px-3 py-2'>
                        <div className='text-sm font-semibold text-foreground'>
                            {t('You have been invited')}
                        </div>
                        {invitations.map((invitation) => (
                            <Link
                                key={invitation.id}
                                href={`/community/clubs/${invitation.id}`}
                                className='block text-sm text-muted hover:text-foreground'
                            >
                                {t('{{club}}, by {{owner}}', {
                                    club: invitation.name,
                                    owner: invitation.owner
                                })}
                            </Link>
                        ))}
                    </div>
                )}

                {user && (
                    <div className='mb-3 flex gap-2'>
                        <Input
                            className='flex-1'
                            aria-label={t('Club invite code')}
                            placeholder={t('Have an invite code? (e.g. XK7PQ2MB)')}
                            value={joinCode}
                            onChange={(event) => setJoinCode(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' && joinCode.trim()) {
                                    onJoinByCode();
                                }
                            }}
                        />
                        {/* primary, matching Teams and the sign-up wizard: in
                            `secondary` the enabled and disabled states are a
                            few percent of saturation apart, so the button gives
                            no clue whether it can be pressed. */}
                        <HeroButton
                            size='sm'
                            variant='primary'
                            isDisabled={!joinCode.trim()}
                            isPending={joinByCodeState.isLoading}
                            onPress={onJoinByCode}
                        >
                            {t('Join')}
                        </HeroButton>
                    </div>
                )}

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
