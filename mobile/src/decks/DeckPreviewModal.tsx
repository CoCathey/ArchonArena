import React, { useEffect, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Deck } from '../api/types';
import { CardZoomOverlay } from '../game/GameModals';
import type { CardSummary } from '../game/types';
import { useCardsStore } from '../stores/cardsStore';
import { colors, spacing } from '../theme';
import HouseIcon from '../ui/HouseIcon';
import { Button, ErrorBanner } from '../ui/primitives';
import DeckCardList from './DeckCardList';
import { expansionLabel } from './expansions';

/**
 * Read-only look at a deck's contents before committing to it. Deck lists
 * arrive with the collection itself, so opening this costs nothing beyond the
 * (cached) card dictionary.
 */
export default function DeckPreviewModal(props: {
    deck?: Deck;
    onClose: () => void;
    /** Shown as the confirm action, e.g. "Play this deck". */
    confirmLabel?: string;
    onConfirm?: (deck: Deck) => void;
}) {
    const { deck } = props;
    const insets = useSafeAreaInsets();
    const dictionary = useCardsStore((state) => state.cards);
    const cardsError = useCardsStore((state) => state.error);
    const loadCards = useCardsStore((state) => state.load);
    const [zoomCard, setZoomCard] = useState<CardSummary | undefined>();

    useEffect(() => {
        if (deck) {
            loadCards();
        }
    }, [deck, loadCards]);

    const sas = typeof deck?.sasRating === 'number' ? Math.round(deck.sasRating) : undefined;
    const set = expansionLabel(deck?.expansion);

    return (
        <Modal visible={!!deck} animationType='slide' onRequestClose={props.onClose}>
            <View style={[styles.container, { paddingTop: insets.top + 12 }]}>
                <View style={styles.header}>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.title} numberOfLines={2}>
                            {deck?.name ?? 'Deck'}
                        </Text>
                        <View style={styles.metaRow}>
                            {(deck?.houses ?? []).map((house) => (
                                <HouseIcon key={house} house={house} size={20} />
                            ))}
                            {sas !== undefined ? (
                                <Text style={styles.sas}>{sas} SAS</Text>
                            ) : null}
                            {set ? <Text style={styles.set}>{set}</Text> : null}
                        </View>
                    </View>
                    <Button small variant='secondary' title='Close' onPress={props.onClose} />
                </View>

                <ScrollView
                    contentContainerStyle={{
                        padding: spacing.md,
                        paddingBottom: insets.bottom + 96
                    }}
                >
                    <ErrorBanner message={cardsError} />
                    {!dictionary && !cardsError ? (
                        <Text style={styles.loading}>Loading card names…</Text>
                    ) : null}
                    <DeckCardList
                        deck={deck}
                        dictionary={dictionary ?? undefined}
                        onCardPress={setZoomCard}
                    />
                </ScrollView>

                {props.onConfirm && deck ? (
                    <View
                        style={[
                            styles.footer,
                            { paddingBottom: Math.max(insets.bottom, spacing.md) }
                        ]}
                    >
                        <Button
                            title={props.confirmLabel ?? 'Choose this deck'}
                            onPress={() => props.onConfirm?.(deck)}
                        />
                    </View>
                ) : null}

                {/* An overlay rather than a Modal: this screen is itself
                    presented from the deck picker's modal, and a third stacked
                    presentation is where iOS starts dropping animations. */}
                {zoomCard ? (
                    <View style={StyleSheet.absoluteFill}>
                        <CardZoomOverlay
                            card={zoomCard}
                            onClose={() => setZoomCard(undefined)}
                        />
                    </View>
                ) : null}
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.md,
        paddingHorizontal: spacing.lg,
        paddingBottom: spacing.sm
    },
    title: {
        color: colors.text,
        fontSize: 19,
        fontWeight: '800'
    },
    metaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginTop: 6
    },
    sas: {
        color: colors.brand,
        fontSize: 12,
        fontWeight: '800'
    },
    set: {
        color: colors.textFaint,
        fontSize: 11,
        fontWeight: '700'
    },
    loading: {
        color: colors.textFaint,
        fontSize: 13,
        paddingVertical: spacing.md
    },
    footer: {
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.bgElevated
    }
});
