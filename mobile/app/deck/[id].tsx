import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import {
    ActivityIndicator,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    View
} from 'react-native';
import { Image } from 'expo-image';
import { fetchDeck } from '../../src/api/client';
import type { Deck, DeckCard, ShortCard } from '../../src/api/types';
import { CardZoomModal } from '../../src/game/GameModals';
import { ENHANCEMENT_PIPS } from '../../src/game/cardIcons';
import type { CardSummary } from '../../src/game/types';
import { useCardsStore } from '../../src/stores/cardsStore';
import { colors, spacing } from '../../src/theme';
import HouseIcon from '../../src/ui/HouseIcon';
import { ErrorBanner } from '../../src/ui/primitives';

interface ResolvedCard {
    key: string;
    id: string;
    count: number;
    name: string;
    type?: string;
    house?: string;
    image?: string;
    maverick?: boolean;
    anomaly?: boolean;
    enhancements: string[];
}

function resolve(card: DeckCard, dictionary: Record<string, ShortCard>): ResolvedCard {
    const data = dictionary[card.id];
    return {
        key: `${card.dbId ?? card.id}-${card.prophecyId ?? ''}`,
        id: card.id,
        count: card.count || 1,
        name: data?.name ?? card.id,
        type: data?.type,
        house: card.house ?? data?.house,
        // Same fallback the web client uses: enhanced/maverick prints carry
        // their own image, everything else is named after the card id. (The
        // dictionary's own image field is an external Master Vault URL, so it
        // is deliberately not used here.)
        image: card.image || card.id,
        maverick: !!card.maverick,
        anomaly: !!card.anomaly,
        enhancements: (card.enhancements ?? []).filter((pip) => !!pip)
    };
}

function CardRow(props: { card: ResolvedCard; onPress: () => void }) {
    const { card } = props;
    return (
        <Pressable
            onPress={props.onPress}
            style={({ pressed }) => [styles.cardRow, pressed && { opacity: 0.6 }]}
        >
            <Text style={styles.cardCount}>{card.count}×</Text>
            <Text style={styles.cardName} numberOfLines={1}>
                {card.name}
            </Text>
            {card.enhancements.map((pip, index) => {
                const source = ENHANCEMENT_PIPS[pip.toLowerCase().replace(/\s+/g, '')];
                return source ? (
                    <Image
                        key={`${pip}-${index}`}
                        source={source}
                        style={styles.pip}
                        contentFit='contain'
                    />
                ) : null;
            })}
            {card.maverick ? <Text style={styles.badgeMaverick}>maverick</Text> : null}
            {card.anomaly ? <Text style={styles.badgeAnomaly}>anomaly</Text> : null}
            {card.type ? <Text style={styles.cardType}>{card.type}</Text> : null}
        </Pressable>
    );
}

export default function DeckDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const [deck, setDeck] = useState<Deck | undefined>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [zoomCard, setZoomCard] = useState<CardSummary | undefined>();

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

    const houses = deck?.houses ?? [];
    const byHouse = useMemo(() => {
        const groups = new Map<string, ResolvedCard[]>();
        if (!deck?.cards || !dictionary) {
            return groups;
        }
        for (const card of deck.cards) {
            if (card.isNonDeck) {
                continue;
            }
            const resolved = resolve(card, dictionary);
            const house = resolved.house ?? 'unknown';
            const list = groups.get(house) ?? [];
            list.push(resolved);
            groups.set(house, list);
        }
        for (const list of groups.values()) {
            list.sort((a, b) => a.name.localeCompare(b.name));
        }
        return groups;
    }, [deck?.cards, dictionary]);

    const nonDeckCards = useMemo(() => {
        if (!deck?.cards || !dictionary) {
            return [];
        }
        const cards = deck.cards.filter((card) => card.isNonDeck).map((c) => resolve(c, dictionary));
        // Archon powers are baked into the deck identity; token creatures are
        // listed once, matching the web deck view.
        const seenTokens = new Set<string>();
        return cards.filter((card) => {
            if (card.type === 'archon power') {
                return false;
            }
            if (card.type === 'token creature') {
                if (seenTokens.has(card.key)) {
                    return false;
                }
                seenTokens.add(card.key);
            }
            return true;
        });
    }, [deck?.cards, dictionary]);

    const sas = deck?.dokStats?.sas;
    const totalGames = (deck?.wins ?? 0) + (deck?.losses ?? 0);
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
                            {typeof sas === 'number' ? (
                                <Text style={styles.sas}>{Math.round(sas)} SAS</Text>
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

                {busy ? (
                    <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.xl }} />
                ) : null}

                {houses.map((house) => {
                    const cards = byHouse.get(house) ?? [];
                    if (cards.length === 0) {
                        return null;
                    }
                    return (
                        <View key={house} style={styles.houseSection}>
                            <View style={styles.houseHeader}>
                                <HouseIcon house={house} size={22} />
                                <Text style={styles.houseName}>{house}</Text>
                                <Text style={styles.houseCount}>
                                    {cards.reduce((sum, card) => sum + card.count, 0)} cards
                                </Text>
                            </View>
                            {cards.map((card) => (
                                <CardRow
                                    key={card.key}
                                    card={card}
                                    onPress={() =>
                                        setZoomCard({ uuid: card.key, image: card.image })
                                    }
                                />
                            ))}
                        </View>
                    );
                })}

                {nonDeckCards.length > 0 ? (
                    <View style={styles.houseSection}>
                        <View style={styles.houseHeader}>
                            <Text style={styles.houseName}>Non-deck cards</Text>
                        </View>
                        {nonDeckCards.map((card) => (
                            <CardRow
                                key={card.key}
                                card={card}
                                onPress={() => setZoomCard({ uuid: card.key, image: card.image })}
                            />
                        ))}
                    </View>
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
        justifyContent: 'space-between',
        marginTop: spacing.sm
    },
    houseIcons: {
        flexDirection: 'row',
        gap: 8
    },
    sas: {
        color: colors.brand,
        fontSize: 13,
        fontWeight: '800'
    },
    record: {
        color: colors.textDim,
        fontSize: 12,
        marginTop: 6
    },
    houseSection: {
        marginBottom: spacing.md
    },
    houseHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingVertical: 6,
        borderBottomColor: colors.border,
        borderBottomWidth: 1,
        marginBottom: 4
    },
    houseName: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '800',
        textTransform: 'capitalize',
        flex: 1
    },
    houseCount: {
        color: colors.textFaint,
        fontSize: 12
    },
    cardRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        paddingVertical: 8,
        paddingHorizontal: 2,
        borderBottomColor: 'rgba(42, 54, 80, 0.4)',
        borderBottomWidth: StyleSheet.hairlineWidth
    },
    cardCount: {
        color: colors.textFaint,
        fontSize: 13,
        fontVariant: ['tabular-nums'],
        width: 24
    },
    cardName: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '600',
        flexShrink: 1
    },
    pip: {
        width: 14,
        height: 14
    },
    badgeMaverick: {
        color: colors.brand,
        fontSize: 10,
        fontWeight: '700'
    },
    badgeAnomaly: {
        color: colors.accent,
        fontSize: 10,
        fontWeight: '700'
    },
    cardType: {
        color: colors.textFaint,
        fontSize: 11,
        marginLeft: 'auto',
        textTransform: 'capitalize'
    }
});
