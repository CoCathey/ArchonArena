import React, { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import {
    ActivityIndicator,
    FlatList,
    Pressable,
    RefreshControl,
    StyleSheet,
    Text,
    View
} from 'react-native';
import type { Deck } from '../../src/api/types';
import { fetchDecks, importDeck, parseDeckUuid } from '../../src/api/client';
import { colors, spacing } from '../../src/theme';
import HouseIcon from '../../src/ui/HouseIcon';
import { Button, Card, EmptyState, ErrorBanner, TextField } from '../../src/ui/primitives';

export function DeckRow(props: { deck: Deck; onPress?: () => void; selected?: boolean }) {
    const { deck } = props;
    const sas = deck.dokStats?.sas;
    return (
        <Card
            style={StyleSheet.flatten([
                styles.deckRow,
                props.selected ? { borderColor: colors.brand } : null
            ])}
        >
            <View style={{ flex: 1 }}>
                <Text
                    style={styles.deckName}
                    numberOfLines={2}
                    onPress={props.onPress}
                    suppressHighlighting
                >
                    {deck.name}
                </Text>
                <View style={styles.deckMeta}>
                    <View style={styles.houseRow}>
                        {(deck.houses ?? []).map((house) => (
                            <HouseIcon key={house} house={house} size={22} />
                        ))}
                    </View>
                    {typeof sas === 'number' ? (
                        <Text style={styles.sas}>{Math.round(sas)} SAS</Text>
                    ) : null}
                    {deck.verified ? <Text style={styles.verified}>✓ verified</Text> : null}
                </View>
            </View>
            {props.onPress ? (
                <Button small title={props.selected ? 'Selected' : 'Select'} onPress={props.onPress} />
            ) : null}
        </Card>
    );
}

export default function DecksScreen() {
    const [decks, setDecks] = useState<Deck[]>([]);
    const [loading, setLoading] = useState(false);
    const [importText, setImportText] = useState('');
    const [importing, setImporting] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [notice, setNotice] = useState<string | undefined>();

    const load = useCallback(async () => {
        setLoading(true);
        setError(undefined);
        try {
            const result = await fetchDecks({ pageSize: 100 });
            setDecks(result.decks ?? []);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load decks');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const doImport = async () => {
        setError(undefined);
        setNotice(undefined);
        const uuid = parseDeckUuid(importText);
        if (!uuid) {
            setError('Paste a Master Vault deck link or deck id');
            return;
        }
        setImporting(true);
        try {
            const result = await importDeck(uuid);
            if (!result.success) {
                setError(result.message ?? 'Import failed');
                return;
            }
            setImportText('');
            setNotice('Deck imported');
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Import failed');
        } finally {
            setImporting(false);
        }
    };

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
            <View style={{ paddingHorizontal: spacing.md }}>
                <ErrorBanner message={error} />
                {notice ? <Text style={styles.notice}>{notice}</Text> : null}
            </View>

            <FlatList
                data={decks}
                keyExtractor={(deck) => String(deck.id)}
                renderItem={({ item }) => (
                    <Pressable
                        onPress={() => router.push(`/deck/${item.id}`)}
                        style={({ pressed }) => pressed && { opacity: 0.7 }}
                    >
                        <DeckRow deck={item} />
                    </Pressable>
                )}
                contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
                refreshControl={
                    <RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.textDim} />
                }
                ListEmptyComponent={
                    loading ? (
                        <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.xl }} />
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
        padding: spacing.md
    },
    deckRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        marginBottom: spacing.sm
    },
    deckName: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700'
    },
    deckMeta: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        marginTop: 8
    },
    houseRow: {
        flexDirection: 'row',
        gap: 6
    },
    sas: {
        color: colors.brand,
        fontSize: 12,
        fontWeight: '700'
    },
    verified: {
        color: '#7ed494',
        fontSize: 12
    },
    notice: {
        color: '#7ed494',
        fontSize: 13,
        marginBottom: spacing.sm
    }
});
