import React from 'react';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../theme';
import HouseIcon from '../ui/HouseIcon';
import { DropZone, useDragDrop, type DropZoneName } from './DragDrop';
import { isPilePrompted } from './promptedPiles';
import type { PlayerState, PromptedPile } from './types';

const KEY_IMAGES: Record<string, { forged: number; unforged: number }> = {
    red: {
        forged: require('../../assets/img/forgedkeyred.png'),
        unforged: require('../../assets/img/unforgedkeyred.png')
    },
    blue: {
        forged: require('../../assets/img/forgedkeyblue.png'),
        unforged: require('../../assets/img/unforgedkeyblue.png')
    },
    yellow: {
        forged: require('../../assets/img/forgedkeyyellow.png'),
        unforged: require('../../assets/img/unforgedkeyyellow.png')
    }
};

function PileChip(props: {
    label: string;
    count: number;
    onPress?: () => void;
    dropZone?: DropZoneName;
    /** The current prompt is asking for a card out of this pile. */
    prompted?: boolean;
}) {
    const interactive = !!props.onPress;
    const chip = (
        <Pressable
            onPress={props.onPress}
            disabled={!interactive}
            hitSlop={8}
            accessibilityRole={interactive ? 'button' : undefined}
            accessibilityLabel={
                interactive
                    ? `${props.label}, ${props.count} card${props.count === 1 ? '' : 's'}${
                          props.prompted ? ', choose a card from here' : ''
                      }`
                    : undefined
            }
            style={({ pressed }) => [
                styles.pileChip,
                interactive && styles.pileChipInteractive,
                props.prompted && styles.pileChipPrompted,
                pressed && { opacity: 0.6 }
            ]}
        >
            <Text style={[styles.pileChipLabel, props.prompted && styles.pileChipLabelPrompted]}>
                {props.label}
            </Text>
            <Text style={styles.pileChipCount}>{props.count}</Text>
        </Pressable>
    );
    if (!props.dropZone) {
        return chip;
    }
    // The chip doubles as the drop target for its pile while a card is being
    // dragged (deck/discard/archives/purged in manual mode, discard in play).
    return <DropZone name={props.dropZone}>{chip}</DropZone>;
}

export default function PlayerHud(props: {
    player: PlayerState;
    isMe?: boolean;
    active?: boolean;
    onPilePress?: (pile: 'discard' | 'archives' | 'purged' | 'hand' | 'deck') => void;
    /**
     * Piles the current prompt is drawing from, as sent to the prompted player.
     * Always that player's own list, whichever HUD is being drawn — `isMe`
     * decides which side of each entry applies here.
     */
    promptedPiles?: PromptedPile[];
}) {
    const { player } = props;
    const stats = player.stats;
    const keys = stats?.keys ?? { red: false, blue: false, yellow: false };
    const forgedCount = Object.values(keys).filter(Boolean).length;
    const dragContext = useDragDrop();
    // My piles accept drops; while dragging in manual mode the purged chip
    // appears even when empty so there's something to drop onto.
    const dropZonesActive = !!props.isMe && !!dragContext?.enabled;
    const showPurged =
        (player.cardPiles?.purged?.length ?? 0) > 0 ||
        (dropZonesActive && !!dragContext?.dragging && dragContext.manualMode);
    const prompted = (location: string) =>
        isPilePrompted(props.promptedPiles, location, !!props.isMe);

    return (
        <View style={[styles.container, props.active && styles.activeContainer]}>
            <View style={styles.nameBlock}>
                <Text style={[styles.name, props.active && { color: colors.brand }]} numberOfLines={1}>
                    {player.name}
                    {player.disconnected ? ' ⚠︎' : ''}
                </Text>
                <View style={styles.houseRow}>
                    {(player.houses ?? []).map((house) => (
                        <HouseIcon
                            key={house}
                            house={house}
                            size={17}
                            active={player.activeHouse === house}
                            dimmed={!!player.activeHouse && player.activeHouse !== house}
                        />
                    ))}
                </View>
            </View>

            <View style={styles.statsRow}>
                <View style={styles.amberChip}>
                    <Text style={styles.amberText}>{stats?.amber ?? 0}</Text>
                    <Text style={styles.amberLabel}>Æ</Text>
                </View>

                <View style={styles.keyRow}>
                    {(['red', 'blue', 'yellow'] as const).map((color) => (
                        <Image
                            key={color}
                            source={keys[color] ? KEY_IMAGES[color].forged : KEY_IMAGES[color].unforged}
                            style={[styles.keyImage, !keys[color] && { opacity: 0.4 }]}
                            contentFit='contain'
                        />
                    ))}
                </View>

                <Text style={styles.keyCost}>
                    {forgedCount}/3 · cost {stats?.keyCost ?? 6}
                </Text>

                {stats?.chains ? <Text style={styles.chains}>⛓ {stats.chains}</Text> : null}
            </View>

            <View style={styles.pileRow}>
                {/* The opponent's hand opens like any other pile — face down
                    normally, and readable exactly when the engine has revealed
                    it (Abyssal Sight and friends). Mine stays a plain count,
                    because the hand strip along the bottom already is it. */}
                <PileChip
                    label='Hand'
                    count={player.cardPiles?.hand?.length ?? 0}
                    onPress={props.isMe ? undefined : () => props.onPilePress?.('hand')}
                    prompted={prompted('hand')}
                />
                <PileChip
                    label='Deck'
                    count={player.numDeckCards ?? 0}
                    dropZone={dropZonesActive ? 'deck' : undefined}
                />
                <PileChip
                    label='Discard'
                    count={player.cardPiles?.discard?.length ?? 0}
                    onPress={() => props.onPilePress?.('discard')}
                    dropZone={dropZonesActive ? 'discard' : undefined}
                    prompted={prompted('discard')}
                />
                <PileChip
                    label='Archive'
                    count={player.cardPiles?.archives?.length ?? 0}
                    onPress={() => props.onPilePress?.('archives')}
                    dropZone={dropZonesActive ? 'archives' : undefined}
                    prompted={prompted('archives')}
                />
                {showPurged ? (
                    <PileChip
                        label='Purged'
                        count={player.cardPiles?.purged?.length ?? 0}
                        onPress={() => props.onPilePress?.('purged')}
                        dropZone={dropZonesActive ? 'purged' : undefined}
                        prompted={prompted('purged')}
                    />
                ) : null}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        paddingHorizontal: spacing.md,
        paddingVertical: 6,
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderBottomWidth: StyleSheet.hairlineWidth
    },
    activeContainer: {
        backgroundColor: '#182036'
    },
    nameBlock: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between'
    },
    name: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '800',
        flexShrink: 1
    },
    houseRow: {
        flexDirection: 'row',
        gap: 5
    },
    statsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        marginTop: 4
    },
    amberChip: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#3a2f10',
        borderColor: colors.amber,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 2,
        gap: 3
    },
    amberText: {
        color: colors.amber,
        fontWeight: '900',
        fontSize: 14
    },
    amberLabel: {
        color: colors.amber,
        fontSize: 11,
        fontWeight: '700'
    },
    keyRow: {
        flexDirection: 'row',
        gap: 3
    },
    keyImage: {
        width: 20,
        height: 20
    },
    keyCost: {
        color: colors.textDim,
        fontSize: 11
    },
    chains: {
        color: colors.warning,
        fontSize: 12,
        fontWeight: '700'
    },
    pileRow: {
        flexDirection: 'row',
        gap: 6,
        marginTop: 5
    },
    pileChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 5
    },
    // Tappable piles (the opponent's hand, discard/archives/purged) read as
    // buttons; my own Hand and both Decks are just counts.
    pileChipInteractive: {
        backgroundColor: colors.surfaceHover,
        borderColor: colors.borderLight
    },
    // The pile the prompt wants a card from, in the same blue a selectable
    // card is outlined in — so "choose a card" has somewhere to point. The
    // padding gives back the pixel the thicker border takes, so the row of
    // chips doesn't jump every time a prompt comes and goes.
    pileChipPrompted: {
        borderColor: colors.selectable,
        borderWidth: 2,
        backgroundColor: 'rgba(79, 142, 247, 0.18)',
        paddingHorizontal: 9,
        paddingVertical: 4
    },
    pileChipLabel: {
        color: colors.textFaint,
        fontSize: 10,
        fontWeight: '600'
    },
    pileChipLabelPrompted: {
        color: colors.text
    },
    pileChipCount: {
        color: colors.text,
        fontSize: 11,
        fontWeight: '800'
    }
});
