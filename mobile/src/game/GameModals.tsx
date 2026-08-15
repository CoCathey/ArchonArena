import React, { useEffect, useMemo, useState } from 'react';
import { Image } from 'expo-image';
import {
    Dimensions,
    FlatList,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    View,
    useWindowDimensions
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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

/**
 * Fullscreen zoomed card preview (long-press), as a Modal.
 *
 * Only for screens that present nothing else at the same moment — the deck
 * browser. The game board deliberately uses CardZoomOverlay instead; see the
 * note on PileViewer.
 */
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

/**
 * Bottom sheet listing a card's server-provided menu options.
 *
 * A plain in-tree overlay rather than a native Modal — see PileViewer for why
 * the board no longer presents any of these natively.
 */
export function CardMenuSheet(props: {
    card?: CardSummary;
    onClose: () => void;
    onItem: (card: CardSummary, item: CardMenuItem) => void;
    /** Hand the card to the screen's zoom rather than opening one in here. */
    onZoom?: (card: CardSummary) => void;
}) {
    const { card } = props;
    const insets = useSafeAreaInsets();

    if (!card) {
        return null;
    }

    const menu = (card.menu ?? []).filter((item) => item.command !== 'click');

    return (
        <View style={styles.overlay}>
            <Pressable style={styles.sheetBackdrop} onPress={props.onClose} />
            <View
                style={[
                    styles.sheet,
                    { paddingBottom: Math.max(insets.bottom, spacing.lg) + spacing.md }
                ]}
            >
                <Text style={styles.sheetTitle} numberOfLines={1}>
                    {card.name ?? 'Card'}
                </Text>
                {menu.map((item, index) => (
                    <Pressable
                        key={index}
                        style={({ pressed }) => [styles.sheetItem, pressed && { opacity: 0.6 }]}
                        onPress={() => props.onItem(card, item)}
                    >
                        <Text style={styles.sheetItemText}>{String(item.text ?? 'Option')}</Text>
                    </Pressable>
                ))}
                <Pressable
                    style={({ pressed }) => [styles.sheetItem, pressed && { opacity: 0.6 }]}
                    onPress={() => props.onZoom?.(card)}
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
            </View>
        </View>
    );
}

/** Rows of four, so a 36-card discard reads as a grid rather than a list. */
const PILE_COLUMNS = 4;
const PILE_GAP = 8;

/**
 * Grid viewer for a card pile (discard, archives, purged...).
 *
 * ARCHON: this is a plain full-screen overlay, NOT a native Modal.
 *
 * Opening an opponent's discard pile could lock the app up. The cause is the
 * one already documented on DeckPreview: presenting native modals over each
 * other on iOS and then unwinding them leaves an orphaned presentation that
 * swallows every touch, and the board is exactly where that is easiest to
 * provoke — the pile sheet stacked a card zoom inside its own presentation
 * while a second modal (the card menu) and a third (the log sheet) sat mounted
 * alongside it. Tapping a card, then closing the pile, then reaching for the
 * log is an ordinary thing to do and it left nothing on screen responding.
 *
 * The fix is to stop presenting natively at all: the board draws its pile
 * viewer, card menu and card zoom as ordinary sibling views inside its own
 * tree, which cannot orphan a presentation because there is none. It also
 * means the zoom can live on the screen rather than being duplicated in here.
 *
 * The list is windowed on purpose too. A late-game discard runs to 30-odd
 * cards, and FlatList's default is to render ten *rows* up front — forty
 * remote card images decoded in one frame, which on a phone is a visible hang
 * of its own even when nothing is stuck.
 */
export function PileViewer(props: {
    title?: string;
    cards?: CardSummary[];
    onClose: () => void;
    /** Called for a card the player can act on. */
    onCardSelect?: (card: CardSummary) => void;
    /** Called to look at a card; the screen owns the zoom. */
    onCardZoom: (card: CardSummary) => void;
}) {
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();

    const columnWidth = Math.floor(
        (width - spacing.lg * 2 - PILE_GAP * (PILE_COLUMNS - 1)) / PILE_COLUMNS
    );
    const rowHeight = Math.round(columnWidth * CARD_ASPECT) + PILE_GAP;

    // Piles arrive straight off the wire; a hole in the array would otherwise
    // take the whole board down with it on the first render.
    const cards = useMemo(
        () => (props.cards ?? []).filter((card): card is CardSummary => !!card),
        [props.cards]
    );

    const press = (card: CardSummary) => {
        if (card.selectable && props.onCardSelect) {
            props.onCardSelect(card);
            return;
        }
        props.onCardZoom(card);
    };

    return (
        <View style={styles.overlay}>
            <Pressable style={styles.sheetBackdrop} onPress={props.onClose} />
            <View
                style={[
                    styles.sheet,
                    {
                        maxHeight: Math.round(height * 0.75),
                        paddingBottom: Math.max(insets.bottom, spacing.md)
                    }
                ]}
            >
                <View style={styles.pileHeader}>
                    <Text style={styles.sheetTitle} numberOfLines={1}>
                        {props.title ?? 'Cards'}
                        <Text style={styles.pileCount}>{`  ${cards.length}`}</Text>
                    </Text>
                    <Pressable onPress={props.onClose} hitSlop={16}>
                        <Text style={styles.closeText}>Close</Text>
                    </Pressable>
                </View>
                <FlatList
                    data={cards}
                    keyExtractor={(card, index) => card.uuid ?? `card-${index}`}
                    numColumns={PILE_COLUMNS}
                    columnWrapperStyle={styles.pileRow}
                    contentContainerStyle={styles.pileContent}
                    initialNumToRender={3}
                    maxToRenderPerBatch={4}
                    windowSize={5}
                    removeClippedSubviews
                    getItemLayout={(_, index) => ({
                        length: rowHeight,
                        offset: rowHeight * index,
                        index
                    })}
                    renderItem={({ item }) => (
                        <CardTile
                            card={item}
                            width={columnWidth}
                            onPress={press}
                            onLongPress={props.onCardZoom}
                        />
                    )}
                    ListEmptyComponent={<Text style={styles.emptyPile}>Nothing here yet</Text>}
                />
            </View>
        </View>
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
    // Sibling overlays are drawn in source order on iOS, but on Android any
    // elevated view further up the tree (a card's glow, the drag ghost) can
    // punch through one. Both are set so the ordering holds either way.
    overlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 20,
        elevation: 20
    },
    // The backdrop is its own view behind the sheet rather than a Pressable
    // wrapped around it: a Pressable that contains a scrollable competes with
    // it for the touch, which makes dragging the grid feel dead and can close
    // the sheet out from under a scroll.
    sheetBackdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: colors.overlay
    },
    sheet: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: colors.surface,
        borderTopLeftRadius: radius.lg,
        borderTopRightRadius: radius.lg,
        borderColor: colors.border,
        borderWidth: 1,
        padding: spacing.lg
    },
    sheetTitle: {
        color: colors.text,
        fontSize: 16,
        fontWeight: '800',
        marginBottom: spacing.sm,
        flexShrink: 1,
        textTransform: 'capitalize'
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
        gap: spacing.md,
        marginBottom: spacing.sm
    },
    pileCount: {
        color: colors.textFaint,
        fontSize: 13,
        fontWeight: '700'
    },
    pileRow: {
        gap: PILE_GAP
    },
    pileContent: {
        gap: PILE_GAP,
        paddingBottom: spacing.lg
    },
    closeText: {
        color: colors.accent,
        fontWeight: '700',
        fontSize: 15
    },
    emptyPile: {
        color: colors.textFaint,
        textAlign: 'center',
        paddingVertical: 24
    }
});
