import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';

import { useSaveDeckMutation } from '../../redux/api';

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
 * Decks of KeyForge has no public "list a user's decks" API (their public
 * API is single-deck lookup only), so instead of a username we take the
 * player's DoK collection **CSV export** (or pasted deck links / ids),
 * pull every Master Vault id out of it, and import each through the
 * ordinary single-deck endpoint (Master Vault fetch + SAS enrichment),
 * a few in parallel with live progress. Decks already owned are skipped
 * server-side, so re-running only adds new ones.
 *
 * @param {{ onDone?: () => void, compact?: boolean }} props
 */
const DokImport = ({ onDone, compact }) => {
    const { t } = useTranslation();
    const fileInput = useRef(null);

    const [pasted, setPasted] = useState('');
    const [phase, setPhase] = useState('idle'); // idle | importing | done
    const [message, setMessage] = useState(null);
    const [progress, setProgress] = useState({ done: 0, total: 0 });
    const [summary, setSummary] = useState(null);

    const [saveDeck] = useSaveDeckMutation();

    const runImport = async (uuids) => {
        setPhase('importing');
        setProgress({ done: 0, total: uuids.length });

        let cursor = 0;
        let done = 0;
        let imported = 0;
        let already = 0;
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
        setSummary({ imported, already, failed, total: uuids.length });
        onDone?.();
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

    const busy = phase === 'importing';
    const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

    return (
        <div className={compact ? 'space-y-2' : 'space-y-3'}>
            {!compact && (
                <p className='text-sm text-muted'>
                    {t(
                        'Import your whole collection: on Decks of KeyForge, open your decks and use "Download Decks Spreadsheet", then upload that CSV here. You can also paste deck links (DoK or Master Vault), one per line.'
                    )}
                </p>
            )}

            <div className='flex flex-wrap gap-2'>
                <HeroButton
                    variant='primary'
                    isPending={busy}
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
