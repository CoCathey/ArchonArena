import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, toast } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import Avatar from '../Components/Site/Avatar';
import {
    useGetAdminBotsQuery,
    useGetAdminSettingsQuery,
    useSaveAdminBotMutation,
    useSaveAdminSettingsMutation
} from '../redux/api';

/**
 * ARCHON (F9): the Bot Settings screen.
 *
 * The practice bots are thirteen characters - one per house - rather than a
 * block of settings, so they get a screen of their own: who each one is, what
 * it looks like, what it says about itself, and whether it plays. The handful
 * of knobs that govern all of them (how many tables at once, the joiner grace
 * period, the concede cap) ride along at the top, read from and written to
 * the ordinary settings service; only where they are edited changed.
 */

const inputClass =
    'w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none dark:border-border/80 dark:bg-surface-secondary/85';

/** Strip the data-URL preamble: the API wants raw base64, as avatars do. */
const toBase64 = (file) =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });

/** One bot: its picture, its name, what it plays, and its profile. */
const BotCard = ({ bot, onSave, saving }) => {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(bot);
    const [picture, setPicture] = useState(null);
    const fileInput = useRef(null);

    useEffect(() => {
        setDraft(bot);
        setPicture(null);
    }, [bot]);

    const edit = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
    const dirty =
        picture !== null ||
        ['username', 'bio', 'country', 'state', 'enabled'].some(
            (field) => (draft[field] ?? '') !== (bot[field] ?? '')
        );

    return (
        <div className='rounded-md border border-border/55 bg-surface-secondary/28 p-3'>
            <div className='flex flex-wrap items-start gap-3'>
                <div className='flex flex-col items-center gap-1.5'>
                    <Avatar imgPath={draft.avatar} />
                    <HeroButton
                        size='sm'
                        variant='tertiary'
                        className='!h-7 !px-2 text-xs'
                        onPress={() => fileInput.current?.click()}
                    >
                        {t('Picture')}
                    </HeroButton>
                    <input
                        ref={fileInput}
                        type='file'
                        accept='image/png,image/jpeg'
                        className='hidden'
                        onChange={async (event) => {
                            const file = event.target.files?.[0];

                            if (file) {
                                setPicture(await toBase64(file));
                            }

                            event.target.value = '';
                        }}
                    />
                    {picture !== null && (
                        <span className='text-[11px] text-emerald-600 dark:text-emerald-400'>
                            {t('New picture ready')}
                        </span>
                    )}
                </div>

                <div className='min-w-[12rem] flex-1 space-y-2'>
                    <div className='flex flex-wrap items-center gap-2'>
                        <input
                            type='text'
                            className={inputClass + ' !w-44'}
                            value={draft.username || ''}
                            maxLength={15}
                            onChange={(event) => edit('username', event.target.value)}
                        />
                        <span className='rounded border border-border/55 px-2 py-1 text-xs text-muted'>
                            {bot.label}
                        </span>
                        <label className='flex items-center gap-1.5 text-xs text-muted'>
                            <input
                                type='checkbox'
                                checked={!!draft.enabled}
                                onChange={(event) => edit('enabled', event.target.checked)}
                            />
                            {t('Plays')}
                        </label>
                        <span
                            className={`text-xs ${
                                bot.deckCount > 0
                                    ? 'text-muted'
                                    : 'text-amber-600 dark:text-amber-400'
                            }`}
                        >
                            {bot.deckCount > 0
                                ? t('{{count}} deck(s)', { count: bot.deckCount })
                                : t('no {{house}} decks - cannot host', { house: bot.label })}
                        </span>
                    </div>

                    <textarea
                        className={inputClass + ' h-16 resize-y'}
                        placeholder={t('Profile (shown on the bot’s player page)')}
                        maxLength={500}
                        value={draft.bio || ''}
                        onChange={(event) => edit('bio', event.target.value)}
                    />

                    <div className='flex flex-wrap items-center gap-2'>
                        <input
                            type='text'
                            className={inputClass + ' !w-20 uppercase'}
                            placeholder={t('Country')}
                            maxLength={2}
                            value={draft.country || ''}
                            onChange={(event) => edit('country', event.target.value.toUpperCase())}
                        />
                        <input
                            type='text'
                            className={inputClass + ' !w-40'}
                            placeholder={t('State / province')}
                            maxLength={64}
                            value={draft.state || ''}
                            onChange={(event) => edit('state', event.target.value)}
                        />
                        <HeroButton
                            size='sm'
                            variant='primary'
                            className='!h-8 !px-3 text-xs'
                            isDisabled={!dirty || saving}
                            onPress={() =>
                                onSave({
                                    house: bot.house,
                                    username: draft.username,
                                    bio: draft.bio || '',
                                    country: draft.country || '',
                                    state: draft.state || '',
                                    enabled: !!draft.enabled,
                                    ...(picture ? { avatar: picture } : {})
                                })
                            }
                        >
                            {t('Save')}
                        </HeroButton>
                    </div>
                </div>
            </div>
        </div>
    );
};

const BotAdmin = () => {
    const { t } = useTranslation();
    const { data: botData, isLoading, refetch } = useGetAdminBotsQuery();
    const { data: settingsData, refetch: refetchSettings } = useGetAdminSettingsQuery();
    const [saveBot, { isLoading: saving }] = useSaveAdminBotMutation();
    const [saveSettings] = useSaveAdminSettingsMutation();
    const [knobs, setKnobs] = useState({});

    const section = settingsData?.sections?.bots;

    useEffect(() => {
        if (section) {
            setKnobs(section.overrides || {});
        }
    }, [section]);

    if (isLoading) {
        return <div className='text-sm text-muted'>{t('Loading bots...')}</div>;
    }

    const valueOf = (field, descriptor) =>
        knobs[field] !== undefined ? knobs[field] : descriptor.default;

    const onSaveBot = async (changes) => {
        try {
            const result = await saveBot(changes).unwrap();

            if (result.success) {
                toast.success(t('Bot saved'));
                refetch();
            } else {
                toast.danger(result.message || t('Could not save that bot'));
            }
        } catch (error) {
            toast.danger(error?.data?.message || t('Could not save that bot'));
        }
    };

    const onSaveKnobs = async () => {
        try {
            const result = await saveSettings({ section: 'bots', value: knobs }).unwrap();

            if (result.success) {
                toast.success(t('Settings saved'));
                refetchSettings();
            } else {
                toast.danger(result.message || t('Could not save settings'));
            }
        } catch {
            toast.danger(t('Could not save settings'));
        }
    };

    return (
        <div className='mx-auto w-full max-w-3xl space-y-4'>
            {section && (
                <Panel title={t(section.title)}>
                    <p className='mb-3 text-xs text-muted'>{t(section.description)}</p>
                    <div className='space-y-3'>
                        {Object.entries(section.fields).map(([field, descriptor]) => (
                            <div key={field} className='flex items-center justify-between gap-3'>
                                <span className='text-sm text-foreground/85'>
                                    {t(descriptor.label)}
                                </span>
                                {descriptor.type === 'boolean' ? (
                                    <input
                                        type='checkbox'
                                        checked={!!valueOf(field, descriptor)}
                                        onChange={(event) =>
                                            setKnobs((current) => ({
                                                ...current,
                                                [field]: event.target.checked
                                            }))
                                        }
                                    />
                                ) : (
                                    <input
                                        type='number'
                                        className={inputClass + ' !w-24'}
                                        min={descriptor.min}
                                        max={descriptor.max}
                                        value={valueOf(field, descriptor)}
                                        onChange={(event) =>
                                            setKnobs((current) => ({
                                                ...current,
                                                [field]: Number(event.target.value)
                                            }))
                                        }
                                    />
                                )}
                            </div>
                        ))}
                    </div>
                    <div className='mt-4'>
                        <HeroButton size='sm' variant='primary' onPress={onSaveKnobs}>
                            {t('Save')}
                        </HeroButton>
                    </div>
                </Panel>
            )}

            <Panel title={t('The bots')}>
                <p className='mb-3 text-xs text-muted'>
                    {t(
                        'Each bot plays only decks containing its house. Import decks into a bot’s ' +
                            'account to give it a pool of its own; a bot with none falls back to the ' +
                            'standalone decks, and one with neither cannot host a table.'
                    )}
                </p>
                <div className='space-y-2'>
                    {(botData?.bots || []).map((bot) => (
                        <BotCard key={bot.house} bot={bot} saving={saving} onSave={onSaveBot} />
                    ))}
                </div>
            </Panel>
        </div>
    );
};

BotAdmin.displayName = 'BotAdmin';

export default BotAdmin;
