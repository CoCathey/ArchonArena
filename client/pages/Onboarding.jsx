import React, { useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Input, toast } from '@heroui/react';
import { Navigate, useNavigate } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import Avatar from '../Components/Site/Avatar';
import DokImport from '../Components/Decks/DokImport';
import { COUNTRIES, statesForCountry } from '../geo';
import { toBase64 } from '../util.jsx';
import {
    useSetLocationMutation,
    useGetClubsQuery,
    useClubActionMutation,
    useJoinClubByCodeMutation,
    useSaveDeckMutation,
    useSetAvatarMutation,
    useCompleteOnboardingMutation
} from '../redux/api';

const DECK_UUID_REGEX =
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

const selectClass =
    'w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none dark:border-border/80 dark:bg-surface-secondary/85';

/**
 * ARCHON: first-run setup wizard (Phase 9). Shown once after a new
 * account's first login; every step is skippable. Location, clubs, deck
 * import, and avatar all reuse the same endpoints as their standalone
 * pages - this is just a friendlier front door.
 */
const Onboarding = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const user = useSelector((state) => state.account.user);
    const token = useSelector((state) => state.auth.token);

    const [step, setStep] = useState(0);

    // Step 1: location
    const [country, setCountry] = useState('');
    const [state, setStateValue] = useState('');
    const [setLocation, setLocationState] = useSetLocationMutation();

    // Step 2: clubs
    const [joinCode, setJoinCode] = useState('');
    const [clubQuery, setClubQuery] = useState('');
    const [joinedClubs, setJoinedClubs] = useState([]);
    const { data: clubData } = useGetClubsQuery(
        { query: clubQuery || undefined },
        { skip: step !== 1 }
    );
    const [clubAction, clubActionState] = useClubActionMutation();
    const [joinByCode, joinByCodeState] = useJoinClubByCodeMutation();

    // Step 3: decks
    const [deckLink, setDeckLink] = useState('');
    const [importedDecks, setImportedDecks] = useState([]);
    const [saveDeck, saveDeckState] = useSaveDeckMutation();

    // Step 4: avatar
    const fileInput = useRef(null);
    const [avatarPreview, setAvatarPreview] = useState(null);
    const [avatarFile, setAvatarFile] = useState(null);
    const [avatarUploaded, setAvatarUploaded] = useState(false);
    const [setAvatar, setAvatarState] = useSetAvatarMutation();

    const [completeOnboarding, completeState] = useCompleteOnboardingMutation();

    if (!user && !token) {
        return <Navigate to='/login' replace />;
    }

    if (!user) {
        return <div className='py-10 text-center text-muted'>{t('Loading...')}</div>;
    }

    const finish = async () => {
        try {
            await completeOnboarding().unwrap();
        } catch {
            // Non-fatal: the wizard will simply be offered again next login
        }

        toast.success(t("You're all set - welcome to the Arena!"));
        navigate('/');
    };

    const saveLocation = async () => {
        if (!country) {
            setStep(1);
            return;
        }

        try {
            const result = await setLocation({
                country: country || null,
                state: state || null
            }).unwrap();

            if (result.success) {
                setStep(1);
            } else {
                toast.danger(result.message || t('Could not save location'));
            }
        } catch {
            toast.danger(t('Could not save location'));
        }
    };

    const joinClubByCode = async () => {
        try {
            const result = await joinByCode(joinCode).unwrap();

            if (result.success) {
                toast.success(t('Joined {{name}}', { name: result.name }));
                setJoinedClubs((current) => [...current, { id: result.id, name: result.name }]);
                setJoinCode('');
            } else {
                toast.danger(result.message || t('Could not join club'));
            }
        } catch {
            toast.danger(t('Could not join club'));
        }
    };

    const joinClub = async (club) => {
        try {
            const result = await clubAction({ id: club.id, action: 'join' }).unwrap();

            if (result.success) {
                toast.success(t('Joined {{name}}', { name: club.name }));
                setJoinedClubs((current) => [...current, { id: club.id, name: club.name }]);
            } else {
                toast.danger(result.message || t('Could not join club'));
            }
        } catch {
            toast.danger(t('Could not join club'));
        }
    };

    const importDeck = async () => {
        const match = deckLink.match(DECK_UUID_REGEX);

        if (!match) {
            toast.danger(t('That does not look like a Master Vault deck link or code'));
            return;
        }

        try {
            const result = await saveDeck({ uuid: match[0] }).unwrap();

            if (result.success) {
                const name = result.deck?.name || match[0];
                toast.success(t('Imported {{name}}', { name }));
                setImportedDecks((current) => [...current, name]);
                setDeckLink('');
            } else {
                toast.danger(result.message || t('Could not import that deck'));
            }
        } catch (err) {
            toast.danger(err?.data?.message || t('Could not import that deck'));
        }
    };

    const uploadAvatar = async () => {
        if (!avatarFile) {
            return;
        }

        if (avatarFile.size > 100 * 1024) {
            toast.danger(t('Image must be less than 100KB in size'));
            return;
        }

        try {
            const base64 = await toBase64(avatarFile);
            const result = await setAvatar(base64).unwrap();

            if (result.success) {
                setAvatarUploaded(true);
                toast.success(t('Profile picture saved'));
            } else {
                toast.danger(result.message || t('Could not save that image'));
            }
        } catch {
            toast.danger(t('Could not save that image'));
        }
    };

    const stateOptions = statesForCountry(country);
    const clubs = (clubData?.clubs || []).slice(0, 6);
    const joinedIds = joinedClubs.map((club) => club.id);

    const steps = [
        t('Where are you from?'),
        t('Join a club'),
        t('Import your decks'),
        t('Add a profile picture')
    ];

    const stepFooter = (onContinue, continueLabel, pending) => (
        <div className='mt-5 flex items-center justify-between'>
            <div>
                {step > 0 && (
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        onPress={() => setStep((current) => current - 1)}
                    >
                        {t('Back')}
                    </HeroButton>
                )}
            </div>
            <div className='flex items-center gap-2'>
                {step < steps.length - 1 ? (
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        onPress={() => setStep((current) => current + 1)}
                    >
                        {t('Skip')}
                    </HeroButton>
                ) : (
                    <HeroButton size='sm' variant='tertiary' onPress={finish}>
                        {t('Skip')}
                    </HeroButton>
                )}
                <HeroButton size='sm' variant='primary' isPending={pending} onPress={onContinue}>
                    {continueLabel}
                </HeroButton>
            </div>
        </div>
    );

    return (
        <div className='mx-auto w-full max-w-2xl'>
            <div className='mb-4 text-center'>
                <h1 className='text-2xl font-extrabold text-foreground'>
                    {t('Welcome to Archon Arena, {{name}}!', { name: user.username })}
                </h1>
                <p className='mt-1 text-sm text-muted'>
                    {t("Let's set up your profile - everything here is optional.")}
                </p>
            </div>

            <div className='mb-4 flex items-center justify-center gap-2'>
                {steps.map((title, index) => (
                    <button
                        key={title}
                        type='button'
                        onClick={() => setStep(index)}
                        className={
                            'h-2.5 w-2.5 rounded-full transition-colors ' +
                            (index === step
                                ? 'bg-amber-400'
                                : index < step
                                ? 'bg-amber-400/50'
                                : 'bg-border')
                        }
                        aria-label={title}
                    />
                ))}
            </div>

            <Panel title={`${step + 1}/${steps.length} - ${steps[step]}`}>
                {step === 0 && (
                    <>
                        <p className='mb-3 text-sm text-muted'>
                            {t(
                                'Your country and state place you on regional, country, and state leaderboards. You can change this any time from your profile.'
                            )}
                        </p>
                        <div className='grid gap-2 md:grid-cols-2'>
                            <select
                                className={selectClass}
                                value={country}
                                onChange={(event) => {
                                    setCountry(event.target.value);
                                    setStateValue('');
                                }}
                            >
                                <option value=''>{t('Select your country')}</option>
                                {COUNTRIES.map(([code, name]) => (
                                    <option key={code} value={code}>
                                        {name}
                                    </option>
                                ))}
                            </select>
                            {stateOptions ? (
                                <select
                                    className={selectClass}
                                    value={state}
                                    disabled={!country}
                                    onChange={(event) => setStateValue(event.target.value)}
                                >
                                    <option value=''>{t('State / Province (optional)')}</option>
                                    {stateOptions.map((name) => (
                                        <option key={name} value={name}>
                                            {name}
                                        </option>
                                    ))}
                                </select>
                            ) : (
                                <input
                                    type='text'
                                    className={selectClass}
                                    value={state}
                                    disabled={!country}
                                    maxLength={60}
                                    placeholder={t('State / Province (optional)')}
                                    onChange={(event) => setStateValue(event.target.value)}
                                />
                            )}
                        </div>
                        {stepFooter(
                            saveLocation,
                            country ? t('Save & continue') : t('Continue'),
                            setLocationState.isLoading
                        )}
                    </>
                )}

                {step === 1 && (
                    <>
                        <p className='mb-3 text-sm text-muted'>
                            {t(
                                'Clubs connect you with a local scene or store. Have an invite code from a club owner? Enter it here - or search for a club to join.'
                            )}
                        </p>
                        <div className='mb-4 flex gap-2'>
                            <Input
                                className='flex-1'
                                placeholder={t('Invite code (e.g. XK7PQ2MB)')}
                                value={joinCode}
                                onChange={(event) => setJoinCode(event.target.value)}
                            />
                            <HeroButton
                                variant='primary'
                                isDisabled={!joinCode.trim()}
                                isPending={joinByCodeState.isLoading}
                                onPress={joinClubByCode}
                            >
                                {t('Join')}
                            </HeroButton>
                        </div>
                        <Input
                            className='mb-2 w-full'
                            placeholder={t('Search clubs by name')}
                            value={clubQuery}
                            onChange={(event) => setClubQuery(event.target.value)}
                        />
                        <div className='divide-y divide-border/40'>
                            {clubs.map((club) => (
                                <div
                                    key={club.id}
                                    className='flex items-center justify-between gap-2 py-2'
                                >
                                    <div className='min-w-0'>
                                        <div className='truncate font-semibold text-foreground'>
                                            {club.name}
                                        </div>
                                        <div className='text-xs text-muted'>
                                            {t('{{count}} members', {
                                                count: club.memberCount
                                            })}
                                        </div>
                                    </div>
                                    {joinedIds.includes(club.id) ? (
                                        <span className='text-sm font-semibold text-green-400'>
                                            {t('Joined')}
                                        </span>
                                    ) : (
                                        <HeroButton
                                            size='sm'
                                            variant='tertiary'
                                            isPending={clubActionState.isLoading}
                                            onPress={() => joinClub(club)}
                                        >
                                            {t('Join')}
                                        </HeroButton>
                                    )}
                                </div>
                            ))}
                            {clubs.length === 0 && (
                                <div className='py-3 text-sm text-muted'>
                                    {t('No clubs found - you can create one later from Community.')}
                                </div>
                            )}
                        </div>
                        {stepFooter(() => setStep(2), t('Continue'))}
                    </>
                )}

                {step === 2 && (
                    <>
                        <p className='mb-2 text-sm font-semibold text-foreground'>
                            {t('Import your whole collection from Decks of KeyForge')}
                        </p>
                        <DokImport compact />

                        <div className='my-4 flex items-center gap-3'>
                            <span className='h-px flex-1 bg-border/60' />
                            <span className='text-xs uppercase tracking-wide text-muted'>
                                {t('or add a single deck')}
                            </span>
                            <span className='h-px flex-1 bg-border/60' />
                        </div>

                        <p className='mb-3 text-sm text-muted'>
                            {t(
                                'Paste a deck link (or deck code) from the official Master Vault at keyforgegame.com.'
                            )}
                        </p>
                        <div className='flex gap-2'>
                            <Input
                                className='flex-1'
                                placeholder='https://www.keyforgegame.com/deck-details/...'
                                value={deckLink}
                                onChange={(event) => setDeckLink(event.target.value)}
                            />
                            <HeroButton
                                variant='primary'
                                isDisabled={!deckLink.trim()}
                                isPending={saveDeckState.isLoading}
                                onPress={importDeck}
                            >
                                {t('Import')}
                            </HeroButton>
                        </div>
                        {importedDecks.length > 0 && (
                            <ul className='mt-3 space-y-1 text-sm'>
                                {importedDecks.map((name) => (
                                    <li key={name} className='text-green-400'>
                                        ✓ {name}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {stepFooter(() => setStep(3), t('Continue'))}
                    </>
                )}

                {step === 3 && (
                    <>
                        <p className='mb-3 text-sm text-muted'>
                            {t(
                                'Add a picture so opponents recognise you. PNG or JPEG, up to 100KB.'
                            )}
                        </p>
                        <div className='flex items-center gap-3'>
                            {avatarPreview ? (
                                <img
                                    className='h-10 w-10 rounded-full object-cover'
                                    src={avatarPreview}
                                    alt={user.username}
                                />
                            ) : (
                                <Avatar imgPath={user.avatar} />
                            )}
                            <HeroButton
                                variant='tertiary'
                                onPress={() => fileInput.current?.click()}
                            >
                                {t('Choose image')}
                            </HeroButton>
                            {avatarFile && !avatarUploaded && (
                                <HeroButton
                                    variant='primary'
                                    isPending={setAvatarState.isLoading}
                                    onPress={uploadAvatar}
                                >
                                    {t('Upload')}
                                </HeroButton>
                            )}
                            {avatarUploaded && (
                                <span className='text-sm font-semibold text-green-400'>
                                    {t('Saved')}
                                </span>
                            )}
                        </div>
                        <input
                            accept='image/png,image/jpeg'
                            hidden
                            ref={fileInput}
                            type='file'
                            onChange={(event) => {
                                const file = event.currentTarget.files?.[0];
                                if (!file) {
                                    return;
                                }
                                setAvatarFile(file);
                                setAvatarUploaded(false);
                                setAvatarPreview(URL.createObjectURL(file));
                            }}
                        />
                        {stepFooter(finish, t('Finish'), completeState.isLoading)}
                    </>
                )}
            </Panel>

            <div className='mt-3 text-center'>
                <button
                    type='button'
                    className='text-sm text-muted underline-offset-2 hover:underline'
                    onClick={finish}
                >
                    {t('Skip setup for now')}
                </button>
            </div>
        </div>
    );
};

Onboarding.displayName = 'Onboarding';

export default Onboarding;
