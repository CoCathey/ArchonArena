import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';

import { usePrepareDokImportMutation, useSaveDeckMutation } from '../../redux/api';

// ARCHON: pacing for a whole-collection import.
//
// Master Vault meters deck fetches, and it meters them hard. This importer
// originally fired decks at concurrency 3 with no spacing, no retry and no
// way to stop: a 257-deck sync imported exactly 3 - one per worker - and then
// failed the remaining 254 in a few seconds, because nothing noticed the
// refusals or slowed down for them. Worse, burning the rest of the list at
// full tilt is precisely what deepens a rate limit.
//
// So requests are paced on ONE shared clock rather than per worker (otherwise
// concurrency silently multiplies the rate), a refusal widens the spacing for
// everybody and the deck is retried rather than lost, and a success narrows it
// again slowly so one hiccup does not leave 200 decks crawling. If Master
// Vault keeps refusing after all that, the run stops and says so - decks
// already imported are skipped server-side next time, so stopping early costs
// nothing but the wait.
const IMPORT_CONCURRENCY = 2;
const BASE_SPACING_MS = 300;
const MAX_SPACING_MS = 10000;
const MAX_DECK_ATTEMPTS = 4;
const ABORT_AFTER_EXHAUSTED = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRateLimited = (payload) =>
    payload?.code === 'upstream_rate_limited' || /rate limit/i.test(payload?.message || '');

const isAlreadyOwned = (payload) => /already exists/i.test(payload?.message || '');

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
        let spacingMs = BASE_SPACING_MS;
        let nextSlotAt = 0;
        let exhausted = 0;
        let stopped = false;
        const reasons = new Map();

        const noteReason = (why) => reasons.set(why, (reasons.get(why) || 0) + 1);

        // One clock for every worker. Pacing each worker separately would mean
        // the real request rate was spacing x concurrency, which is how the
        // "gentle" original managed to be a burst.
        const takeSlot = async () => {
            const now = Date.now();
            const at = Math.max(now, nextSlotAt);
            nextSlotAt = at + spacingMs;

            if (at > now) {
                await sleep(at - now);
            }
        };

        // The API layer rejects 200 + {success:false}, so ordinary refusals
        // arrive as exceptions. Normalise both into one payload rather than
        // duplicating the classification down two branches.
        const importOne = async (uuid) => {
            try {
                const result = await saveDeck({ uuid }).unwrap();

                return result.success ? { ok: true } : { ok: false, payload: result };
            } catch (err) {
                return { ok: false, payload: err?.data || {} };
            }
        };

        const worker = async () => {
            while (!stopped && cursor < uuids.length) {
                const uuid = uuids[cursor++];

                for (let attempt = 1; ; attempt++) {
                    await takeSlot();

                    if (stopped) {
                        return;
                    }

                    const { ok, payload } = await importOne(uuid);

                    if (ok) {
                        imported++;
                        // Recover slowly. Snapping straight back to the base
                        // spacing after one success just re-earns the limit.
                        spacingMs = Math.max(BASE_SPACING_MS, Math.round(spacingMs * 0.9));
                        break;
                    }

                    if (isAlreadyOwned(payload)) {
                        already++;
                        break;
                    }

                    if (isRateLimited(payload)) {
                        if (attempt < MAX_DECK_ATTEMPTS) {
                            spacingMs = Math.min(MAX_SPACING_MS, Math.max(spacingMs * 2, 1000));
                            await sleep(spacingMs * attempt);
                            continue;
                        }

                        // This deck used up its retries. A few of those in a
                        // run means Master Vault is not going to relent inside
                        // this sitting, and continuing only deepens the limit.
                        failed++;
                        noteReason(t('Master Vault is rate limiting deck imports'));

                        if (++exhausted >= ABORT_AFTER_EXHAUSTED) {
                            stopped = true;
                        }

                        break;
                    }

                    failed++;
                    noteReason(payload?.message || t('Master Vault would not return the deck'));
                    break;
                }

                done++;
                setProgress({ done, total: uuids.length });
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(IMPORT_CONCURRENCY, uuids.length) }, () => worker())
        );

        setPhase('done');
        setSummary({
            imported,
            already,
            failed,
            total: uuids.length + alreadyOwned,
            stopped,
            // Most common first: with 250 failures the player wants the one
            // sentence that explains them, not a list of 250.
            reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        });
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
                        <ol className='mt-2 list-decimal space-y-1 pl-5'>
                            <li>
                                {t('Log in to Decks of KeyForge, then open')}{' '}
                                <a
                                    className='text-primary hover:text-primary/80'
                                    href='https://decksofkeyforge.com/about/sellers-and-devs'
                                    target='_blank'
                                    rel='noopener noreferrer'
                                >
                                    {t('Sellers and Devs')}
                                </a>
                                {t('. You must be logged in, or no key button appears.')}
                            </li>
                            <li>{t('Press "Generate API Key".')}</li>
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
                        className='text-primary hover:text-primary/80'
                        href='https://decksofkeyforge.com/about/sellers-and-devs'
                        target='_blank'
                        rel='noopener noreferrer'
                    >
                        {t('Decks of KeyForge → Sellers and Devs')}
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

                    {/* A bare failure count tells a player nothing they can act
                        on. The reason is what says whether to wait and re-run
                        or to stop trying. */}
                    {summary.reasons?.length > 0 && (
                        <ul className='mt-1 space-y-0.5 text-xs text-muted'>
                            {summary.reasons.map(([why, count]) => (
                                <li key={why}>
                                    {count} × {why}
                                </li>
                            ))}
                        </ul>
                    )}

                    {summary.stopped && (
                        <p className='mt-2 text-xs text-amber-400'>
                            {t(
                                'Stopped early because Master Vault kept refusing. Your imported decks are saved — wait a few minutes and sync again to carry on from here.'
                            )}
                        </p>
                    )}
                </div>
            )}

            {message && <p className='text-sm text-red-400'>{message}</p>}
        </div>
    );
};

DokImport.displayName = 'DokImport';

export default DokImport;
