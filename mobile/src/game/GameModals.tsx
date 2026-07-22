import React from 'react';
import { Image } from 'expo-image';
import {
    Dimensions,
    FlatList,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    View
} from 'react-native';
import { colors, radius, spacing } from '../theme';
import CardTile from './CardTile';
import { CARD_ASPECT, CARDBACK, cardImageUrl } from './cardImages';
import type { CardMenuItem, CardSummary } from './types';

/** Fullscreen zoomed card preview (long-press). */
export function CardZoomModal(props: { card?: CardSummary; onClose: () => void }) {
    const { card } = props;
    const screen = Dimensions.get('window');
    const width = Math.min(screen.width - 64, 340);
    const height = Math.round(width * CARD_ASPECT);
    const url = card && !card.facedown ? cardImageUrl(card) : undefined;

    return (
        <Modal visible={!!card} transparent animationType='fade' onRequestClose={props.onClose}>
            <Pressable style={styles.zoomBackdrop} onPress={props.onClose}>
                {card ? (
                    <View>
                        <Image
                            source={url ? { uri: url } : CARDBACK}
                            style={{ width, height, borderRadius: 14 }}
                            contentFit='cover'
                            transition={100}
                        />
                        {(card.upgrades?.length ?? 0) > 0 ? (
                            <View style={styles.zoomAttachRow}>
                                {card.upgrades!.map((upgrade) => (
                                    <Image
                                        key={upgrade.uuid}
                                        source={
                                            upgrade.facedown
                                                ? CARDBACK
                                                : { uri: cardImageUrl(upgrade) }
                                        }
                                        style={styles.zoomAttachImage}
                                        contentFit='cover'
                                    />
                                ))}
                            </View>
                        ) : null}
                        <Text style={styles.zoomHint}>Tap anywhere to close</Text>
                    </View>
                ) : null}
            </Pressable>
        </Modal>
    );
}

/** Bottom sheet listing a card's server-provided menu options. */
export function CardMenuModal(props: {
    card?: CardSummary;
    onClose: () => void;
    onItem: (card: CardSummary, item: CardMenuItem) => void;
    onZoom: (card: CardSummary) => void;
}) {
    const { card } = props;
    const menu = (card?.menu ?? []).filter((item) => item.command !== 'click');

    return (
        <Modal visible={!!card} transparent animationType='slide' onRequestClose={props.onClose}>
            <Pressable style={styles.sheetBackdrop} onPress={props.onClose}>
                <Pressable style={styles.sheet} onPress={() => {}}>
                    <Text style={styles.sheetTitle} numberOfLines={1}>
                        {card?.name ?? 'Card'}
                    </Text>
                    {menu.map((item, index) => (
                        <Pressable
                            key={index}
                            style={({ pressed }) => [styles.sheetItem, pressed && { opacity: 0.6 }]}
                            onPress={() => card && props.onItem(card, item)}
                        >
                            <Text style={styles.sheetItemText}>{item.text ?? 'Option'}</Text>
                        </Pressable>
                    ))}
                    <Pressable
                        style={({ pressed }) => [styles.sheetItem, pressed && { opacity: 0.6 }]}
                        onPress={() => card && props.onZoom(card)}
                    >
                        <Text style={styles.sheetItemText}>View card</Text>
                    </Pressable>
                    <Pressable
                        style={({ pressed }) => [
                            styles.sheetItem,
                            styles.sheetCancel,
                            pressed && { opacity: 0.6 }
                        ]}
                        onPress={props.onClose}
                    >
                        <Text style={[styles.sheetItemText, { color: colors.textDim }]}>Cancel</Text>
                    </Pressable>
                </Pressable>
            </Pressable>
        </Modal>
    );
}

/** Grid viewer for a card pile (discard, archives, purged...). */
export function PileModal(props: {
    title?: string;
    cards?: CardSummary[];
    visible: boolean;
    onClose: () => void;
    onCardPress?: (card: CardSummary) => void;
    onCardLongPress?: (card: CardSummary) => void;
}) {
    const screen = Dimensions.get('window');
    const cardWidth = Math.floor((screen.width - spacing.md * 2 - 8 * 3) / 4);

    return (
        <Modal
            visible={props.visible}
            transparent
            animationType='slide'
            onRequestClose={props.onClose}
        >
            <View style={styles.sheetBackdrop}>
                <View style={[styles.sheet, { maxHeight: '75%' }]}>
                    <View style={styles.pileHeader}>
                        <Text style={styles.sheetTitle}>{props.title ?? 'Cards'}</Text>
                        <Pressable onPress={props.onClose} hitSlop={12}>
                            <Text style={styles.closeText}>Close</Text>
                        </Pressable>
                    </View>
                    <FlatList
                        data={props.cards ?? []}
                        keyExtractor={(card, index) => card.uuid ?? String(index)}
                        numColumns={4}
                        columnWrapperStyle={{ gap: 8 }}
                        contentContainerStyle={{ gap: 8, paddingBottom: 24 }}
                        renderItem={({ item }) => (
                            <CardTile
                                card={item}
                                width={cardWidth}
                                onPress={(card) =>
                                    props.onCardPress
                                        ? props.onCardPress(card)
                                        : props.onCardLongPress?.(card)
                                }
                                onLongPress={props.onCardLongPress}
                            />
                        )}
                        ListEmptyComponent={
                            <Text style={styles.emptyPile}>Nothing here yet</Text>
                        }
                    />
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    zoomBackdrop: {
        flex: 1,
        backgroundColor: colors.overlay,
        alignItems: 'center',
        justifyContent: 'center'
    },
    zoomHint: {
        color: colors.textDim,
        textAlign: 'center',
        marginTop: spacing.md,
        fontSize: 12
    },
    zoomAttachRow: {
        flexDirection: 'row',
        gap: 6,
        marginTop: spacing.sm,
        justifyContent: 'center'
    },
    zoomAttachImage: {
        width: 70,
        height: Math.round(70 * CARD_ASPECT),
        borderRadius: 6
    },
    sheetBackdrop: {
        flex: 1,
        backgroundColor: colors.overlay,
        justifyContent: 'flex-end'
    },
    sheet: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: radius.lg,
        borderTopRightRadius: radius.lg,
        borderColor: colors.border,
        borderWidth: 1,
        padding: spacing.lg,
        paddingBottom: 34
    },
    sheetTitle: {
        color: colors.text,
        fontSize: 16,
        fontWeight: '800',
        marginBottom: spacing.sm
    },
    sheetItem: {
        paddingVertical: 13,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.border
    },
    sheetItemText: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '600',
        textAlign: 'center'
    },
    sheetCancel: {
        marginTop: 4
    },
    pileHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: spacing.sm
    },
    closeText: {
        color: colors.accent,
        fontWeight: '700',
        fontSize: 14
    },
    emptyPile: {
        color: colors.textFaint,
        textAlign: 'center',
        paddingVertical: 24
    }
});
