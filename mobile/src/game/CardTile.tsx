import React from 'react';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { CARD_ASPECT, CARDBACK, cardImageUrl } from './cardImages';
import { STATUS_TOKEN_ICONS, enhancementPip } from './cardIcons';
import type { CardSummary } from './types';

function TokenPip(props: { value: number; color: string; label?: string }) {
    return (
        <View style={[styles.tokenPip, { backgroundColor: props.color }]}>
            <Text style={styles.tokenPipText}>
                {props.label ? `${props.label}${props.value}` : props.value}
            </Text>
        </View>
    );
}

// A status token (enrage/stun/ward) shown as its real icon, with a count only
// when it is stacked more than once.
function StatusIcon(props: { source: number; size: number; count?: number }) {
    return (
        <View style={styles.statusIcon}>
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

    return (
        <Pressable
            onPress={() => props.onPress?.(card)}
            onLongPress={() => props.onLongPress?.(card)}
            delayLongPress={450}
            disabled={props.disabled}
            style={({ pressed }) => [
                styles.container,
                { width, height },
                pressed && { opacity: 0.8 }
            ]}
        >
            <View
                style={[
                    styles.cardFrame,
                    { width, height },
                    borderStyle,
                    card.exhausted && styles.exhausted,
                    card.unselectable && { opacity: 0.45 },
                    card.new && styles.newCard
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
                            style={{ width: pipSize, height: pipSize }}
                            contentFit='contain'
                        />
                    ))}
                </View>
            ) : null}

            <View style={styles.tokenColumn} pointerEvents='none'>
                {damage > 0 ? <TokenPip value={damage} color='#b3261e' /> : null}
                {power > 0 ? <TokenPip value={power} color='#2e7d32' label='+' /> : null}
                {amber > 0 ? <TokenPip value={amber} color='#b8860b' /> : null}
                {enrage > 0 ? (
                    <StatusIcon source={STATUS_TOKEN_ICONS.enrage} size={statusSize} count={enrage} />
                ) : null}
                {stun ? <StatusIcon source={STATUS_TOKEN_ICONS.stun} size={statusSize} /> : null}
                {ward > 0 ? (
                    <StatusIcon source={STATUS_TOKEN_ICONS.ward} size={statusSize} count={ward} />
                ) : null}
            </View>

            {upgradeCount + childCount > 0 ? (
                <View style={styles.attachBadge} pointerEvents='none'>
                    <Text style={styles.attachBadgeText}>+{upgradeCount + childCount}</Text>
                </View>
            ) : null}
        </Pressable>
    );
}

const styles = StyleSheet.create({
    container: {
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
        // and its extended edges fall outside the tappable area.
        transform: [{ rotate: '90deg' }, { scale: 0.7 }]
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
