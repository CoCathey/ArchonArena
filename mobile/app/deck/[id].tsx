import React, { useCallback, useEffect, useState } from 'react';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import {
    ActivityIndicator,
    Alert,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    View
} from 'react-native';
import {
    deleteDeck,
    fetchDeck,
    refreshDeckAccolades,
    setAccoladeShown
} from '../../src/api/client';
import type { AercBreakdown, Deck } from '../../src/api/types';
import DeckCardList from '../../src/decks/DeckCardList';
import { expansionLabel } from '../../src/decks/expansions';
import { CardZoomModal } from '../../src/game/GameModals';
import type { CardSummary } from '../../src/game/types';
import { useCardsStore } from '../../src/stores/cardsStore';
import { colors, radius, spacing } from '../../src/theme';
import HouseIcon from '../../src/ui/HouseIcon';
import { Button, ErrorBanner } from '../../src/ui/primitives';

/** One AERC component as a labelled bar, scaled against the deck's largest. */
function AercRow(props: { label: string; value: number; max: number }) {
    const fraction = props.max > 0 ? Math.max(0, props.value) / props.max : 0;
    return (
        <View style={styles.aercRow}>
            <Text style={styles.aercLabel} numberOfLines={1}>
                {props.label}
            </Text>
            <View style={styles.aercTrack}>
                <View style={[styles.aercFill, { width: `${Math.round(fraction * 100)}%` }]} />
            </View>
            <Text style={styles.aercValue}>{props.value.toFixed(1)}</Text>
        </View>
    );
}

export default function DeckDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const [deck, setDeck] = useState<Deck | undefined>();
    const [aerc, setAerc] = useState<AercBreakdown | undefined>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [zoomCard, setZoomCard] = useState<CardSummary | undefined>();
    const [deleting, setDeleting] = useState(false);
    const [refreshingAccolades, setRefreshingAccolades] = useState(false);

    const dictionary = useCardsStore((state) => state.cards);
    const cardsError = useCardsStore((state) => state.error);
    const loadCards = useCardsStore((state) => state.load);

    const load = useCallback(async () => {
        if (!id) {
            return;
        }
        setLoading(true);
        setError(undefined);
        try {
            const result = await fetchDeck(id);
            if (!result.success || !result.deck) {
                setError(result.message ?? 'Could not load this deck');
            } else {
                setDeck(result.deck);
                setAerc(result.aerc ?? undefined);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load this deck');
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        load();
        loadCards();
    }, [load, loadCards]);

    const confirmDelete = () => {
        if (!deck) {
            return;
        }

        Alert.alert(
            'Delete deck',
            `Remove “${deck.name}” from your collection? Games you played with it are kept.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: async () => {
                        setDeleting(true);
                        setError(undefined);
                        try {
                            const result = await deleteDeck(deck.id);
                            if (!result.success) {
                                setError(result.message ?? 'Could not delete this deck');
                                return;
                            }
                            router.back();
                        } catch (err) {
                            setError(
                                err instanceof Error ? err.message : 'Could not delete this deck'
                            );
                        } finally {
                            setDeleting(false);
                        }
                    }
                }
            ]
        );
    };

    const refreshAccolades = async () => {
        if (!deck) {
            return;
        }
        setRefreshingAccolades(true);
        setError(undefined);
        try {
            const result = await refreshDeckAccolades(deck.id);
            if (!result.success) {
                setError(result.message ?? 'Could not check for accolades');
                return;
            }
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not check for accolades');
        } finally {
            setRefreshingAccolades(false);
        }
    };

    /**
     * Optimistic: the toggle is the only thing on screen that changes, and a
     * pill that waits on a round trip before moving feels broken.
     */
    const toggleAccolade = async (accoladeId: string, shown: boolean) => {
        if (!deck) {
            return;
        }

        const before = deck.accolades ?? [];
        setDeck({
            ...deck,
            accolades: before.map((accolade) =>
                accolade.id === accoladeId ? { ...accolade, shown } : accolade
            )
        });

        try {
            const result = await setAccoladeShown(deck.id, accoladeId, shown);
            if (!result.success) {
                setDeck({ ...deck, accolades: before });
            }
        } catch {
            setDeck({ ...deck, accolades: before });
        }
    };

    const houses = deck?.houses ?? [];
    const sas = typeof deck?.sasRating === 'number' ? Math.round(deck.sasRating) : undefined;
    const set = expansionLabel(deck?.expansion);
    const totalGames = (deck?.wins ?? 0) + (deck?.losses ?? 0);
    const components = (aerc?.components ?? []).filter((component) => component.value !== 0);
    const aercMax = components.reduce((max, component) => Math.max(max, component.value), 0);
    const busy = loading || (!dictionary && !cardsError);

    return (
        <View style={styles.container}>
            <Stack.Screen options={{ title: deck?.name ?? 'Deck' }} />
            <ScrollView
                contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
                refreshControl={
                    <RefreshControl
                        refreshing={loading}
                        onRefresh={load}
                        tintColor={colors.textDim}
                    />
                }
            >
                <ErrorBanner message={error ?? cardsError} />

                {deck ? (
                    <View style={styles.summary}>
                        <Text style={styles.deckName}>{deck.name}</Text>
                        <View style={styles.metaRow}>
                            <View style={styles.houseIcons}>
                                {houses.map((house) => (
                                    <HouseIcon key={house} house={house} size={24} />
                                ))}
                            </View>
                            {set ? <Text style={styles.set}>{set}</Text> : null}
                            {sas !== undefined ? (
                                <Text style={styles.sas}>{sas} SAS</Text>
                            ) : null}
                        </View>
                        <View style={styles.statLine}>
                            {typeof aerc?.aercScore === 'number' ? (
                                <Text style={styles.statChip}>
                                    AERC {aerc.aercScore.toFixed(1)}
                                </Text>
                            ) : null}
                            {typeof aerc?.sasPercentile === 'number' ? (
                                <Text style={styles.statChip}>
                                    Top {(100 - aerc.sasPercentile).toFixed(0)}%
                                </Text>
                            ) : null}
                            {typeof aerc?.synergyRating === 'number' ? (
                                <Text style={styles.statChip}>
                                    Synergy +{aerc.synergyRating.toFixed(0)}
                                </Text>
                            ) : null}
                            {typeof aerc?.antisynergyRating === 'number' &&
                            aerc.antisynergyRating !== 0 ? (
                                <Text style={styles.statChip}>
                                    Anti −{Math.abs(aerc.antisynergyRating).toFixed(0)}
                                </Text>
                            ) : null}
                        </View>
                        {totalGames > 0 ? (
                            <Text style={styles.record}>
                                {deck?.wins ?? 0} wins · {deck?.losses ?? 0} losses
                                {typeof deck?.winRate === 'number'
                                    ? ` · ${deck.winRate.toFixed(0)}% win rate`
                                    : ''}
                            </Text>
                        ) : null}
                    </View>
                ) : null}

                {/* ARCHON: tournament placings Master Vault records against
                    this deck. `shown` is the owner's choice of which ones
                    ride on the deck's card back in game, so the toggle is the
                    point of the panel rather than decoration on it. */}
                {deck && (deck.accolades ?? []).length > 0 ? (
                    <View style={styles.summary}>
                        <View style={styles.accoladeHeader}>
                            <Text style={styles.sectionTitle}>Accolades</Text>
                            <Button
                                small
                                variant='secondary'
                                title='Refresh'
                                loading={refreshingAccolades}
                                onPress={refreshAccolades}
                            />
                        </View>
                        {(deck.accolades ?? []).map((accolade) => (
                            <Pressable
                                key={accolade.id}
                                onPress={() => toggleAccolade(accolade.id, !accolade.shown)}
                                style={styles.accoladeRow}
                            >
                                <Text style={styles.accoladeName} numberOfLines={2}>
                                    {accolade.name}
                                </Text>
                                <Text
                                    style={[
                                        styles.accoladeToggle,
                                        accolade.shown && { color: colors.brand }
                                    ]}
                                >
                                    {accolade.shown ? 'shown' : 'hidden'}
                                </Text>
                            </Pressable>
                        ))}
                    </View>
                ) : deck ? (
                    <View style={styles.summary}>
                        <View style={styles.accoladeHeader}>
                            <Text style={styles.sectionTitle}>Accolades</Text>
                            <Button
                                small
                                variant='secondary'
                                title='Check'
                                loading={refreshingAccolades}
                                onPress={refreshAccolades}
                            />
                        </View>
                        <Text style={styles.aercFootnote}>
                            No tournament placings recorded for this deck.
                        </Text>
                    </View>
                ) : null}

                {components.length > 0 ? (
                    <View style={styles.summary}>
                        <Text style={styles.sectionTitle}>AERC breakdown</Text>
                        {components.map((component) => (
                            <AercRow
                                key={component.key}
                                label={component.label}
                                value={component.value}
                                max={aercMax}
                            />
                        ))}
                        <Text style={styles.aercFootnote}>
                            Decks of KeyForge ratings
                            {aerc?.aercVersion ? ` · v${aerc.aercVersion}` : ''}
                        </Text>
                    </View>
                ) : null}

                {busy ? (
                    <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.xl }} />
                ) : null}

                <DeckCardList
                    deck={deck}
                    dictionary={dictionary ?? undefined}
                    onCardPress={setZoomCard}
                />

                {/* ARCHON: removing a deck from your collection. The app could
                    import decks from the first release and never remove one,
                    so a mistyped link or a deck sold on stayed in the library
                    forever. The server archives the games rather than erasing
                    them, which is why the warning says the deck and not the
                    record. */}
                {deck ? (
                    <Button
                        title='Delete deck'
                        variant='danger'
                        loading={deleting}
                        onPress={confirmDelete}
                        style={{ marginTop: spacing.lg }}
                    />
                ) : null}
            </ScrollView>

            <CardZoomModal card={zoomCard} onClose={() => setZoomCard(undefined)} />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    summary: {
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 12,
        padding: spacing.lg,
        marginBottom: spacing.md
    },
    deckName: {
        color: colors.text,
        fontSize: 17,
        fontWeight: '800'
    },
    metaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        marginTop: spacing.sm
    },
    houseIcons: {
        flexDirection: 'row',
        gap: 8,
        flex: 1
    },
    set: {
        color: colors.textFaint,
        fontSize: 12,
        fontWeight: '700'
    },
    sas: {
        color: colors.brand,
        fontSize: 15,
        fontWeight: '800'
    },
    statLine: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm,
        marginTop: spacing.sm
    },
    statChip: {
        color: colors.textDim,
        fontSize: 11,
        fontWeight: '700',
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: 9,
        paddingVertical: 3,
        overflow: 'hidden'
    },
    record: {
        color: colors.textDim,
        fontSize: 12,
        marginTop: 8
    },
    sectionTitle: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '800',
        marginBottom: spacing.sm
    },
    aercRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingVertical: 3
    },
    aercLabel: {
        color: colors.textDim,
        fontSize: 11,
        width: 108
    },
    aercTrack: {
        flex: 1,
        height: 6,
        borderRadius: 3,
        backgroundColor: colors.bgElevated,
        overflow: 'hidden'
    },
    aercFill: {
        height: '100%',
        backgroundColor: colors.brand
    },
    aercValue: {
        color: colors.text,
        fontSize: 11,
        fontWeight: '700',
        fontVariant: ['tabular-nums'],
        width: 34,
        textAlign: 'right'
    },
    accoladeHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 4
    },
    accoladeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md,
        paddingVertical: 7,
        borderTopColor: colors.border,
        borderTopWidth: StyleSheet.hairlineWidth
    },
    accoladeName: {
        color: colors.text,
        fontSize: 13,
        flex: 1
    },
    accoladeToggle: {
        color: colors.textFaint,
        fontSize: 11,
        fontWeight: '700',
        textTransform: 'uppercase'
    },
    aercFootnote: {
        color: colors.textFaint,
        fontSize: 10,
        marginTop: spacing.sm
    }
});
