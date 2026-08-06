import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';
import { useDispatch } from 'react-redux';

import {
    api,
    useCancelDeckImportMutation,
    useGetDeckImportStatusQuery,
    usePrepareDokImportMutation,
    useQueueDeckImportMutation
} from '../../redux/api';
import { TAG_TYPES } from '../../redux/apiTags';

const POLL_MS = 2500;

// Master Vault deck ids are UUIDs. This finds them in anything the player
// pastes or uploads: a Decks of KeyForge CSV export (its first column is
// keyforge_id), DoK deck links, Master Vault deck links, or raw ids.
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

const extractUuids = (text) => {
    const matches = text.match(UUID_RE) || [];
    const seen = new Set();
    const uuids = [];
    for (const raw of matches) {
        const uuid = raw.toLowerCase();
        if (!seen.has(uuid)) {
            seen.add(uuid);
            uuids.push(uuid);
        }
    }

    return uuids;
};

const isLive = (job) => !!job && (job.status === 'pending' || job.status === 'running');

/**
 * ARCHON: bulk-import a whole KeyForge collection.
 *
 * Two routes in, because they suit different players:
 *
 *  - A Decks of KeyForge API key. DoK publishes
 *    `GET /public-api/v1/my-decks` for exactly this, keyed to the user's own
 *    account, so one paste syncs the whole collection and re-syncing later is
 *    a button rather than another export. The key is sent to our server for
 *    that one request and never stored, here or there.
 *  - A DoK CSV export or pasted deck links, for anyone who would rather not
 *    hand over a key at all.
 *
 * Both routes hand a list of Master Vault ids to a server-side job and then
 * only watch it. The import used to run here, in the browser, which meant
 * closing this dialog abandoned it part-done - and since Master Vault paces
 * imports to minutes for a real collection, closing the dialog was the normal
 * case rather than the exception. Now the work survives navigation, a reload,
 * and a lobby restart, and this component is just a progress view.
 *
 * @param {{ onDone?: () => void, compact?: boolean }} props
 */
const DokImport = ({ onDone, compact }) => {
    const { t } = useTranslation();
    const dispatch = useDispatch();
    const fileInput = useRef(null);

    const [apiKey, setApiKey] = useState('');
    const [pasted, setPasted] = useState('');
    const [queueing, setQueueing] = useState(false);
    const [message, setMessage] = useState(null);

    const [prepareDokImport] = usePrepareDokImportMutation();
    const [queueDeckImport] = useQueueDeckImportMutation();
    const [cancelDeckImport] = useCancelDeckImportMutation();

    // Poll only while there is something to watch. An idle dialog should not
    // sit there querying every couple of seconds for a job nobody started.
    const [pollingInterval, setPollingInterval] = useState(0);
    const { data: status, refetch } = useGetDeckImportStatusQuery(undefined, { pollingInterval });

    const job = status?.job || null;
    const live = isLive(job);

    useEffect(() => {
        setPollingInterval(live ? POLL_MS : 0);
    }, [live]);

    // Each imported deck is a new row in the player's collection, and the deck
    // list behind this dialog is showing a stale copy until it hears about it.
    const importedCount = job?.imported ?? 0;
    useEffect(() => {
        if (importedCount > 0) {
            dispatch(api.util.invalidateTags([{ type: TAG_TYPES.DECKS, id: 'LIST' }]));
            onDone?.();
        }
    }, [importedCount, dispatch, onDone]);

    const startSync = async () => {
        setMessage(null);
        setQueueing(true);

        try {
            const result = await prepareDokImport(apiKey.trim()).unwrap();

            if (!result.success) {
                setMessage(result.message || t('Could not read that collection.'));
            } else if (result.queued === 0) {
                setMessage(
                    t('Nothing new to import — every deck on that account is already here.')
                );
            } else if (result.truncated) {
                setMessage(
                    t(
                        'Importing {{count}} decks. More are waiting — sync again once this finishes.',
                        {
                            count: result.queued
                        }
                    )
                );
            } else if (result.partial) {
                setMessage(
                    t(
                        'Decks of KeyForge stopped responding partway through, so this is only part of your collection. Sync again to pick up the rest.'
                    )
                );
            }
        } catch (err) {
            setMessage(
                err?.data?.message ||
                    t('Could not reach Decks of KeyForge. Please try again in a moment.')
            );
        } finally {
            setQueueing(false);
            refetch();
        }
    };

    const startQueue = async (text) => {
        setMessage(null);

        const uuids = extractUuids(text || '');
        if (uuids.length === 0) {
            setMessage(
                t(
                    'No decks found. Upload your Decks of KeyForge CSV export, or paste deck links (one per line).'
                )
            );

            return;
        }

        setQueueing(true);

        try {
            const result = await queueDeckImport(uuids).unwrap();

            if (!result.success) {
                setMessage(result.message || t('Could not queue those decks.'));
            } else if (result.queued === 0) {
                setMessage(t('Nothing new to import — you already have all of those decks.'));
            }
        } catch (err) {
            setMessage(err?.data?.message || t('Could not queue those decks.'));
        } finally {
            setQueueing(false);
            refetch();
        }
    };

    const stopImport = async () => {
        try {
            await cancelDeckImport().unwrap();
        } catch {
            // Nothing to tell the player: the next poll shows the real state.
        } finally {
            refetch();
        }
    };

    const onFile = async (event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (!file) {
            return;
        }

        try {
            startQueue(await file.text());
        } catch {
            setMessage(t('Could not read that file.'));
        }
    };

    const busy = queueing || live;
    const percent = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;

    return (
        <div className={compact ? 'space-y-2' : 'space-y-3'}>
            {/* ARCHON: the how-to-get-a-key steps are read once and then never
                again, but this dialog is opened every time somebody adds a
                deck. Left expanded they were the tallest thing in a modal that
                already had to scroll, so they sit behind a disclosure - present
                for the first-timer, out of the way for everyone else. A plain
                <details> rather than a component: nothing in this client has a
                collapsible yet, and this does not justify introducing one. */}
            {!compact && (
                <div className='space-y-2 text-sm leading-relaxed text-muted'>
                    <p>
                        {t(
                            'Sync your whole collection with your Decks of KeyForge API key. We use it for this one request and never store it.'
                        )}
                    </p>
                    <details className='rounded-md border border-border/60 bg-surface-secondary/40 px-3 py-2'>
                        <summary className='cursor-pointer text-sm font-semibold text-foreground'>
                            {t('How do I get a key?')}
                        </summary>
                        {/* The page that issues the key, as its own control
                            rather than a phrase inside step 1. Underlined
                            because the link colour alone did not read as a link
                            against this surface, and this is the one thing in
                            the panel a first-timer has to click. */}
                        <a
                            className='mt-2 inline-flex items-center gap-1 font-semibold text-primary underline underline-offset-2 hover:text-primary/80'
                            href='https://decksofkeyforge.com/about/sellers-and-devs'
                            target='_blank'
                            rel='noopener noreferrer'
                        >
                            {t('Open the Decks of KeyForge API key page')}
                            <span aria-hidden='true'>↗</span>
                        </a>
                        <ol className='mt-2 list-decimal space-y-1 pl-5'>
                            <li>
                                {t(
                                    'Log in to Decks of KeyForge first — the key button does not appear until you are.'
                                )}
                            </li>
                            <li>{t('On that page, press "Generate API Key".')}</li>
                            <li>
                                {t(
                                    'Copy it straight away — Decks of KeyForge shows a key only in the moment it is created, and has no way to show it to you again later.'
                                )}
                            </li>
                            <li>{t('Paste it below and press Sync collection.')}</li>
                        </ol>
                        {/* ARCHON: DoK has one key per account, no way to read
                            an existing one back (the page clears it on mount and
                            the only endpoint is a POST that mints a new one),
                            and minting voids the previous key instantly. So the
                            advice cannot be "avoid generating" - generating is
                            the only way to hold a key at all. It has to be
                            "generate once, then reuse that string everywhere",
                            which matters most to whoever runs the server, since
                            DOK_API_KEY buys SAS for every player. */}
                        <p className='mt-2'>
                            {t(
                                "Decks of KeyForge issues one key per account, and generating replaces the previous one immediately. If you use a DoK key anywhere else — including as this server's own DOK_API_KEY — reuse this same key there rather than generating another, or the older one will stop working. Your key lists the decks you have marked as owned on Decks of KeyForge, including private ones, so only give it to sites you trust."
                            )}
                        </p>
                    </details>
                </div>
            )}

            {compact && (
                <p className='text-xs text-muted'>
                    {t('Generate a key on')}{' '}
                    <a
                        className='font-semibold text-primary underline underline-offset-2 hover:text-primary/80'
                        href='https://decksofkeyforge.com/about/sellers-and-devs'
                        target='_blank'
                        rel='noopener noreferrer'
                    >
                        {t('Decks of KeyForge → Sellers and Devs ↗')}
                    </a>
                    {t(' while logged in, and copy it straight away — it is shown only once.')}
                </p>
            )}

            <div className='flex flex-wrap items-center gap-2'>
                <input
                    type='password'
                    autoComplete='off'
                    className='min-w-0 flex-1 rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none'
                    placeholder={t('Decks of KeyForge API key')}
                    value={apiKey}
                    disabled={busy}
                    onChange={(event) => setApiKey(event.target.value)}
                />
                <HeroButton
                    variant='primary'
                    isPending={queueing}
                    isDisabled={busy || !apiKey.trim()}
                    onPress={startSync}
                >
                    {t('Sync collection')}
                </HeroButton>
            </div>

            <div className='my-1 flex items-center gap-3'>
                <span className='h-px flex-1 bg-border/60' />
                <span className='text-xs uppercase tracking-wide text-muted'>
                    {t('or without a key')}
                </span>
                <span className='h-px flex-1 bg-border/60' />
            </div>

            <div className='flex flex-wrap gap-2'>
                <HeroButton
                    variant='tertiary'
                    isDisabled={busy}
                    onPress={() => fileInput.current?.click()}
                >
                    {t('Upload DoK CSV')}
                </HeroButton>
                <input
                    ref={fileInput}
                    type='file'
                    accept='.csv,text/csv,text/plain'
                    hidden
                    onChange={onFile}
                />
            </div>

            <textarea
                className='min-h-20 w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none'
                placeholder={t('…or paste deck links / ids here, one per line')}
                value={pasted}
                disabled={busy}
                onChange={(event) => setPasted(event.target.value)}
            />
            <div className='flex justify-end'>
                <HeroButton
                    size='sm'
                    variant='tertiary'
                    isDisabled={busy || !pasted.trim()}
                    onPress={() => startQueue(pasted)}
                >
                    {t('Import pasted')}
                </HeroButton>
            </div>

            {queueing && (
                <p className='text-xs text-muted'>{t('Reading your collection from DoK…')}</p>
            )}

            {live && (
                <div className='space-y-1 rounded-md border border-border/60 bg-surface-secondary/50 px-3 py-2'>
                    <div className='h-2 w-full overflow-hidden rounded-full bg-surface-secondary'>
                        <div
                            className='h-full rounded-full bg-amber-400 transition-all'
                            style={{ width: `${percent}%` }}
                        />
                    </div>
                    <p className='text-xs text-muted'>
                        {t('Importing {{done}} of {{total}} decks…', {
                            done: job.done,
                            total: job.total
                        })}
                    </p>
                    {/* The whole point of moving this to the server. */}
                    <p className='text-xs text-muted'>
                        {job.pausedUntil
                            ? t(
                                  'Master Vault is throttling us, so the import is waiting before it tries again. You can close this — it carries on without you.'
                              )
                            : t('You can close this window; the import carries on without you.')}
                    </p>
                    <div className='flex justify-end'>
                        <HeroButton size='sm' variant='tertiary' onPress={stopImport}>
                            {t('Stop importing')}
                        </HeroButton>
                    </div>
                </div>
            )}

            {job && !live && job.done > 0 && (
                <div className='rounded-md border border-border/60 bg-surface-secondary/50 px-3 py-2 text-sm'>
                    {job.imported > 0 ? (
                        <p className='font-semibold text-green-400'>
                            {t('Imported {{count}} new deck(s).', { count: job.imported })}
                        </p>
                    ) : (
                        <p className='font-semibold text-foreground'>
                            {t('No new decks to import.')}
                        </p>
                    )}
                    <p className='text-xs text-muted'>
                        {t('{{total}} queued, {{already}} already imported.', {
                            total: job.total,
                            already: job.alreadyOwned
                        })}
                        {job.failed > 0 &&
                            ' ' + t('{{failed}} could not be imported.', { failed: job.failed })}
                        {job.status === 'cancelled' && ' ' + t('Stopped before it finished.')}
                    </p>

                    {/* A bare failure count tells a player nothing they can act
                        on. The reason is what says whether to wait and re-run
                        or to stop trying. */}
                    {job.reasons?.length > 0 && (
                        <ul className='mt-1 space-y-0.5 text-xs text-muted'>
                            {job.reasons.map(([why, count]) => (
                                <li key={why}>
                                    {count} × {why}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {message && <p className='text-sm text-red-400'>{message}</p>}
        </div>
    );
};

DokImport.displayName = 'DokImport';

export default DokImport;
