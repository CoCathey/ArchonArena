import React, { useRef } from 'react';
import { Image } from 'expo-image';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { CARD_ASPECT, CARDBACK, cardImageUrl } from './cardImages';
import { STATUS_TOKEN_ICONS, enhancementPip } from './cardIcons';
import { canDragCard, useDragDrop, type DropZoneName } from './DragDrop';
import { cardAccessibilityLabel } from './cardLabel';
import type { CardSummary } from './types';

function TokenPip(props: { value: number; color: string; label?: string; upright?: boolean }) {
    return (
        <View
            style={[
                styles.tokenPip,
                { backgroundColor: props.color },
                props.upright && styles.counterRotated
            ]}
        >
            <Text style={styles.tokenPipText}>
                {props.label ? `${props.label}${props.value}` : props.value}
            </Text>
        </View>
    );
}

// A status token (enrage/stun/ward) shown as its real icon, with a count only
// when it is stacked more than once.
function StatusIcon(props: { source: number; size: number; count?: number; upright?: boolean }) {
    return (
        <View style={[styles.statusIcon, props.upright && styles.counterRotated]}>
            <Image
                source={props.source}
                style={{ width: props.size, height: props.size }}
                contentFit='contain'
            />
            {props.count && props.count > 1 ? (
                <Text style={styles.statusCount}>{props.count}</Text>
            ) : null}
        </View>
    );
}

export default function CardTile(props: {
    card: CardSummary;
    width: number;
    onPress?: (card: CardSummary) => void;
    onLongPress?: (card: CardSummary) => void;
    disabled?: boolean;
    /** Zone this card sits in; enables drag-and-drop when inside a DragDropProvider. */
    dragSource?: DropZoneName;
}) {
    const { card, width } = props;
    const height = Math.round(width * CARD_ASPECT);
    const damage = (card.tokens?.damage ?? 0) + (card.pseudoDamage ?? 0);
    const amber = card.tokens?.amber ?? 0;
    const power = card.tokens?.power ?? 0;
    const ward = card.tokens?.ward ?? 0;
    const enrage = card.tokens?.enrage ?? 0;
    const stun = card.stunned || (card.tokens?.stun ?? 0) > 0;
    const statusSize = Math.max(14, Math.round(width * 0.26));
    const exhausted = !!card.exhausted;

    // Enhancement "bonus" pips — composited by the web canvas, absent from the
    // raw card art, so we overlay them here (top-left, as on the physical card).
    const enhancements = (card.enhancements ?? [])
        .filter((pip): pip is string => typeof pip === 'string' && pip !== '')
        .map((pip) => ({ name: pip, source: enhancementPip(pip) }))
        .filter((pip) => pip.source !== undefined);
    const pipSize = Math.max(12, Math.round(width * 0.24));

    const faceUrl = card.facedown ? undefined : cardImageUrl(card);

    const borderStyle = card.selected
        ? { borderColor: colors.selected, borderWidth: 2 }
        : card.selectable
        ? { borderColor: colors.selectable, borderWidth: 2 }
        : card.canPlay
        ? { borderColor: colors.brand, borderWidth: 2 }
        : { borderColor: 'rgba(0,0,0,0.4)', borderWidth: 1 };

    const upgradeCount = card.upgrades?.length ?? 0;
    const childCount = card.childCards?.length ?? 0;

    // ---- drag-and-drop ----
    const dragContext = useDragDrop();
    const draggable =
        !!dragContext?.enabled &&
        !!props.dragSource &&
        !props.disabled &&
        canDragCard(card, props.dragSource, dragContext.manualMode);
    // The responder callbacks are created once; feed them the latest values
    // through refs so re-renders (state patches arrive constantly) don't
    // recreate the responder mid-gesture.
    const latest = useRef({ card, dragSource: props.dragSource, draggable, dragContext });
    latest.current = { card, dragSource: props.dragSource, draggable, dragContext };

    const panResponder = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => false,
            // Claim mostly-vertical pans only, so the horizontal card strips
            // still scroll and plain taps still press.
            onMoveShouldSetPanResponder: (_evt, gesture) =>
                latest.current.draggable &&
                Math.abs(gesture.dy) > 10 &&
                Math.abs(gesture.dy) > Math.abs(gesture.dx),
            onPanResponderGrant: (evt) => {
                const { card: c, dragSource, dragContext: context } = latest.current;
                if (context && dragSource) {
                    context.beginDrag(
                        c,
                        dragSource,
                        evt.nativeEvent.pageX,
                        evt.nativeEvent.pageY
                    );
                }
            },
            onPanResponderMove: (evt) => {
                latest.current.dragContext?.moveDrag(
                    evt.nativeEvent.pageX,
                    evt.nativeEvent.pageY
                );
            },
            onPanResponderRelease: (evt) => {
                latest.current.dragContext?.endDrag(
                    evt.nativeEvent.pageX,
                    evt.nativeEvent.pageY
                );
            },
            onPanResponderTerminate: () => {
                latest.current.dragContext?.cancelDrag();
            },
            // Once we own the gesture, don't hand it back to scroll views.
            onPanResponderTerminationRequest: () => false,
            onShouldBlockNativeResponder: () => true
        })
    ).current;

    return (
        <View
            style={[styles.container, { width, height }]}
            {...(draggable ? panResponder.panHandlers : {})}
        >
            <Pressable
                onPress={() => props.onPress?.(card)}
                onLongPress={() => props.onLongPress?.(card)}
                delayLongPress={450}
                disabled={props.disabled}
                accessibilityRole='button'
                accessibilityLabel={cardAccessibilityLabel(card)}
                accessibilityState={{ disabled: !!props.disabled, selected: !!card.selected }}
                style={({ pressed }) => [
                    { width, height },
                    pressed && { opacity: 0.8 }
                ]}
            >
                {/* Everything that sits "on the card" — face, bonus pips,
                    tokens — lives in this wrapper so the exhaust rotation
                    scales and moves them together with the card. The pips
                    themselves counter-rotate to stay readable. */}
                <View
                    style={[
                        styles.transformWrapper,
                        { width, height },
                        exhausted && styles.exhausted,
                        card.new && styles.newCard
                    ]}
                >
                    <View
                        style={[
                            styles.cardFrame,
                            { width, height },
                            borderStyle,
                            card.unselectable && { opacity: 0.45 }
                        ]}
                    >
                        {faceUrl ? (
                            <Image
                                source={{ uri: faceUrl }}
                                style={styles.image}
                                contentFit='cover'
                                transition={80}
                                cachePolicy='disk'
                            />
                        ) : (
                            <Image source={CARDBACK} style={styles.image} contentFit='cover' />
                        )}

                        {stun ? <View style={styles.stunTint} pointerEvents='none' /> : null}
                    </View>

                    {enhancements.length > 0 ? (
                        <View style={styles.enhancementColumn} pointerEvents='none'>
                            {enhancements.map((pip, index) => (
                                <Image
                                    key={`${pip.name}-${index}`}
                                    source={pip.source as number}
                                    style={[
                                        { width: pipSize, height: pipSize },
                                        exhausted && styles.counterRotated
                                    ]}
                                    contentFit='contain'
                                />
                            ))}
                        </View>
                    ) : null}

                    <View style={styles.tokenColumn} pointerEvents='none'>
                        {damage > 0 ? (
                            <TokenPip value={damage} color='#b3261e' upright={exhausted} />
                        ) : null}
                        {power > 0 ? (
                            <TokenPip value={power} color='#2e7d32' label='+' upright={exhausted} />
                        ) : null}
                        {amber > 0 ? (
                            <TokenPip value={amber} color='#b8860b' upright={exhausted} />
                        ) : null}
                        {enrage > 0 ? (
                            <StatusIcon
                                source={STATUS_TOKEN_ICONS.enrage}
                                size={statusSize}
                                count={enrage}
                                upright={exhausted}
                            />
                        ) : null}
                        {stun ? (
                            <StatusIcon
                                source={STATUS_TOKEN_ICONS.stun}
                                size={statusSize}
                                upright={exhausted}
                            />
                        ) : null}
                        {ward > 0 ? (
                            <StatusIcon
                                source={STATUS_TOKEN_ICONS.ward}
                                size={statusSize}
                                count={ward}
                                upright={exhausted}
                            />
                        ) : null}
                    </View>

                    {upgradeCount + childCount > 0 ? (
                        <View
                            style={[styles.attachBadge, exhausted && styles.counterRotated]}
                            pointerEvents='none'
                        >
                            <Text style={styles.attachBadgeText}>
                                +{upgradeCount + childCount}
                            </Text>
                        </View>
                    ) : null}
                </View>
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        position: 'relative'
    },
    transformWrapper: {
        position: 'relative'
    },
    cardFrame: {
        borderRadius: 6,
        overflow: 'hidden',
        backgroundColor: colors.surface
    },
    image: {
        width: '100%',
        height: '100%'
    },
    exhausted: {
        // Scale down enough that the 90°-rotated card fits within its own
        // (un-rotated) slot — otherwise it overflows into neighbouring cards
        // and its extended edges fall outside the tappable area. The whole
        // wrapper (face + pips + tokens) transforms together so overlays keep
        // their size and position relative to the card.
        transform: [{ rotate: '90deg' }, { scale: 0.7 }]
    },
    // Undo the exhaust rotation on small glyphs so numbers stay upright.
    counterRotated: {
        transform: [{ rotate: '-90deg' }]
    },
    newCard: {
        shadowColor: colors.brand,
        shadowOpacity: 0.8,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 0 },
        elevation: 5
    },
    stunTint: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(10, 10, 20, 0.35)'
    },
    enhancementColumn: {
        position: 'absolute',
        top: '18%',
        left: 2,
        gap: 1,
        alignItems: 'center'
    },
    statusIcon: {
        alignItems: 'center',
        justifyContent: 'center'
    },
    statusCount: {
        position: 'absolute',
        color: '#fff',
        fontSize: 9,
        fontWeight: '900',
        textShadowColor: '#000',
        textShadowRadius: 3
    },
    tokenColumn: {
        position: 'absolute',
        top: 2,
        right: 2,
        gap: 2,
        alignItems: 'flex-end'
    },
    tokenPip: {
        minWidth: 18,
        height: 18,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 3,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.6)'
    },
    tokenPipText: {
        color: '#fff',
        fontSize: 10,
        fontWeight: '800'
    },
    attachBadge: {
        position: 'absolute',
        bottom: 2,
        left: 2,
        backgroundColor: 'rgba(20, 26, 40, 0.85)',
        borderRadius: 8,
        paddingHorizontal: 5,
        paddingVertical: 1,
        borderWidth: 1,
        borderColor: colors.borderLight
    },
    attachBadgeText: {
        color: colors.text,
        fontSize: 10,
        fontWeight: '700'
    }
});
