import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Input, toast } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import { COUNTRIES, countryName } from '../geo';
import { useGetStoresQuery, useAddStoreMutation, useRemoveStoreMutation } from '../redux/api';

const selectClass =
    'rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none dark:border-border/80 dark:bg-surface-secondary/85';

const EMPTY_FORM = {
    name: '',
    country: '',
    state: '',
    city: '',
    address: '',
    website: '',
    description: ''
};

/**
 * ARCHON: Play IRL (Phase 9). In-person play hub - a community directory of
 * local game stores / venues (searchable by location, anyone can add one)
 * plus pointers to running in-person tournaments and clubs.
 */
const PlayIrl = () => {
    const { t } = useTranslation();
    const user = useSelector((state) => state.account.user);

    const [query, setQuery] = useState('');
    const [country, setCountry] = useState('');
    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState(EMPTY_FORM);

    const { data } = useGetStoresQuery({
        query: query || undefined,
        country: country || undefined
    });
    const [addStore, addState] = useAddStoreMutation();
    const [removeStore] = useRemoveStoreMutation();

    const stores = data?.stores || [];

    const setField = (field) => (event) => setForm((f) => ({ ...f, [field]: event.target.value }));

    const submit = async () => {
        if (form.name.trim().length < 2) {
            toast.error(t('Enter a store name.'));
            return;
        }

        try {
            const result = await addStore(form).unwrap();

            if (result.success) {
                toast.success(t('Store added. Thanks for helping the community!'));
                setForm(EMPTY_FORM);
                setShowForm(false);
            } else {
                toast.error(result.message || t('Could not add that store.'));
            }
        } catch {
            toast.error(t('Could not add that store.'));
        }
    };

    const onRemove = async (store) => {
        if (!window.confirm(t('Remove {{name}} from the directory?', { name: store.name }))) {
            return;
        }

        try {
            const result = await removeStore(store.id).unwrap();
            if (!result.success) {
                toast.error(result.message || t('Could not remove that store.'));
            }
        } catch {
            toast.error(t('Could not remove that store.'));
        }
    };

    const locationOf = (store) =>
        [store.city, store.state, store.country && countryName(store.country)]
            .filter(Boolean)
            .join(', ');

    return (
        <div className='mx-auto w-full max-w-4xl space-y-4'>
            <Panel title={t('Play In Person')}>
                <p className='text-sm text-muted'>
                    {t(
                        'KeyForge is best shared across a table. Find a local game store or venue below, or run an in-person event with the tournament tools - organizers report results and standings update live.'
                    )}
                </p>
                <div className='mt-3 flex flex-wrap gap-2'>
                    <Link href='/tournaments'>
                        <HeroButton size='sm' variant='primary'>
                            {t('In-person tournaments')}
                        </HeroButton>
                    </Link>
                    <Link href='/community/clubs'>
                        <HeroButton size='sm' variant='tertiary'>
                            {t('Find a club')}
                        </HeroButton>
                    </Link>
                </div>
            </Panel>

            <Panel title={t('Local stores & venues')}>
                <div className='mb-3 flex flex-wrap items-center gap-2'>
                    <Input
                        className='min-w-40 flex-1'
                        placeholder={t('Search by name or city')}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                    <select
                        className={selectClass}
                        value={country}
                        onChange={(event) => setCountry(event.target.value)}
                    >
                        <option value=''>{t('All Countries')}</option>
                        {COUNTRIES.map(([code, name]) => (
                            <option key={code} value={code}>
                                {name}
                            </option>
                        ))}
                    </select>
                    {user && (
                        <HeroButton
                            size='sm'
                            variant='tertiary'
                            onPress={() => setShowForm((open) => !open)}
                        >
                            {showForm ? t('Cancel') : t('Add a store')}
                        </HeroButton>
                    )}
                </div>

                {showForm && user && (
                    <div className='mb-4 space-y-2 rounded-md border border-border/60 bg-surface-secondary/40 p-3'>
                        <Input
                            placeholder={t('Store name')}
                            value={form.name}
                            onChange={setField('name')}
                        />
                        <div className='grid gap-2 sm:grid-cols-3'>
                            <select
                                className={selectClass}
                                value={form.country}
                                onChange={setField('country')}
                            >
                                <option value=''>{t('Country')}</option>
                                {COUNTRIES.map(([code, name]) => (
                                    <option key={code} value={code}>
                                        {name}
                                    </option>
                                ))}
                            </select>
                            <Input
                                placeholder={t('State / Province')}
                                value={form.state}
                                onChange={setField('state')}
                            />
                            <Input
                                placeholder={t('City')}
                                value={form.city}
                                onChange={setField('city')}
                            />
                        </div>
                        <Input
                            placeholder={t('Address (optional)')}
                            value={form.address}
                            onChange={setField('address')}
                        />
                        <Input
                            placeholder={t('Website (optional)')}
                            value={form.website}
                            onChange={setField('website')}
                        />
                        <textarea
                            className={`${selectClass} w-full`}
                            rows={2}
                            maxLength={1000}
                            placeholder={t('Anything players should know (optional)')}
                            value={form.description}
                            onChange={setField('description')}
                        />
                        <div className='flex justify-end'>
                            <HeroButton
                                size='sm'
                                variant='primary'
                                isPending={addState.isLoading}
                                onPress={submit}
                            >
                                {t('Add store')}
                            </HeroButton>
                        </div>
                    </div>
                )}

                <div className='space-y-2'>
                    {stores.map((store) => (
                        <div
                            key={store.id}
                            className='rounded-md border border-border/50 bg-surface-secondary/40 px-3 py-2'
                        >
                            <div className='flex items-start justify-between gap-2'>
                                <div className='min-w-0'>
                                    <div className='font-semibold text-foreground'>
                                        {store.name}
                                    </div>
                                    {locationOf(store) && (
                                        <div className='text-xs text-muted'>
                                            {locationOf(store)}
                                        </div>
                                    )}
                                    {store.address && (
                                        <div className='text-xs text-muted'>{store.address}</div>
                                    )}
                                </div>
                                {user &&
                                    (user.permissions?.isAdmin ||
                                        store.addedByUserId === user.id) && (
                                        <HeroButton
                                            size='sm'
                                            variant='tertiary'
                                            className='!h-6 !px-2 text-xs'
                                            onPress={() => onRemove(store)}
                                        >
                                            {t('Remove')}
                                        </HeroButton>
                                    )}
                            </div>
                            {store.description && (
                                <p className='mt-1 whitespace-pre-wrap text-sm text-muted'>
                                    {store.description}
                                </p>
                            )}
                            {store.website && (
                                <a
                                    href={
                                        /^https?:\/\//i.test(store.website)
                                            ? store.website
                                            : `https://${store.website}`
                                    }
                                    target='_blank'
                                    rel='noopener noreferrer'
                                    className='mt-1 inline-block text-xs text-amber-300 underline'
                                >
                                    {t('Visit website')}
                                </a>
                            )}
                        </div>
                    ))}
                    {stores.length === 0 && (
                        <div className='py-6 text-center text-sm text-muted'>
                            {user
                                ? t('No stores listed yet. Add your local store to get started!')
                                : t('No stores listed yet. Log in to add your local store.')}
                        </div>
                    )}
                </div>
            </Panel>
        </div>
    );
};

PlayIrl.displayName = 'PlayIrl';

export default PlayIrl;
