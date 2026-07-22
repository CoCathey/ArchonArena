import React from 'react';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { CARD_ASPECT, CARDBACK, cardImageUrl } from './cardImages';
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
            delayLongPress={220}
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

                {stun ? (
                    <View style={styles.stunOverlay}>
                        <Text style={styles.stunText}>STUN</Text>
                    </View>
                ) : null}
            </View>

            <View style={styles.tokenColumn} pointerEvents='none'>
                {damage > 0 ? <TokenPip value={damage} color='#b3261e' /> : null}
                {power > 0 ? <TokenPip value={power} color='#2e7d32' label='+' /> : null}
                {amber > 0 ? <TokenPip value={amber} color='#b8860b' /> : null}
                {ward > 0 ? <TokenPip value={ward} color='#4a5fa5' label='W' /> : null}
                {enrage > 0 ? <TokenPip value={enrage} color='#a53f4a' label='E' /> : null}
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
        transform: [{ rotate: '90deg' }, { scale: 0.86 }]
    },
    newCard: {
        shadowColor: colors.brand,
        shadowOpacity: 0.8,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 0 },
        elevation: 5
    },
    stunOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(10, 10, 20, 0.55)',
        alignItems: 'center',
        justifyContent: 'center'
    },
    stunText: {
        color: '#ffd166',
        fontWeight: '900',
        fontSize: 10,
        letterSpacing: 1
    },
    tokenColumn: {
        position: 'absolute',
        top: 2,
        right: 2,
        gap: 2
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
