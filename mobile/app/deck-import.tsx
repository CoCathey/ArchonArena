import React, { useCallback, useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import {
    ActivityIndicator,
    Pressable,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    View
} from 'react-native';
import {
    cancelDeckImport,
    extractDeckUuids,
    fetchDokLink,
    fetchImportStatus,
    forgetDokLink,
    importDeck,
    parseDeckUuid,
    prepareDokImport,
    queueDeckImport,
    searchDeckCatalog,
    syncDokNow,
    type CatalogDeck,
    type DokLinkStatus,
    type ImportJob
} from '../src/api/client';
import { expansionLabel } from '../src/decks/expansions';
import { colors, radius, spacing } from '../src/theme';
import HouseIcon from '../src/ui/HouseIcon';
import { Button, Card, ErrorBanner, TextField } from '../src/ui/primitives';

/**
 * ARCHON: importing more than one deck at a time.
 *
 * The app could import a deck from a pasted Master Vault link and nothing
 * else, so a player with sixty decks pasted sixty links. The website has three
 * ways in and the app had one:
 *
 *  - a Decks of KeyForge key, which lists the whole collection
 *  - a name search against the Master Vault catalog, for players who do not
 *    use DoK at all — they know the deck's name, not its uuid
 *  - a paste box that takes any number of ids, including a DoK CSV export
 *
 * All three feed the same job machinery on the server, so they get the same
 * pacing, resumability and progress. This screen polls that job.
 */

/** How often to ask about a running job. The server paces the work itself. */
const POLL_MS = 2500;

function isLive(job?: ImportJob | null): boolean {
    return !!job && (job.status === 'pending' || job.status === 'running');
}

function JobProgress(props: { job: ImportJob; onCancel: () => void; busy: boolean }) {
    const { job } = props;
    const fraction = job.total > 0 ? Math.min(1, job.done / job.total) : 0;
    const live = isLive(job);

    return (
        <View style={styles.jobBox}>
            <View style={styles.jobHeader}>
                <Text style={styles.jobStatus}>
                    {live
                        ? `Importing ${job.done} of ${job.total}`
                        : job.status === 'complete'
                        ? 'Import finished'
                        : job.status === 'cancelled'
                        ? 'Import cancelled'
                        : 'Import stopped'}
                </Text>
                {live ? (
                    <Pressable onPress={props.onCancel} disabled={props.busy} hitSlop={8}>
                        <Text style={styles.cancelText}>Cancel</Text>
                    </Pressable>
                ) : null}
            </View>

            <View style={styles.track}>
                <View style={[styles.fill, { width: `${Math.round(fraction * 100)}%` }]} />
            </View>

            <Text style={styles.jobMeta}>
                {[
                    `${job.imported} imported`,
                    job.alreadyOwned > 0 ? `${job.alreadyOwned} already owned` : undefined,
                    job.failed > 0 ? `${job.failed} failed` : undefined
                ]
                    .filter(Boolean)
                    .join(' · ')}
            </Text>

            {/* Why they failed, not just how many — a rate limit and a deck
                Master Vault has never heard of need different answers. */}
            {(job.reasons ?? []).length > 0 ? (
                <Text style={styles.jobMeta}>
                    {(job.reasons ?? [])
                        .map(([reason, count]) => `${reason} (${count})`)
                        .join(' · ')}
                </Text>
            ) : null}

            {job.pausedUntil ? (
                <Text style={styles.jobMeta}>
                    Paused until {new Date(job.pausedUntil).toLocaleTimeString()} — Master Vault
                    asked us to slow down.
                </Text>
            ) : null}
            {job.lastError ? <Text style={styles.jobError}>{job.lastError}</Text> : null}
        </View>
    );
}

export default function DeckImportScreen() {
    const [job, setJob] = useState<ImportJob | null | undefined>();
    const [link, setLink] = useState<DokLinkStatus | undefined>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [notice, setNotice] = useState<string | undefined>();

    const [dokKey, setDokKey] = useState('');
    const [remember, setRemember] = useState(true);

    const [pasted, setPasted] = useState('');

    const [query, setQuery] = useState('');
    const [results, setResults] = useState<CatalogDeck[]>([]);
    const [searching, setSearching] = useState(false);
    const [catalogEmpty, setCatalogEmpty] = useState(false);
    const [importingUuid, setImportingUuid] = useState<string | undefined>();

    const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

    const refreshStatus = useCallback(async () => {
        try {
            const result = await fetchImportStatus();
            setJob(result.job ?? null);
        } catch {
            // A status poll that fails is not worth an error banner; the next
            // one is 2.5 seconds away.
        }
    }, []);

    useEffect(() => {
        refreshStatus();
        fetchDokLink()
            .then((result) => setLink(result.link))
            .catch(() => {
                // Import still works with a pasted key.
            });
    }, [refreshStatus]);

    // Poll only while something is running. A finished job is a fact, not a
    // thing to keep asking about on a metered connection.
    useEffect(() => {
        if (!isLive(job)) {
            if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = undefined;
            }

            return undefined;
        }

        pollRef.current = setInterval(refreshStatus, POLL_MS);

        return () => {
            if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = undefined;
            }
        };
    }, [job, refreshStatus]);

    // Debounced catalog search.
    useEffect(() => {
        const term = query.trim();
        if (term.length < 2) {
            setResults([]);
            setCatalogEmpty(false);

            return undefined;
        }

        const timer = setTimeout(async () => {
            setSearching(true);
            try {
                const result = await searchDeckCatalog(term);
                setResults(result.decks ?? []);
                setCatalogEmpty(!!result.catalogEmpty);
                if (result.success === false && result.message) {
                    setError(result.message);
                }
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Search failed');
            } finally {
                setSearching(false);
            }
        }, 350);

        return () => clearTimeout(timer);
    }, [query]);

    const run = async (
        action: () => Promise<{ success?: boolean; message?: string; job?: ImportJob }>,
        successNotice: string
    ) => {
        setBusy(true);
        setError(undefined);
        setNotice(undefined);
        try {
            const result = await action();
            if (!result.success) {
                setError(result.message ?? 'That did not work');
                return;
            }
            if (result.job) {
                setJob(result.job);
            } else {
                await refreshStatus();
            }
            setNotice(successNotice);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'That did not work');
        } finally {
            setBusy(false);
        }
    };

    const importOne = async (uuid: string) => {
        setImportingUuid(uuid);
        setError(undefined);
        try {
            const result = await importDeck(uuid);
            if (!result.success) {
                setError(result.message ?? 'Import failed');
                return;
            }
            setResults((current) =>
                current.map((deck) => (deck.uuid === uuid ? { ...deck, owned: true } : deck))
            );
            setNotice('Deck imported');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Import failed');
        } finally {
            setImportingUuid(undefined);
        }
    };

    const pastedUuids = extractDeckUuids(pasted);

    return (
        <ScrollView
            style={styles.container}
            contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
            keyboardShouldPersistTaps='handled'
        >
            <ErrorBanner message={error} />
            {notice ? <Text style={styles.notice}>{notice}</Text> : null}

            {job ? (
                <JobProgress
                    job={job}
                    busy={busy}
                    onCancel={() => run(() => cancelDeckImport(), 'Import cancelled')}
                />
            ) : null}

            {/* ---- Whole collection ---- */}
            <Card style={{ marginBottom: spacing.md }}>
                <Text style={styles.sectionTitle}>Import your whole collection</Text>

                {link?.linked ? (
                    <>
                        <Text style={styles.hint}>
                            Linked to Decks of KeyForge
                            {link.lastSyncedAt
                                ? ` · last synced ${new Date(
                                      link.lastSyncedAt
                                  ).toLocaleDateString()}`
                                : ''}
                            .
                        </Text>
                        {link.lastError ? (
                            <Text style={styles.jobError}>{link.lastError}</Text>
                        ) : null}
                        <View style={styles.rowActions}>
                            <Button
                                title='Sync now'
                                loading={busy}
                                onPress={() => run(() => syncDokNow(), 'Sync started')}
                                style={{ flex: 1 }}
                            />
                            <Button
                                variant='secondary'
                                title='Forget key'
                                onPress={() =>
                                    run(async () => {
                                        const result = await forgetDokLink();
                                        setLink(result.link);

                                        return result;
                                    }, 'Key forgotten')
                                }
                                style={{ flex: 1 }}
                            />
                        </View>
                    </>
                ) : (
                    <>
                        <Text style={styles.hint}>
                            Paste your Decks of KeyForge API key and every deck in your DoK
                            collection is queued for import.
                        </Text>
                        <TextField
                            placeholder='Decks of KeyForge API key'
                            value={dokKey}
                            onChangeText={setDokKey}
                            secureTextEntry
                            containerStyle={{ marginTop: spacing.sm }}
                        />
                        <View style={styles.switchRow}>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.switchLabel}>Remember this key</Text>
                                <Text style={styles.hint}>
                                    Keeps it on the server so new decks sync by themselves. Using
                                    it once does not store it.
                                </Text>
                            </View>
                            <Switch
                                value={remember}
                                onValueChange={setRemember}
                                trackColor={{ true: colors.brandDark, false: colors.surfaceHover }}
                                thumbColor={remember ? colors.brand : colors.textFaint}
                            />
                        </View>
                        <Button
                            title='Import collection'
                            loading={busy}
                            disabled={!dokKey.trim()}
                            onPress={() =>
                                run(async () => {
                                    const result = await prepareDokImport({
                                        dokApiKey: dokKey.trim(),
                                        remember,
                                        autoSync: remember
                                    });
                                    if (result.link) {
                                        setLink(result.link);
                                    }
                                    if (result.success) {
                                        setDokKey('');
                                    }

                                    return result;
                                }, 'Import started')
                            }
                        />
                    </>
                )}
            </Card>

            {/* ---- Find one by name ---- */}
            <Card style={{ marginBottom: spacing.md }}>
                <Text style={styles.sectionTitle}>Find a deck by name</Text>
                <TextField
                    placeholder='Deck name'
                    value={query}
                    onChangeText={setQuery}
                    autoCapitalize='words'
                />
                {searching ? <ActivityIndicator color={colors.brand} /> : null}
                {catalogEmpty ? (
                    <Text style={styles.hint}>
                        This server has not indexed the Master Vault catalog, so name search has
                        nothing to look through. Paste a deck link instead.
                    </Text>
                ) : null}
                {results.map((deck) => (
                    <View key={deck.uuid} style={styles.resultRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.resultName} numberOfLines={2}>
                                {deck.name}
                            </Text>
                            <View style={styles.resultMeta}>
                                {(deck.houses ?? []).map((house) => (
                                    <HouseIcon key={house} house={house} size={16} />
                                ))}
                                {expansionLabel(deck.expansion) ? (
                                    <Text style={styles.resultMetaText}>
                                        {expansionLabel(deck.expansion)}
                                    </Text>
                                ) : null}
                                {typeof deck.sasRating === 'number' ? (
                                    <Text style={styles.resultMetaText}>
                                        {Math.round(deck.sasRating)} SAS
                                    </Text>
                                ) : null}
                            </View>
                        </View>
                        {deck.owned ? (
                            <Text style={styles.owned}>owned</Text>
                        ) : (
                            <Button
                                small
                                title='Import'
                                loading={importingUuid === deck.uuid}
                                onPress={() => importOne(deck.uuid)}
                            />
                        )}
                    </View>
                ))}
            </Card>

            {/* ---- Paste ids ---- */}
            <Card>
                <Text style={styles.sectionTitle}>Paste deck links or ids</Text>
                <Text style={styles.hint}>
                    Any number of Master Vault links or ids, including a Decks of KeyForge CSV
                    export.
                </Text>
                <TextField
                    placeholder='Paste here'
                    value={pasted}
                    onChangeText={setPasted}
                    multiline
                    numberOfLines={4}
                    style={{ minHeight: 96, textAlignVertical: 'top' }}
                    containerStyle={{ marginTop: spacing.sm }}
                />
                <Text style={styles.hint}>
                    {pastedUuids.length === 0
                        ? 'No deck ids found yet.'
                        : `${pastedUuids.length} deck${
                              pastedUuids.length === 1 ? '' : 's'
                          } found.`}
                </Text>
                <Button
                    title='Import these'
                    loading={busy}
                    disabled={pastedUuids.length === 0}
                    onPress={() =>
                        run(async () => {
                            // One id is a single import, not a background job:
                            // the player is waiting on it and a job would
                            // report progress they do not need.
                            if (pastedUuids.length === 1) {
                                const uuid = parseDeckUuid(pastedUuids[0]) ?? pastedUuids[0];
                                const result = await importDeck(uuid);
                                if (result.success) {
                                    setPasted('');
                                }

                                return result;
                            }

                            const result = await queueDeckImport(pastedUuids);
                            if (result.success) {
                                setPasted('');
                            }

                            return result;
                        }, 'Import started')
                    }
                    style={{ marginTop: spacing.sm }}
                />
            </Card>

            <Button
                variant='ghost'
                title='Back to my decks'
                onPress={() => router.back()}
                style={{ marginTop: spacing.lg }}
            />
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    sectionTitle: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
        marginBottom: 6
    },
    hint: {
        color: colors.textFaint,
        fontSize: 12,
        lineHeight: 17,
        marginTop: 4
    },
    notice: {
        color: '#7ed494',
        fontSize: 13,
        marginBottom: spacing.md
    },
    switchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        marginBottom: spacing.md
    },
    switchLabel: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '600'
    },
    rowActions: {
        flexDirection: 'row',
        gap: spacing.sm,
        marginTop: spacing.md
    },
    jobBox: {
        backgroundColor: colors.surface,
        borderColor: colors.brandDark,
        borderWidth: 1,
        borderRadius: radius.lg,
        padding: spacing.md,
        marginBottom: spacing.md
    },
    jobHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between'
    },
    jobStatus: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '700'
    },
    cancelText: {
        color: colors.danger,
        fontSize: 13,
        fontWeight: '600'
    },
    track: {
        height: 6,
        borderRadius: 3,
        backgroundColor: colors.bgElevated,
        marginTop: spacing.sm,
        overflow: 'hidden'
    },
    fill: {
        height: '100%',
        backgroundColor: colors.brand
    },
    jobMeta: {
        color: colors.textFaint,
        fontSize: 12,
        marginTop: 5
    },
    jobError: {
        color: '#ff8f93',
        fontSize: 12,
        marginTop: 5
    },
    resultRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.sm,
        borderTopColor: colors.border,
        borderTopWidth: StyleSheet.hairlineWidth
    },
    resultName: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '600'
    },
    resultMeta: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 3
    },
    resultMetaText: {
        color: colors.textFaint,
        fontSize: 11
    },
    owned: {
        color: colors.textFaint,
        fontSize: 11,
        fontWeight: '700',
        textTransform: 'uppercase'
    }
});
