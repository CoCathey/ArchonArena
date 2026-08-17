import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

import Panel from '../Site/Panel';
import {
    useAddVaultTourDeckMutation,
    useGetVaultTourFieldQuery,
    useRemoveVaultTourDeckMutation
} from '../../redux/api';

/**
 * ARCHON (N32): the Vault Tour field, as the operator maintains it.
 *
 * "Which decks won which events" is a fact about the world that one person keeps
 * for everybody, which is why this is an admin screen and not a member setting.
 * Paste a Master Vault or Decks of KeyForge link, say which event it came from
 * and how it finished, and the lab fetches the cards on its next sweep.
 *
 * Two things are shown that a tidier panel would hide. A deck this server cannot
 * simulate is listed with the reason rather than dropped, because otherwise an
 * operator's entry silently never appears in anybody's matrix. And a deck whose
 * cards have not been fetched yet says so, because the gap between "added" and
 * "playing" is a few sweeps long and looks like a bug if nothing names it.
 */
const VaultTourField = () => {
    const { t } = useTranslation();
    const { data, isError, refetch } = useGetVaultTourFieldQuery();
    const [addDeck, { isLoading: adding }] = useAddVaultTourDeckMutation();
    const [removeDeck] = useRemoveVaultTourDeckMutation();
    const [link, setLink] = useState('');
    const [event, setEvent] = useState('');
    const [placing, setPlacing] = useState('winner');
    const [eventDate, setEventDate] = useState('');
    const [message, setMessage] = useState(null);

    if (isError) {
        return null;
    }

    const field = data?.field || [];
    const placings = data?.placings || [
        { key: 'winner', label: 'Winner' },
        { key: 'runner-up', label: 'Runner-up' }
    ];

    const submit = async () => {
        setMessage(null);

        try {
            const result = await addDeck({ link, event, placing, eventDate: eventDate || null })
                .unwrap()
                .catch((error) => {
                    throw error;
                });

            setLink('');
            setMessage(result.message || t('Added. The lab fetches its cards on the next sweep.'));
            refetch();
        } catch (error) {
            setMessage(error?.data?.message || t('That deck could not be added.'));
        }
    };

    return (
        <Panel title={t('Vault Tour field')}>
            <p className='m-0 pb-2 text-sm text-muted'>
                {t(
                    'The tournament decks members run their Vault Tour slate against. Paste a ' +
                        'Master Vault or Decks of KeyForge deck link — the id in the URL is the ' +
                        'same one either way.'
                )}
            </p>

            <div className='flex flex-wrap items-end gap-2 pb-3'>
                <label className='flex-1'>
                    <span className='mb-0.5 block text-[10px] uppercase tracking-wide text-muted'>
                        {t('Deck link')}
                    </span>
                    <input
                        className='w-full rounded border border-border/70 bg-surface-secondary/60 px-2 py-1 text-sm text-foreground'
                        onChange={(e) => setLink(e.target.value)}
                        placeholder='https://decksofkeyforge.com/decks/…'
                        value={link}
                    />
                </label>
                <label>
                    <span className='mb-0.5 block text-[10px] uppercase tracking-wide text-muted'>
                        {t('Event')}
                    </span>
                    <input
                        className='w-44 rounded border border-border/70 bg-surface-secondary/60 px-2 py-1 text-sm text-foreground'
                        onChange={(e) => setEvent(e.target.value)}
                        placeholder={t('Vault Tour Atlanta')}
                        value={event}
                    />
                </label>
                <label>
                    <span className='mb-0.5 block text-[10px] uppercase tracking-wide text-muted'>
                        {t('Finish')}
                    </span>
                    <select
                        className='rounded border border-border/70 bg-surface-secondary/60 px-2 py-1 text-sm text-foreground'
                        onChange={(e) => setPlacing(e.target.value)}
                        value={placing}
                    >
                        {placings.map((entry) => (
                            <option key={entry.key} value={entry.key}>
                                {entry.label}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    <span className='mb-0.5 block text-[10px] uppercase tracking-wide text-muted'>
                        {t('Date')}
                    </span>
                    <input
                        className='rounded border border-border/70 bg-surface-secondary/60 px-2 py-1 text-sm text-foreground'
                        onChange={(e) => setEventDate(e.target.value)}
                        type='date'
                        value={eventDate}
                    />
                </label>
                <button
                    className='rounded-md border border-accent/60 bg-accent/20 px-3 py-1 text-xs text-amber-200 disabled:opacity-40'
                    disabled={adding || !link || !event}
                    onClick={submit}
                    type='button'
                >
                    {adding ? t('Adding…') : t('Add to the field')}
                </button>
            </div>

            {message && <p className='m-0 pb-2 text-[11px] text-amber-300'>{message}</p>}

            {field.length === 0 ? (
                <p className='m-0 text-sm text-muted'>{t('No decks in the field yet.')}</p>
            ) : (
                <ul className='m-0 list-none space-y-0.5 p-0 text-sm'>
                    {field.map((deck) => (
                        <li
                            className='flex flex-wrap items-baseline gap-2 border-b border-border/40 py-1 last:border-0'
                            key={deck.uuid}
                        >
                            <span className='text-foreground'>{deck.name}</span>
                            <span className='text-[11px] text-muted'>
                                {deck.event} · {deck.placing}
                                {deck.eventDate ? ` · ${String(deck.eventDate).slice(0, 10)}` : ''}
                            </span>
                            {!deck.playable && (
                                <span
                                    className='text-[11px] text-red-300'
                                    title={deck.missing || undefined}
                                >
                                    {deck.missing
                                        ? t('cannot be simulated here')
                                        : t('cards not fetched yet')}
                                </span>
                            )}
                            <span className='text-[11px] text-muted'>
                                {t('{{games}} games', { games: deck.games || 0 })}
                            </span>
                            <button
                                className='ms-auto rounded border border-border/70 px-1.5 py-0.5 text-[11px] text-muted hover:text-foreground'
                                onClick={async () => {
                                    await removeDeck(deck.uuid);
                                    refetch();
                                }}
                                type='button'
                            >
                                {t('Remove')}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </Panel>
    );
};

VaultTourField.displayName = 'VaultTourField';

export default VaultTourField;
