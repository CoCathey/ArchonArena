import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { addStore, fetchStores, type Store } from '../src/api/play';
import { colors, radius, spacing } from '../src/theme';
import { Button, Card, EmptyState, ErrorBanner, TextField } from '../src/ui/primitives';

/**
 * ARCHON: Into the Fray — where people play in person.
 *
 * The store list is community-maintained: anybody signed in can add one, and
 * the person who added it (or a moderator) can take it down. That is the whole
 * moderation model, and it is the server's, not this screen's.
 *
 * Deliberately a list rather than a map. A map needs a maps SDK, an API key
 * and a location permission to show what is, in practice, a few dozen shops
 * that people search by name or country anyway.
 */

function locationLine(store: Store): string {
    return [store.city, store.state, store.country].filter(Boolean).join(', ');
}

export default function StoresScreen() {
    const [query, setQuery] = useState('');
    const [stores, setStores] = useState<Store[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const [adding, setAdding] = useState(false);
    const [busy, setBusy] = useState(false);
    const [name, setName] = useState('');
    const [city, setCity] = useState('');
    const [state, setState] = useState('');
    const [country, setCountry] = useState('');
    const [website, setWebsite] = useState('');

    const load = useCallback(async (search: string) => {
        setLoading(true);
        setError(undefined);
        try {
            const result = await fetchStores({ query: search || undefined });
            setStores(result.stores ?? []);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load the store list');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => load(query.trim()), query ? 300 : 0);

        return () => clearTimeout(timer);
    }, [load, query]);

    const submit = async () => {
        if (!name.trim()) {
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            const result = await addStore({
                name: name.trim(),
                city: city.trim() || undefined,
                state: state.trim() || undefined,
                country: country.trim().toUpperCase() || undefined,
                website: website.trim() || undefined
            });
            if (!result.success) {
                setError(result.message ?? 'Could not add that store');
                return;
            }
            setName('');
            setCity('');
            setState('');
            setCountry('');
            setWebsite('');
            setAdding(false);
            await load(query.trim());
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not add that store');
        } finally {
            setBusy(false);
        }
    };

    return (
        <View style={styles.container}>
            <FlatList
                data={stores}
                keyExtractor={(store) => String(store.id)}
                keyboardShouldPersistTaps='handled'
                contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
                refreshControl={
                    <RefreshControl
                        refreshing={loading}
                        onRefresh={() => load(query.trim())}
                        tintColor={colors.brand}
                    />
                }
                ListHeaderComponent={
                    <View>
                        <ErrorBanner message={error} />
                        <TextField
                            placeholder='Search by name, city or country'
                            value={query}
                            onChangeText={setQuery}
                        />

                        {adding ? (
                            <Card style={{ marginBottom: spacing.md }}>
                                <Text style={styles.sectionTitle}>Add a store</Text>
                                <TextField
                                    label='Name'
                                    value={name}
                                    onChangeText={setName}
                                    autoCapitalize='words'
                                />
                                <TextField
                                    label='City'
                                    value={city}
                                    onChangeText={setCity}
                                    autoCapitalize='words'
                                />
                                <TextField
                                    label='State or region'
                                    value={state}
                                    onChangeText={setState}
                                    autoCapitalize='words'
                                />
                                <TextField
                                    label='Country'
                                    value={country}
                                    onChangeText={setCountry}
                                    placeholder='e.g. GB'
                                    autoCapitalize='characters'
                                    maxLength={2}
                                />
                                <TextField
                                    label='Website'
                                    value={website}
                                    onChangeText={setWebsite}
                                    keyboardType='url'
                                />
                                <View style={styles.actions}>
                                    <Button
                                        variant='secondary'
                                        title='Cancel'
                                        onPress={() => setAdding(false)}
                                        style={{ flex: 1 }}
                                    />
                                    <Button
                                        title='Add'
                                        loading={busy}
                                        disabled={!name.trim()}
                                        onPress={submit}
                                        style={{ flex: 1 }}
                                    />
                                </View>
                            </Card>
                        ) : (
                            <Button
                                small
                                variant='secondary'
                                title='Add a store'
                                onPress={() => setAdding(true)}
                                style={{ alignSelf: 'flex-start', marginBottom: spacing.md }}
                            />
                        )}
                    </View>
                }
                renderItem={({ item }) => (
                    <View style={styles.row}>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.name}>{item.name}</Text>
                            {locationLine(item) ? (
                                <Text style={styles.meta}>{locationLine(item)}</Text>
                            ) : null}
                            {item.address ? (
                                <Text style={styles.meta} numberOfLines={2}>
                                    {item.address}
                                </Text>
                            ) : null}
                            {item.description ? (
                                <Text style={styles.description} numberOfLines={3}>
                                    {item.description}
                                </Text>
                            ) : null}
                        </View>
                        {item.website ? (
                            <Pressable
                                onPress={() =>
                                    Linking.openURL(
                                        item.website?.startsWith('http')
                                            ? item.website
                                            : `https://${item.website}`
                                    )
                                }
                                hitSlop={8}
                            >
                                <Text style={styles.link}>Visit</Text>
                            </Pressable>
                        ) : null}
                    </View>
                )}
                ListEmptyComponent={
                    loading ? null : (
                        <EmptyState
                            title={query ? `Nothing matches “${query}”` : 'No stores listed yet'}
                            subtitle='Anybody can add the shop they play at.'
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
    sectionTitle: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
        marginBottom: spacing.sm
    },
    actions: {
        flexDirection: 'row',
        gap: spacing.sm
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.lg,
        padding: spacing.md,
        marginBottom: spacing.sm
    },
    name: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700'
    },
    meta: {
        color: colors.textFaint,
        fontSize: 12,
        marginTop: 2
    },
    description: {
        color: colors.textDim,
        fontSize: 12,
        marginTop: 4,
        lineHeight: 17
    },
    link: {
        color: colors.accent,
        fontSize: 13,
        fontWeight: '600'
    }
});
