import React from 'react';
import { Image } from 'expo-image';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, spacing } from '../theme';
import { CARD_ASPECT, CARDBACK, cardImageUrl } from './cardImages';
import { prophecyAction, prophecyPairs, prophecyStatus, shownProphecy } from './prophecies';
import type { CardMenuItem, CardSummary } from './types';

/**
 * ARCHON: prophecies, which the app previously did not draw at all.
 *
 * Two pieces: a slim always-visible strip under each player's stats, so they
 * can be found, and a detail sheet with the card at a readable size and the
 * moves that are legal on it, so they can be used.
 *
 * Tapping a prophecy opens the sheet rather than activating it outright.
 * Activation is once per phase and irreversible, and a 46px thumbnail is not
 * something anyone should be asked to commit to — the exception is a prophecy
 * the game has marked selectable, where a tap is answering a prompt and has to
 * land immediately, exactly as on the web.
 */

const STRIP_CARD_WIDTH = 46;

function ProphecyThumb(props: {
    card: CardSummary;
    isMine: boolean;
    width: number;
    onPress: (card: CardSummary) => void;
    onLongPress?: (card: CardSummary) => void;
}) {
    const { card } = props;
    const status = prophecyStatus(card, { isMine: props.isMine });
    const url = card.facedown ? undefined : cardImageUrl(card);
    const height = Math.round(props.width * CARD_ASPECT);
    const children = (card.childCards ?? []).length;

    return (
        <Pressable
            onPress={() => props.onPress(card)}
            onLongPress={props.onLongPress ? () => props.onLongPress?.(card) : undefined}
            delayLongPress={400}
            style={({ pressed }) => [pressed && { opacity: 0.75 }]}
            accessibilityRole='button'
            accessibilityLabel={`${card.name ?? 'Prophecy'}${
                status === 'active' ? ', active' : status === 'ready' ? ', ready to activate' : ''
            }`}
        >
            <View
                style={[
                    styles.thumbFrame,
                    { width: props.width, height },
                    card.selectable && styles.thumbSelectable,
                    status === 'active' && styles.thumbActive,
                    status === 'ready' && styles.thumbReady,
                    status === 'idle' && !card.selectable && styles.thumbIdle
                ]}
            >
                <Image
                    source={url ? { uri: url } : CARDBACK}
                    style={styles.thumbImage}
                    contentFit='cover'
                    cachePolicy='disk'
                />
                {children > 0 ? (
                    <View style={styles.childBadge}>
                        <Text style={styles.childBadgeText}>+{children}</Text>
                    </View>
                ) : null}
            </View>
        </Pressable>
    );
}

/**
 * One player's prophecies, as a row under their stats. Renders nothing at all
 * for a deck without prophecies, which is every set but Prophetic Visions.
 */
export function ProphecyStrip(props: {
    cards?: CardSummary[];
    isMine: boolean;
    onSelect: (card: CardSummary) => void;
    onOpen: (card: CardSummary) => void;
    onZoom?: (card: CardSummary) => void;
    manualMode?: boolean;
}) {
    const pairs = prophecyPairs(props.cards);
    if (pairs.length === 0) {
        return null;
    }

    // Only the side that is face up on the table is worth a slot in the strip;
    // the flip side is reachable from the detail sheet.
    const shown = pairs
        .map((pair) => shownProphecy(pair))
        .filter((card): card is CardSummary => !!card);

    const readyCount = props.isMine
        ? shown.filter((card) => prophecyStatus(card, { isMine: true }) === 'ready').length
        : 0;

    const press = (card: CardSummary) => {
        // A selectable prophecy is the answer to a prompt: send it straight
        // through, the way tapping any other selectable card does.
        if (prophecyAction(card, { isMine: props.isMine, manualMode: props.manualMode }) === 'select') {
            props.onSelect(card);
            return;
        }
        props.onOpen(card);
    };

    return (
        <View style={styles.strip}>
            <View style={styles.stripLabelBlock}>
                <Text style={styles.stripLabel}>Prophecies</Text>
                {readyCount > 0 ? (
                    <View style={styles.readyPip}>
                        <Text style={styles.readyPipText}>{readyCount}</Text>
                    </View>
                ) : null}
            </View>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.stripRow}
                style={{ flexGrow: 0 }}
            >
                {shown.map((card) => (
                    <ProphecyThumb
                        key={card.uuid}
                        card={card}
                        isMine={props.isMine}
                        width={STRIP_CARD_WIDTH}
                        onPress={press}
                        onLongPress={props.onZoom}
                    />
                ))}
            </ScrollView>
        </View>
    );
}

/**
 * The tapped prophecy at a readable size, with both sides of the pair and
 * whatever the engine says can be done with it.
 */
export function ProphecySheet(props: {
    /** The prophecy that was tapped. */
    card?: CardSummary;
    /** The owning player's full prophecy list, so the flip side can be shown. */
    cards?: CardSummary[];
    isMine: boolean;
    manualMode?: boolean;
    onClose: () => void;
    /** Activate it — sends `clickProphecy`. */
    onActivate: (card: CardSummary) => void;
    /** Manual-mode menu item. */
    onMenuItem: (card: CardSummary, item: CardMenuItem) => void;
    onZoom: (card: CardSummary) => void;
}) {
    const { card } = props;
    const insets = useSafeAreaInsets();
    const { width, height } = useWindowDimensions();

    if (!card) {
        return null;
    }

    const pair =
        prophecyPairs(props.cards).find((entry) =>
            entry.some((side) => side.uuid === card.uuid)
        ) ?? [card];

    const action = prophecyAction(card, { isMine: props.isMine, manualMode: props.manualMode });
    const menu = (card.menu ?? []).filter((item) => item.command !== 'click');
    const cardWidth = Math.min(Math.round((width - spacing.lg * 3) / 2), 150);

    const statusLine = card.activeProphecy
        ? 'Active — it resolves when its condition is met.'
        : props.isMine
        ? card.canActivateProphecy
            ? 'Ready to activate.'
            : // canActivateProphecy folds every restriction into one boolean
              // (server/game/player.js), so say what they all are rather than
              // guessing which one bit.
              'Not right now — one prophecy per phase, on your turn, with a card in hand, and not while its other side is active.'
        : 'Your opponent’s prophecy.';

    return (
        <View style={styles.overlay}>
            <Pressable style={styles.backdrop} onPress={props.onClose} />
            <View
                style={[
                    styles.sheet,
                    {
                        maxHeight: Math.round(height * 0.85),
                        paddingBottom: Math.max(insets.bottom, spacing.md)
                    }
                ]}
            >
                <View style={styles.sheetHeader}>
                    <Text style={styles.sheetTitle} numberOfLines={1}>
                        {card.name ?? 'Prophecy'}
                    </Text>
                    <Pressable onPress={props.onClose} hitSlop={16}>
                        <Text style={styles.closeText}>Close</Text>
                    </Pressable>
                </View>

                <ScrollView contentContainerStyle={{ paddingBottom: spacing.md }}>
                    <View style={styles.pairRow}>
                        {pair.map((side) => {
                            const url = side.facedown ? undefined : cardImageUrl(side);
                            return (
                                <Pressable
                                    key={side.uuid}
                                    onPress={() => props.onZoom(side)}
                                    style={({ pressed }) => [pressed && { opacity: 0.8 }]}
                                >
                                    <Image
                                        source={url ? { uri: url } : CARDBACK}
                                        style={[
                                            styles.pairImage,
                                            {
                                                width: cardWidth,
                                                height: Math.round(cardWidth * CARD_ASPECT)
                                            },
                                            side.activeProphecy && styles.pairImageActive,
                                            side.uuid !== card.uuid && { opacity: 0.55 }
                                        ]}
                                        contentFit='cover'
                                        cachePolicy='disk'
                                    />
                                    <Text style={styles.pairCaption} numberOfLines={1}>
                                        {side.activeProphecy ? '● active' : side.name ?? ''}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>

                    <Text style={styles.statusLine}>{statusLine}</Text>
                    {(card.childCards ?? []).length > 0 ? (
                        <Text style={styles.statusLine}>
                            {(card.childCards ?? []).length} card
                            {(card.childCards ?? []).length === 1 ? '' : 's'} under it.
                        </Text>
                    ) : null}
                    <Text style={styles.zoomHint}>Tap a card to see it full size.</Text>

                    {action === 'activate' ? (
                        <Pressable
                            onPress={() => props.onActivate(card)}
                            style={({ pressed }) => [styles.primaryButton, pressed && { opacity: 0.8 }]}
                        >
                            <Text style={styles.primaryButtonText}>Activate prophecy</Text>
                        </Pressable>
                    ) : null}

                    {action === 'menu'
                        ? menu.map((item, index) => (
                              <Pressable
                                  key={index}
                                  onPress={() => props.onMenuItem(card, item)}
                                  style={({ pressed }) => [
                                      styles.menuButton,
                                      pressed && { opacity: 0.7 }
                                  ]}
                              >
                                  <Text style={styles.menuButtonText}>
                                      {String(item.text ?? 'Option')}
                                  </Text>
                              </Pressable>
                          ))
                        : null}
                </ScrollView>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    strip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        paddingVertical: 4,
        backgroundColor: colors.bgElevated,
        borderBottomColor: colors.border,
        borderBottomWidth: StyleSheet.hairlineWidth
    },
    stripLabelBlock: {
        alignItems: 'center',
        gap: 2,
        width: 54
    },
    stripLabel: {
        color: colors.textFaint,
        fontSize: 9,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.3
    },
    readyPip: {
        backgroundColor: colors.brand,
        borderRadius: radius.pill,
        minWidth: 15,
        paddingHorizontal: 4,
        alignItems: 'center'
    },
    readyPipText: {
        color: '#161006',
        fontSize: 9,
        fontWeight: '900'
    },
    stripRow: {
        flexDirection: 'row',
        gap: 5,
        alignItems: 'center',
        paddingRight: spacing.sm
    },
    thumbFrame: {
        borderRadius: 4,
        overflow: 'hidden',
        backgroundColor: colors.surface,
        borderWidth: 1
    },
    thumbImage: {
        width: '100%',
        height: '100%'
    },
    thumbIdle: {
        borderColor: 'rgba(0,0,0,0.4)',
        opacity: 0.6
    },
    thumbReady: {
        borderColor: colors.brand,
        borderWidth: 2
    },
    thumbActive: {
        borderColor: colors.success,
        borderWidth: 2
    },
    thumbSelectable: {
        borderColor: colors.selectable,
        borderWidth: 2
    },
    childBadge: {
        position: 'absolute',
        bottom: 1,
        left: 1,
        backgroundColor: 'rgba(20, 26, 40, 0.85)',
        borderRadius: 6,
        paddingHorizontal: 3,
        borderWidth: 1,
        borderColor: colors.borderLight
    },
    childBadgeText: {
        color: colors.text,
        fontSize: 8,
        fontWeight: '700'
    },
    // See the note on GameModals' `overlay`: both z-index and elevation, so a
    // sibling overlay cannot be punched through on Android.
    overlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 20,
        elevation: 20
    },
    backdrop: {
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
    sheetHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md,
        marginBottom: spacing.sm
    },
    sheetTitle: {
        color: colors.text,
        fontSize: 16,
        fontWeight: '800',
        flexShrink: 1
    },
    closeText: {
        color: colors.accent,
        fontWeight: '700',
        fontSize: 15
    },
    pairRow: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: spacing.lg
    },
    pairImage: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.border
    },
    pairImageActive: {
        borderColor: colors.success,
        borderWidth: 2
    },
    pairCaption: {
        color: colors.textFaint,
        fontSize: 10,
        textAlign: 'center',
        marginTop: 3,
        maxWidth: 150
    },
    statusLine: {
        color: colors.textDim,
        fontSize: 13,
        lineHeight: 18,
        textAlign: 'center',
        marginTop: spacing.md
    },
    zoomHint: {
        color: colors.textFaint,
        fontSize: 11,
        textAlign: 'center',
        marginTop: 4
    },
    primaryButton: {
        backgroundColor: colors.brand,
        borderRadius: radius.md,
        minHeight: 46,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: spacing.lg
    },
    primaryButtonText: {
        color: '#161006',
        fontWeight: '800',
        fontSize: 15
    },
    menuButton: {
        backgroundColor: colors.surfaceHover,
        borderColor: colors.borderLight,
        borderWidth: 1,
        borderRadius: radius.md,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: spacing.sm
    },
    menuButtonText: {
        color: colors.text,
        fontWeight: '700',
        fontSize: 14
    }
});
