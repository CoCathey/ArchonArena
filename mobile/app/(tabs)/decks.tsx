import React, { useCallback, useRef, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import {
    ActivityIndicator,
    FlatList,
    Keyboard,
    RefreshControl,
    StyleSheet,
    Text,
    View
} from 'react-native';
import { importDeck, parseDeckUuid } from '../../src/api/client';
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
                    <DeckRow deck={item} onPress={() => router.push(`/deck/${item.id}`)} />
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
    }
});
