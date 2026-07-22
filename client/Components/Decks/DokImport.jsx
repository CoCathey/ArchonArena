import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Input } from '@heroui/react';

import { usePrepareDokImportMutation, useSaveDeckMutation } from '../../redux/api';

const IMPORT_CONCURRENCY = 3;

/**
 * ARCHON: bulk import a player's whole Decks of KeyForge collection.
 *
 * The server "prepare" step lists the DoK account's decks and drops the
 * ones already imported; we then import each remaining deck through the
 * ordinary single-deck endpoint (Master Vault fetch + SAS enrichment),
 * running a few in parallel and reporting live progress. Re-running only
 * imports decks added since last time, so it doubles as a "sync" button.
 *
 * @param {{ onDone?: () => void, compact?: boolean }} props
 */
const DokImport = ({ onDone, compact }) => {
    const { t } = useTranslation();
    const linkedUsername = useSelector((state) => state.account.user?.dokUsername);

    const [username, setUsername] = useState(linkedUsername || '');
    const [phase, setPhase] = useState('idle'); // idle | preparing | importing | done
    const [message, setMessage] = useState(null);
    const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0 });
    const [summary, setSummary] = useState(null);

    const [prepareDokImport, prepareState] = usePrepareDokImportMutation();
    const [saveDeck] = useSaveDeckMutation();

    const runImport = async (decks) => {
        setPhase('importing');
        setProgress({ done: 0, total: decks.length, failed: 0 });

        let cursor = 0;
        let done = 0;
        let failed = 0;

        const worker = async () => {
            while (cursor < decks.length) {
                const deck = decks[cursor++];

                try {
                    const result = await saveDeck({ uuid: deck.uuid }).unwrap();
                    if (!result.success) {
                        failed++;
                    }
                } catch {
                    failed++;
                }

                done++;
                setProgress({ done, total: decks.length, failed });
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(IMPORT_CONCURRENCY, decks.length) }, () => worker())
        );

        return { imported: done - failed, failed };
    };

    const start = async () => {
        const trimmed = username.trim();

        if (!trimmed) {
            setMessage(t('Enter your Decks of KeyForge username.'));

            return;
        }

        setMessage(null);
        setSummary(null);
        setPhase('preparing');

        let prepared;
        try {
            prepared = await prepareDokImport(trimmed).unwrap();
        } catch (err) {
            setPhase('idle');
            // Surface what actually failed instead of a generic shrug - the
            // status/message pinpoints whether it's auth, a server error, or
            // a network drop (err.status is RTK's FETCH_ERROR/HTTP status).
            const detail =
                err?.data?.message || err?.error || (err?.status && `HTTP ${err.status}`);
            setMessage(
                detail
                    ? t('Import failed: {{detail}}', { detail })
                    : t('Could not reach the server. Please try again.')
            );

            return;
        }

        if (!prepared.success) {
            setPhase('idle');
            setMessage(prepared.message || t('Could not import from Decks of KeyForge.'));

            return;
        }

        if (prepared.toImport.length === 0) {
            setPhase('done');
            setSummary({
                imported: 0,
                failed: 0,
                already: prepared.ownedCount,
                total: prepared.total
            });
            onDone?.();

            return;
        }

        const { imported, failed } = await runImport(prepared.toImport);

        setPhase('done');
        setSummary({
            imported,
            failed,
            already: prepared.ownedCount,
            total: prepared.total,
            truncated: prepared.truncated
        });
        onDone?.();
    };

    const busy = phase === 'preparing' || phase === 'importing';
    const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

    return (
        <div className={compact ? 'space-y-2' : 'space-y-3'}>
            {!compact && (
                <p className='text-sm text-muted'>
                    {t(
                        'Import your entire collection from Decks of KeyForge. Enter your DoK username and we will pull in every deck you own.'
                    )}
                </p>
            )}
            <div className='flex gap-2'>
                <Input
                    className='flex-1'
                    placeholder={t('Decks of KeyForge username')}
                    value={username}
                    isDisabled={busy}
                    onChange={(event) => setUsername(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' && !busy) {
                            start();
                        }
                    }}
                />
                <HeroButton variant='primary' isPending={busy} onPress={start}>
                    {linkedUsername ? t('Sync') : t('Import')}
                </HeroButton>
            </div>

            {phase === 'preparing' && (
                <p className='text-sm text-muted'>
                    {t('Finding your decks on Decks of KeyForge…')}
                </p>
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
                            {t('Imported {{count}} new deck(s) from Decks of KeyForge.', {
                                count: summary.imported
                            })}
                        </p>
                    ) : (
                        <p className='font-semibold text-foreground'>
                            {t('Your collection is already up to date.')}
                        </p>
                    )}
                    <p className='text-xs text-muted'>
                        {t('{{total}} decks found, {{already}} already imported.', {
                            total: summary.total,
                            already: summary.already
                        })}
                        {summary.failed > 0 &&
                            ' ' +
                                t('{{failed}} could not be imported.', {
                                    failed: summary.failed
                                })}
                    </p>
                    {summary.truncated && (
                        <p className='mt-1 text-xs text-muted'>
                            {t(
                                'Only the most recent decks were imported. Run it again to fetch more.'
                            )}
                        </p>
                    )}
                </div>
            )}

            {message && <p className='text-sm text-red-400'>{message}</p>}

            {prepareState.isError && !message && (
                <p className='text-sm text-red-400'>
                    {t('Something went wrong. Please try again.')}
                </p>
            )}
        </div>
    );
};

DokImport.displayName = 'DokImport';

export default DokImport;
