import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';

import { usePrepareDokImportMutation, useSaveDeckMutation } from '../../redux/api';

const IMPORT_CONCURRENCY = 3;

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
 * Both routes end in the same place: a list of Master Vault uuids imported
 * through the ordinary single-deck endpoint, a few at a time, so the proven
 * import path (Master Vault fetch + SAS enrichment) stays the only one.
 * Decks already owned are skipped server-side, so re-running only adds new
 * decks.
 *
 * @param {{ onDone?: () => void, compact?: boolean }} props
 */
const DokImport = ({ onDone, compact }) => {
    const { t } = useTranslation();
    const fileInput = useRef(null);

    const [apiKey, setApiKey] = useState('');
    const [pasted, setPasted] = useState('');
    const [phase, setPhase] = useState('idle'); // idle | preparing | importing | done
    const [message, setMessage] = useState(null);
    const [progress, setProgress] = useState({ done: 0, total: 0 });
    const [summary, setSummary] = useState(null);

    const [saveDeck] = useSaveDeckMutation();
    const [prepareDokImport] = usePrepareDokImportMutation();

    const runImport = async (uuids, { alreadyOwned = 0 } = {}) => {
        setPhase('importing');
        setProgress({ done: 0, total: uuids.length });

        let cursor = 0;
        let done = 0;
        let imported = 0;
        let already = alreadyOwned;
        let failed = 0;

        const worker = async () => {
            while (cursor < uuids.length) {
                const uuid = uuids[cursor++];

                try {
                    const result = await saveDeck({ uuid }).unwrap();
                    if (result.success) {
                        imported++;
                    } else if (/already exists/i.test(result.message || '')) {
                        already++;
                    } else {
                        failed++;
                    }
                } catch (err) {
                    // The API layer rejects 200 + {success:false}, so an
                    // already-owned deck ("Deck already exists.") surfaces here
                    // rather than in the else branch above. Count it as already
                    // imported, not failed, so re-running a collection import
                    // doesn't report owned decks as errors.
                    if (/already exists/i.test(err?.data?.message || '')) {
                        already++;
                    } else {
                        failed++;
                    }
                }

                done++;
                setProgress({ done, total: uuids.length });
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(IMPORT_CONCURRENCY, uuids.length) }, () => worker())
        );

        setPhase('done');
        setSummary({ imported, already, failed, total: uuids.length + alreadyOwned });
        onDone?.();
    };

    const syncFromDok = async () => {
        setMessage(null);
        setSummary(null);
        setPhase('preparing');

        let result;
        try {
            result = await prepareDokImport(apiKey.trim()).unwrap();
        } catch (err) {
            setPhase('idle');
            setMessage(
                err?.data?.message ||
                    t('Could not reach Decks of KeyForge. Please try again in a moment.')
            );

            return;
        }

        if (!result.success) {
            setPhase('idle');
            setMessage(result.message || t('Could not read that collection.'));

            return;
        }

        // Both of these mean "there is more where this came from", and both are
        // genuinely fixed by syncing again: the server skips what we already
        // own as it pages, so the next run starts where this one stopped.
        if (result.truncated) {
            setMessage(
                t(
                    'Importing {{count}} decks now — more are waiting. Sync again when this finishes.',
                    {
                        count: result.toImport.length
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

        if (result.toImport.length === 0) {
            setPhase('done');
            setSummary({
                imported: 0,
                already: result.ownedCount,
                failed: 0,
                total: result.total
            });

            return;
        }

        // The server already told us which decks we own; counting them here
        // keeps the summary honest without re-importing them to find out.
        runImport(
            result.toImport.map((deck) => deck.uuid),
            { alreadyOwned: result.ownedCount }
        );
    };

    const importFrom = (text) => {
        setMessage(null);
        setSummary(null);

        const uuids = extractUuids(text || '');
        if (uuids.length === 0) {
            setMessage(
                t(
                    'No decks found. Upload your Decks of KeyForge CSV export, or paste deck links (one per line).'
                )
            );

            return;
        }

        runImport(uuids);
    };

    const onFile = async (event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (!file) {
            return;
        }

        try {
            importFrom(await file.text());
        } catch {
            setMessage(t('Could not read that file.'));
        }
    };

    const busy = phase === 'preparing' || phase === 'importing';
    const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

    return (
        <div className={compact ? 'space-y-2' : 'space-y-3'}>
            {!compact && (
                <p className='text-sm text-muted'>
                    {t(
                        'Sync your whole collection with your Decks of KeyForge API key. Find it on Decks of KeyForge under your profile. We use it for this one request and never store it.'
                    )}
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
                    isPending={phase === 'preparing'}
                    isDisabled={busy || !apiKey.trim()}
                    onPress={syncFromDok}
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
                    onPress={() => importFrom(pasted)}
                >
                    {t('Import pasted')}
                </HeroButton>
            </div>

            {phase === 'preparing' && (
                <p className='text-xs text-muted'>{t('Reading your collection from DoK…')}</p>
            )}

            {phase === 'importing' && (
                <div className='space-y-1'>
                    <div className='h-2 w-full overflow-hidden rounded-full bg-surface-secondary'>
                        <div
                            className='h-full rounded-full bg-amber-400 transition-all'
                            style={{ width: `${percent}%` }}
                        />
                    </div>
                    <p className='text-xs text-muted'>
                        {t('Importing {{done}} of {{total}} decks…', {
                            done: progress.done,
                            total: progress.total
                        })}
                    </p>
                </div>
            )}

            {phase === 'done' && summary && (
                <div className='rounded-md border border-border/60 bg-surface-secondary/50 px-3 py-2 text-sm'>
                    {summary.imported > 0 ? (
                        <p className='font-semibold text-green-400'>
                            {t('Imported {{count}} new deck(s).', { count: summary.imported })}
                        </p>
                    ) : (
                        <p className='font-semibold text-foreground'>
                            {t('No new decks to import.')}
                        </p>
                    )}
                    <p className='text-xs text-muted'>
                        {t('{{total}} found, {{already}} already imported.', {
                            total: summary.total,
                            already: summary.already
                        })}
                        {summary.failed > 0 &&
                            ' ' +
                                t('{{failed}} could not be imported.', { failed: summary.failed })}
                    </p>
                </div>
            )}

            {message && <p className='text-sm text-red-400'>{message}</p>}
        </div>
    );
};

DokImport.displayName = 'DokImport';

export default DokImport;
