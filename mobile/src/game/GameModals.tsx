import React, { useEffect, useState } from 'react';
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

/**
 * The zoomed card itself, on a tap-to-dismiss backdrop, without a Modal of its
 * own. Screens that are already inside a Modal use this directly rather than
 * stacking a third presentation on top — see DeckPreviewModal.
 */
export function CardZoomOverlay(props: { card?: CardSummary; onClose: () => void }) {
    const { card } = props;
    const screen = Dimensions.get('window');
    const width = Math.min(screen.width - 64, 340);
    const height = Math.round(width * CARD_ASPECT);

    // A token creature is a real deck card with a token laid over it. The web
    // client zooms straight to the card underneath — that is the card whose
    // text and stats actually matter — so start there and let the token be
    // flipped back to.
    const underneath = card?.versusCard;
    const [showToken, setShowToken] = useState(false);
    useEffect(() => setShowToken(false), [card?.uuid]);

    if (!card) {
        return null;
    }

    const shown = underneath && !showToken ? underneath : card;
    const url = shown.facedown ? undefined : cardImageUrl(shown);

    return (
        <Pressable style={styles.zoomBackdrop} onPress={props.onClose}>
            <View style={{ alignItems: 'center' }}>
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
                                    upgrade.facedown ? CARDBACK : { uri: cardImageUrl(upgrade) }
                                }
                                style={styles.zoomAttachImage}
                                contentFit='cover'
                            />
                        ))}
                    </View>
                ) : null}
                {underneath ? (
                    <Pressable
                        onPress={() => setShowToken((token) => !token)}
                        style={({ pressed }) => [styles.flipButton, pressed && { opacity: 0.7 }]}
                        hitSlop={8}
                    >
                        <Text style={styles.flipButtonText}>
                            {showToken
                                ? `Show card underneath${
                                      underneath.name ? ` · ${underneath.name}` : ''
                                  }`
                                : `Show token${card.name ? ` · ${card.name}` : ''}`}
                        </Text>
                    </Pressable>
                ) : null}
                <Text style={styles.zoomHint}>Tap anywhere to close</Text>
            </View>
        </Pressable>
    );
}

/** Fullscreen zoomed card preview (long-press). */
export function CardZoomModal(props: { card?: CardSummary; onClose: () => void }) {
    return (
        <Modal
            visible={!!props.card}
            transparent
            animationType='fade'
            onRequestClose={props.onClose}
        >
            <CardZoomOverlay card={props.card} onClose={props.onClose} />
        </Modal>
    );
}

/** Bottom sheet listing a card's server-provided menu options. */
export function CardMenuModal(props: {
    card?: CardSummary;
    onClose: () => void;
    onItem: (card: CardSummary, item: CardMenuItem) => void;
}) {
    const { card } = props;
    const menu = (card?.menu ?? []).filter((item) => item.command !== 'click');
    // Zoom lives inside this modal rather than opening another one on top of
    // it — see the note on PileModal.
    const [zoom, setZoom] = useState(false);
    useEffect(() => setZoom(false), [card?.uuid]);

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
                        onPress={() => setZoom(true)}
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
            {zoom && card ? (
                <View style={StyleSheet.absoluteFill}>
                    <CardZoomOverlay card={card} onClose={() => setZoom(false)} />
                </View>
            ) : null}
        </Modal>
    );
}

/**
 * Grid viewer for a card pile (discard, archives, purged...).
 *
 * Zooming a card here renders *inside* this modal instead of opening a second
 * one over it. Stacking two native modals and then dismissing the lower one
 * leaves iOS with an orphaned presentation that swallows every touch — the app
 * looks frozen. Opening a discard pile, long-pressing a card and closing the
 * pile did exactly that.
 */
export function PileModal(props: {
    title?: string;
    cards?: CardSummary[];
    visible: boolean;
    onClose: () => void;
    /** Called for a card the player can act on; zooming is handled here. */
    onCardSelect?: (card: CardSummary) => void;
}) {
    const screen = Dimensions.get('window');
    const cardWidth = Math.floor((screen.width - spacing.md * 2 - 8 * 3) / 4);
    const [zoomCard, setZoomCard] = useState<CardSummary | undefined>();

    // Never leave a zoom hanging over a pile that has since closed.
    useEffect(() => {
        if (!props.visible) {
            setZoomCard(undefined);
        }
    }, [props.visible]);

    const press = (card: CardSummary) => {
        if (card.selectable && props.onCardSelect) {
            props.onCardSelect(card);
            return;
        }
        setZoomCard(card);
    };

    return (
        <Modal
            visible={props.visible}
            transparent
            animationType='slide'
            onRequestClose={props.onClose}
        >
            <Pressable style={styles.sheetBackdrop} onPress={props.onClose}>
                <Pressable style={[styles.sheet, { maxHeight: '75%' }]} onPress={() => {}}>
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
                                onPress={press}
                                onLongPress={setZoomCard}
                            />
                        )}
                        ListEmptyComponent={
                            <Text style={styles.emptyPile}>Nothing here yet</Text>
                        }
                    />
                </Pressable>
            </Pressable>
            {zoomCard ? (
                <View style={StyleSheet.absoluteFill}>
                    <CardZoomOverlay
                        card={zoomCard}
                        onClose={() => setZoomCard(undefined)}
                    />
                </View>
            ) : null}
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
    flipButton: {
        marginTop: spacing.md,
        backgroundColor: colors.surface,
        borderColor: colors.borderLight,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: 16,
        paddingVertical: 9
    },
    flipButtonText: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '700'
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
