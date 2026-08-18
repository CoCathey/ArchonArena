import React, { useCallback, useRef, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Keyboard,
    Pressable,
    RefreshControl,
    StyleSheet,
    Text,
    View
} from 'react-native';
import { bulkDeleteDecks, importDeck, parseDeckUuid } from '../../src/api/client';
import DeckFilterBar from '../../src/decks/DeckFilterBar';
import DeckRow from '../../src/decks/DeckRow';
import { useDeckLibrary } from '../../src/decks/useDeckLibrary';
import { colors, spacing } from '../../src/theme';
import { Button, EmptyState, ErrorBanner, TextField } from '../../src/ui/primitives';

export default function DecksScreen() {
    const library = useDeckLibrary({ pageSize: 40 });
    // Tab screens stay mounted, so a deck deleted on the detail screen would
    // still be sitting in this list when the player came back. Refresh on
    // every RETURN to the tab, not on first focus — the hook has just loaded.
    const seenFocus = useRef(false);
    const refresh = library.refresh;
    useFocusEffect(
        useCallback(() => {
            if (!seenFocus.current) {
                seenFocus.current = true;
                return;
            }
            refresh();
        }, [refresh])
    );
    const [importText, setImportText] = useState('');
    const [importing, setImporting] = useState(false);
    const [importError, setImportError] = useState<string | undefined>();
    const [notice, setNotice] = useState<string | undefined>();
    // ARCHON: selection mode. Off by default — tapping a deck opens it, which
    // is what a tap on a deck means everywhere else in the app.
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [deleting, setDeleting] = useState(false);

    const toggleSelected = (id: string) =>
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }

            return next;
        });

    const leaveSelection = () => {
        setSelecting(false);
        setSelected(new Set());
    };

    const confirmBulkDelete = () => {
        const ids = [...selected];
        if (ids.length === 0) {
            return;
        }

        Alert.alert(
            `Delete ${ids.length} deck${ids.length === 1 ? '' : 's'}`,
            'Games you played with them are kept. A deck registered for a live event is left alone.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: async () => {
                        setDeleting(true);
                        setImportError(undefined);
                        try {
                            const result = await bulkDeleteDecks(ids);
                            if (!result.success) {
                                setImportError(result.message ?? 'Could not delete those decks');
                                return;
                            }
                            const skipped = result.skipped?.length ?? 0;
                            setNotice(
                                skipped > 0
                                    ? `${result.deleted ?? ids.length - skipped} deleted · ${skipped} left alone`
                                    : `${result.deleted ?? ids.length} deleted`
                            );
                            leaveSelection();
                            await library.refresh();
                        } catch (err) {
                            setImportError(
                                err instanceof Error ? err.message : 'Could not delete those decks'
                            );
                        } finally {
                            setDeleting(false);
                        }
                    }
                }
            ]
        );
    };

    const doImport = async () => {
        setImportError(undefined);
        setNotice(undefined);
        const uuid = parseDeckUuid(importText);
        if (!uuid) {
            setImportError('Paste a Master Vault deck link or deck id');
            return;
        }
        setImporting(true);
        try {
            const result = await importDeck(uuid);
            if (!result.success) {
                setImportError(result.message ?? 'Import failed');
                return;
            }
            setImportText('');
            setNotice('Deck imported');
            Keyboard.dismiss();
            await library.refresh();
        } catch (err) {
            setImportError(err instanceof Error ? err.message : 'Import failed');
        } finally {
            setImporting(false);
        }
    };

    const summary = library.filtered
        ? `${library.decks.length} of ${library.total} shown`
        : library.total > 0
        ? `${library.total} deck${library.total === 1 ? '' : 's'}`
        : undefined;

    return (
        <View style={styles.container}>
            <View style={styles.importBox}>
                <TextField
                    placeholder='Master Vault link or deck id'
                    value={importText}
                    onChangeText={setImportText}
                    containerStyle={{ flex: 1, marginBottom: 0 }}
                />
                <Button title='Import' onPress={doImport} loading={importing} />
            </View>

            {/* The rest of the import surface — a whole collection, a name
                search, a pasted CSV — plus the alliance builder. Both are too
                much for the header of a list. */}
            <View style={styles.toolRow}>
                <Pressable onPress={() => router.push('/deck-import')} hitSlop={6}>
                    <Text style={styles.toolLink}>Bulk import</Text>
                </Pressable>
                <Pressable onPress={() => router.push('/decks/alliance')} hitSlop={6}>
                    <Text style={styles.toolLink}>Build alliance</Text>
                </Pressable>
                <View style={{ flex: 1 }} />
                {selecting ? (
                    <>
                        <Pressable onPress={leaveSelection} hitSlop={6}>
                            <Text style={styles.toolLink}>Cancel</Text>
                        </Pressable>
                        <Pressable
                            onPress={confirmBulkDelete}
                            disabled={selected.size === 0 || deleting}
                            hitSlop={6}
                        >
                            <Text
                                style={[
                                    styles.toolDanger,
                                    (selected.size === 0 || deleting) && { opacity: 0.4 }
                                ]}
                            >
                                Delete {selected.size > 0 ? selected.size : ''}
                            </Text>
                        </Pressable>
                    </>
                ) : (
                    <Pressable onPress={() => setSelecting(true)} hitSlop={6}>
                        <Text style={styles.toolLink}>Select</Text>
                    </Pressable>
                )}
            </View>

            <DeckFilterBar
                search={library.searchInput}
                onSearchChange={library.setSearchInput}
                sort={library.sort}
                onSortChange={library.setSort}
                houses={library.houses}
                onToggleHouse={library.toggleHouse}
                onClear={library.clearFilters}
                summary={summary}
            />

            <View style={{ paddingHorizontal: spacing.md, paddingTop: spacing.sm }}>
                <ErrorBanner message={importError ?? library.error} />
                {notice ? <Text style={styles.notice}>{notice}</Text> : null}
            </View>

            <FlatList
                data={library.decks}
                keyExtractor={(deck) => String(deck.id)}
                keyboardShouldPersistTaps='handled'
                keyboardDismissMode='on-drag'
                renderItem={({ item }) => (
                    <DeckRow
                        deck={item}
                        selected={selecting && selected.has(String(item.id))}
                        onPress={() =>
                            selecting
                                ? toggleSelected(String(item.id))
                                : router.push(`/deck/${item.id}`)
                        }
                    />
                )}
                contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
                refreshControl={
                    <RefreshControl
                        refreshing={library.loading}
                        onRefresh={library.refresh}
                        tintColor={colors.textDim}
                    />
                }
                onEndReached={library.loadMore}
                onEndReachedThreshold={0.5}
                ListFooterComponent={
                    library.loadingMore ? (
                        <ActivityIndicator color={colors.brand} style={{ marginVertical: 16 }} />
                    ) : library.hasMore ? (
                        <Button
                            variant='secondary'
                            title={`Load more (${library.total - library.decks.length} left)`}
                            onPress={library.loadMore}
                        />
                    ) : null
                }
                ListEmptyComponent={
                    library.loading ? (
                        <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.xl }} />
                    ) : library.filtered ? (
                        <EmptyState
                            title='No decks match'
                            subtitle='Try a different name or clear the house filter.'
                        />
                    ) : (
                        <EmptyState
                            title='No decks yet'
                            subtitle='Import a deck from the Master Vault with the field above.'
                        />
                    )
                }
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    importBox: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        padding: spacing.md,
        paddingBottom: 0
    },
    notice: {
        color: '#7ed494',
        fontSize: 13,
        marginBottom: spacing.sm
    },
    toolRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.md,
        paddingTop: spacing.sm
    },
    toolLink: {
        color: colors.accent,
        fontSize: 13,
        fontWeight: '600'
    },
    toolDanger: {
        color: colors.danger,
        fontSize: 13,
        fontWeight: '700'
    }
});
