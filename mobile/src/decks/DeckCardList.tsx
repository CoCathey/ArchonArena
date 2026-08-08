import React, { useMemo } from 'react';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Deck, DeckCard, ShortCard } from '../api/types';
import { ENHANCEMENT_PIPS } from '../game/cardIcons';
import type { CardSummary } from '../game/types';
import { colors, spacing } from '../theme';
import HouseIcon from '../ui/HouseIcon';

export interface ResolvedCard {
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

export function resolveDeckCard(
    card: DeckCard,
    dictionary: Record<string, ShortCard>
): ResolvedCard {
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

/**
 * A deck's contents grouped by house. Shared by the deck detail screen and the
 * pre-game picker, so choosing a deck for a game shows the same list as
 * browsing the collection.
 */
export default function DeckCardList(props: {
    deck?: Deck;
    dictionary?: Record<string, ShortCard>;
    onCardPress?: (card: CardSummary) => void;
}) {
    const { deck, dictionary } = props;
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
            const resolved = resolveDeckCard(card, dictionary);
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
        const cards = deck.cards
            .filter((card) => card.isNonDeck)
            .map((card) => resolveDeckCard(card, dictionary));
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

    // Houses the deck reports but that carry no cards are skipped; a house
    // holding cards that the deck's own house list missed still gets a section.
    const sections = houses.concat(
        [...byHouse.keys()].filter((house) => !houses.includes(house))
    );

    const press = (card: ResolvedCard) =>
        props.onCardPress?.({ uuid: card.key, image: card.image, name: card.name });

    return (
        <View>
            {sections.map((house) => {
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
                            <CardRow key={card.key} card={card} onPress={() => press(card)} />
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
                        <CardRow key={card.key} card={card} onPress={() => press(card)} />
                    ))}
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
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
