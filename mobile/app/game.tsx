import React, { useEffect, useMemo, useRef, useState } from 'react';
import { router } from 'expo-router';
import {
    ActivityIndicator,
    Alert,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
    useWindowDimensions
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';
import {
    closeGameSocket,
    reconnectGameSocket,
    resyncGame,
    sendGameMessage
} from '../src/net/gameSocket';
import { successFeedback, tapFeedback, warnFeedback } from '../src/haptics';
import { useAuthStore } from '../src/stores/authStore';
import { useGameStore } from '../src/stores/gameStore';
import { useLobbyStore } from '../src/stores/lobbyStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import { colors, spacing } from '../src/theme';
import CardTile from '../src/game/CardTile';
import EffectsBar from '../src/game/EffectsBar';
import PlayerHud from '../src/game/PlayerHud';
import PromptPanel from '../src/game/PromptPanel';
import LogSheet from '../src/game/LogSheet';
import { DragDropProvider, DropZone, type DropZoneName } from '../src/game/DragDrop';
import { useVerticalSwipe } from '../src/game/gestures';
import { groupHandByHouse } from '../src/game/handOrder';
import { CardMenuModal, CardZoomModal, PileModal } from '../src/game/GameModals';
import { Button } from '../src/ui/primitives';
import HouseIcon from '../src/ui/HouseIcon';
import type { CardMenuItem, CardSummary, PlayerState, PromptButton } from '../src/game/types';

type PileName = 'discard' | 'archives' | 'purged' | 'hand' | 'deck';

function CardRow(props: {
    cards: CardSummary[];
    width: number;
    minHeight: number;
    onPress: (card: CardSummary) => void;
    onLongPress: (card: CardSummary) => void;
    emptyLabel?: string;
    dragSource?: DropZoneName;
    scrollEnabled?: boolean;
}) {
    if (props.cards.length === 0) {
        return (
            <View style={[styles.emptyRow, { minHeight: props.minHeight }]}>
                {props.emptyLabel ? (
                    <Text style={styles.emptyRowText}>{props.emptyLabel}</Text>
                ) : null}
            </View>
        );
    }
    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.cardRow}
            style={{ minHeight: props.minHeight, flexGrow: 0 }}
            scrollEnabled={props.scrollEnabled !== false}
        >
            {props.cards.map((card) => (
                <CardTile
                    key={card.uuid}
                    card={card}
                    width={props.width}
                    onPress={props.onPress}
                    onLongPress={props.onLongPress}
                    dragSource={props.dragSource}
                />
            ))}
        </ScrollView>
    );
}

export default function GameScreen() {
    // Keep the screen awake for the duration of a game — turns involve reading
    // and thinking, and the board auto-locking mid-turn is disruptive. Released
    // automatically when this screen unmounts (leaving the game).
    useKeepAwake();

    const rootState = useGameStore((state) => state.rootState);
    const status = useGameStore((state) => state.status);
    const currentGame = useLobbyStore((state) => state.currentGame);
    const username = useAuthStore((state) => state.user?.username);
    const handByHouse = useSettingsStore((state) => state.groupHandByHouse);
    const { width: screenWidth } = useWindowDimensions();

    const [zoomCard, setZoomCard] = useState<CardSummary | undefined>();
    const [menuCard, setMenuCard] = useState<CardSummary | undefined>();
    const [logOpen, setLogOpen] = useState(false);
    const [pileView, setPileView] = useState<
        { player: 'me' | 'opponent'; pile: PileName } | undefined
    >();
    // While a card is being dragged, the scroll views release the gesture.
    const [dragActive, setDragActive] = useState(false);
    const leftGame = useRef(false);

    const players = useMemo(
        () => Object.values(rootState?.players ?? {}),
        [rootState?.players]
    );
    const me = username ? rootState?.players?.[username] : undefined;
    const isSpectator = !me;
    const perspective: PlayerState | undefined = me ?? players[0];
    const opponent = players.find((player) => player.name !== perspective?.name);

    // Leave the board only when the game node actually tears the game down
    // (game over / rematch / a player left), signalled by a bump in `cleared`.
    // We must NOT leave just because `rootState` is momentarily empty — that
    // also happens while the socket is (re)connecting and the full state is in
    // flight, which is exactly the moment right after "Start game". Capture the
    // counter on mount and react only to later increases.
    const cleared = useGameStore((state) => state.cleared);
    const clearedBaseline = useRef(cleared);
    useEffect(() => {
        if (cleared === clearedBaseline.current || leftGame.current) {
            return;
        }
        clearedBaseline.current = cleared;
        leftGame.current = true;
        closeGameSocket();
        // A rematch leaves us in a fresh pending game; otherwise go to the lobby.
        const pending = useLobbyStore.getState().currentGame;
        if (pending && !pending.started) {
            router.replace('/pending');
        } else if (router.canGoBack()) {
            router.back();
        } else {
            router.replace('/(tabs)');
        }
    }, [cleared]);

    // Fire a single haptic when the game ends.
    const winnerRef = useRef<string | undefined>(undefined);
    useEffect(() => {
        const winner = rootState?.winner;
        if (winner && winner !== winnerRef.current) {
            winnerRef.current = winner;
            if (!isSpectator && winner === perspective?.name) {
                successFeedback();
            } else {
                warnFeedback();
            }
        }
    }, [rootState?.winner, isSpectator, perspective?.name]);

    const smallCard = Math.max(56, Math.floor(screenWidth / 6.4));
    const handCard = Math.max(78, Math.floor(screenWidth / 4.6));

    // Swiping up anywhere on the prompt/grabber strip opens the log; swiping
    // back down inside the log sheet returns to the board.
    const openLogHandlers = useVerticalSwipe({ onUp: () => setLogOpen(true) });

    const leave = () => {
        Alert.alert('Leave game', 'Leave this game?', [
            { text: 'Stay', style: 'cancel' },
            {
                text: 'Leave',
                style: 'destructive',
                onPress: () => {
                    leftGame.current = true;
                    sendGameMessage('leavegame');
                    closeGameSocket();
                    if (router.canGoBack()) {
                        router.back();
                    } else {
                        router.replace('/(tabs)');
                    }
                }
            }
        ]);
    };

    const concede = () => {
        Alert.alert('Concede', 'Concede this game?', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Concede',
                style: 'destructive',
                onPress: () => sendGameMessage('concede')
            }
        ]);
    };

    const showGameMenu = () => {
        Alert.alert(rootState?.name ?? 'Game', undefined, [
            { text: 'Resync game', onPress: resyncGame },
            {
                text: rootState?.manualMode ? 'Disable manual mode' : 'Enable manual mode',
                onPress: () => sendGameMessage('toggleManualMode')
            },
            { text: 'Concede', style: 'destructive', onPress: concede },
            { text: 'Leave game', style: 'destructive', onPress: leave },
            { text: 'Close', style: 'cancel' }
        ]);
    };

    const onPlayAreaCardPress = (card: CardSummary) => {
        if (isSpectator) {
            setZoomCard(card);
            return;
        }
        if (card.menu && card.menu.length > 0) {
            setMenuCard(card);
            return;
        }
        tapFeedback();
        sendGameMessage('cardClicked', card.uuid);
    };

    const onHandCardPress = (card: CardSummary) => {
        if (isSpectator) {
            setZoomCard(card);
            return;
        }
        tapFeedback();
        sendGameMessage('cardClicked', card.uuid);
    };

    const onMenuItem = (card: CardSummary, item: CardMenuItem) => {
        setMenuCard(undefined);
        tapFeedback();
        sendGameMessage('menuItemClick', card.uuid, item);
    };

    const onPromptButton = (button: PromptButton) => {
        tapFeedback();
        sendGameMessage(button.command ?? 'menuButton', button.arg, button.uuid, button.method);
    };

    const onLogCardPress = (card: CardSummary) => {
        setLogOpen(false);
        setZoomCard(card);
    };

    const onDrop = (card: CardSummary, source: DropZoneName, target: DropZoneName) => {
        tapFeedback();
        sendGameMessage('drop', card.uuid, source, target);
    };

    if (!rootState || !perspective) {
        const failed = status === 'failed';
        return (
            <SafeAreaView style={styles.loading}>
                {failed ? (
                    <Text style={styles.loadingIcon}>⚠</Text>
                ) : (
                    <ActivityIndicator size='large' color={colors.brand} />
                )}
                <Text style={styles.loadingText}>
                    {failed
                        ? 'Could not reach the game server.'
                        : 'Connecting to the game…'}
                </Text>
                {failed ? (
                    <Button title='Retry connection' onPress={reconnectGameSocket} />
                ) : null}
                <Pressable
                    onPress={() => {
                        leftGame.current = true;
                        closeGameSocket();
                        if (router.canGoBack()) {
                            router.back();
                        } else {
                            router.replace('/(tabs)');
                        }
                    }}
                    hitSlop={8}
                >
                    <Text style={styles.loadingLeave}>Back to lobby</Text>
                </Pressable>
            </SafeAreaView>
        );
    }

    const splitPlayArea = (player?: PlayerState) => {
        const inPlay = player?.cardPiles?.cardsInPlay ?? [];
        return {
            creatures: inPlay.filter((card) => card.type === 'creature'),
            artifacts: inPlay.filter((card) => card.type !== 'creature')
        };
    };

    const myArea = splitPlayArea(perspective);
    const oppArea = splitPlayArea(opponent);

    const hand = perspective.cardPiles?.hand ?? [];
    const handGroups = handByHouse
        ? groupHandByHouse(hand, perspective.houses, perspective.activeHouse)
        : // One unnamed group keeps the render path identical for both settings.
          [{ house: 'hand', cards: hand }];

    const pileCards = (() => {
        if (!pileView) {
            return undefined;
        }
        const target = pileView.player === 'me' ? perspective : opponent;
        return target?.cardPiles?.[pileView.pile === 'deck' ? 'discard' : pileView.pile];
    })();

    const winnerBanner = rootState.winner ? (
        <View style={styles.winnerBanner}>
            <Text style={styles.winnerText}>
                {rootState.winner === perspective.name && !isSpectator
                    ? '🎉 You won the game!'
                    : `${rootState.winner} won the game`}
            </Text>
        </View>
    ) : null;

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <DragDropProvider
                enabled={!isSpectator}
                manualMode={!!rootState.manualMode}
                onDrop={onDrop}
                onDragActiveChange={setDragActive}
            >
            {/* Header */}
            <View style={styles.header}>
                <View style={{ flex: 1 }}>
                    <Text style={styles.gameName} numberOfLines={1}>
                        {rootState.name}
                    </Text>
                    <Text style={styles.phase}>
                        {String(perspective.phase ?? '')}
                        {rootState.manualMode ? ' · manual' : ''}
                        {isSpectator ? ' · spectating' : ''}
                    </Text>
                </View>
                {status === 'failed' ? (
                    <Pressable
                        onPress={reconnectGameSocket}
                        style={styles.reconnectButton}
                        hitSlop={8}
                    >
                        <Text style={styles.reconnectButtonText}>Reconnect</Text>
                    </Pressable>
                ) : status !== 'connected' ? (
                    <Text style={styles.reconnecting}>reconnecting…</Text>
                ) : null}
                <Pressable onPress={() => setLogOpen(true)} style={styles.headerButton} hitSlop={8}>
                    <Text style={styles.headerButtonText}>Log</Text>
                </Pressable>
                <Pressable onPress={showGameMenu} style={styles.headerButton} hitSlop={8}>
                    <Text style={styles.headerButtonText}>⋯</Text>
                </Pressable>
            </View>

            {winnerBanner}

            {/* Opponent */}
            {opponent ? (
                <PlayerHud
                    player={opponent}
                    active={!!opponent.activePlayer}
                    onPilePress={(pile) => setPileView({ player: 'opponent', pile })}
                />
            ) : null}

            {/* Board */}
            <ScrollView
                style={styles.board}
                contentContainerStyle={{ paddingVertical: 4 }}
                scrollEnabled={!dragActive}
            >
                <CardRow
                    cards={oppArea.artifacts}
                    width={smallCard}
                    minHeight={oppArea.artifacts.length ? smallCard * 1.4 + 8 : 20}
                    onPress={onPlayAreaCardPress}
                    onLongPress={setZoomCard}
                />
                <CardRow
                    cards={oppArea.creatures}
                    width={smallCard}
                    minHeight={smallCard * 1.4 + 8}
                    onPress={onPlayAreaCardPress}
                    onLongPress={setZoomCard}
                    emptyLabel='No enemy creatures'
                />

                <View style={{ height: 8 }} />

                {/* My side of the board accepts card drops (playing from hand,
                    manual-mode moves). */}
                <DropZone name='play area'>
                    <CardRow
                        cards={myArea.creatures}
                        width={smallCard}
                        minHeight={smallCard * 1.4 + 8}
                        onPress={onPlayAreaCardPress}
                        onLongPress={setZoomCard}
                        emptyLabel={isSpectator ? undefined : 'Your battleline is empty'}
                        dragSource={isSpectator ? undefined : 'play area'}
                        scrollEnabled={!dragActive}
                    />
                    <CardRow
                        cards={myArea.artifacts}
                        width={smallCard}
                        minHeight={myArea.artifacts.length ? smallCard * 1.4 + 8 : 20}
                        onPress={onPlayAreaCardPress}
                        onLongPress={setZoomCard}
                        dragSource={isSpectator ? undefined : 'play area'}
                        scrollEnabled={!dragActive}
                    />
                </DropZone>
            </ScrollView>

            {/* Lasting effects aimed at a player (Befuddle and friends). Their
                source card is usually in a discard pile by now, so this is the
                only place the restriction is visible. */}
            <EffectsBar
                effects={rootState.effects}
                me={perspective.name}
                onCardPress={setZoomCard}
            />

            {/* Prompt — pinned just above the player so the required action is
                always visible, never scrolled off with the board. */}
            <View {...openLogHandlers}>
                {!isSpectator ? (
                    <PromptPanel
                        me={me}
                        onButton={onPromptButton}
                        messages={rootState.messages ?? []}
                        onOpenLog={() => setLogOpen(true)}
                        onCardPress={setZoomCard}
                    />
                ) : null}

                {/* Always-present grab handle, so the log is one swipe away
                    even when the prompt panel has nothing to show. */}
                <Pressable
                    onPress={() => setLogOpen(true)}
                    style={styles.logGrabber}
                    accessibilityRole='button'
                    accessibilityLabel='Open the game log'
                    hitSlop={6}
                >
                    <View style={styles.logGrabberBar} />
                    <Text style={styles.logGrabberText}>Swipe up for the full log</Text>
                </Pressable>
            </View>

            {/* Me */}
            <PlayerHud
                player={perspective}
                isMe={!isSpectator}
                active={!!perspective.activePlayer}
                onPilePress={(pile) => setPileView({ player: 'me', pile })}
            />

            {/* Hand */}
            <DropZone name='hand'>
                {hand.length > 0 ? (
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        style={styles.handStrip}
                        contentContainerStyle={styles.handContent}
                        scrollEnabled={!dragActive}
                    >
                        {handGroups.map((group, groupIndex) => (
                            <React.Fragment key={group.house}>
                                {/* House divider, so the groups read as groups
                                    rather than as one long undifferentiated row. */}
                                {groupIndex > 0 ? <View style={styles.handDivider} /> : null}
                                {group.cards.map((card) => (
                                    <CardTile
                                        key={card.uuid}
                                        card={card}
                                        width={handCard}
                                        onPress={onHandCardPress}
                                        onLongPress={setZoomCard}
                                        dragSource={isSpectator ? undefined : 'hand'}
                                    />
                                ))}
                            </React.Fragment>
                        ))}
                    </ScrollView>
                ) : (
                    <View style={[styles.handStrip, styles.handStripEmpty]}>
                        <Text style={styles.emptyRowText}>
                            {isSpectator ? 'Spectator view' : 'No cards in hand'}
                        </Text>
                    </View>
                )}
                {handByHouse && handGroups.length > 1 ? (
                    <View style={styles.handLegend}>
                        {handGroups.map((group) => (
                            <View key={group.house} style={styles.handLegendItem}>
                                <HouseIcon
                                    house={group.house}
                                    size={13}
                                    dimmed={
                                        !!perspective.activeHouse &&
                                        perspective.activeHouse !== group.house
                                    }
                                />
                                <Text style={styles.handLegendCount}>{group.cards.length}</Text>
                            </View>
                        ))}
                    </View>
                ) : null}
            </DropZone>

            {/* Modals */}
            <CardZoomModal card={zoomCard} onClose={() => setZoomCard(undefined)} />
            <CardMenuModal
                card={menuCard}
                onClose={() => setMenuCard(undefined)}
                onItem={onMenuItem}
                onZoom={(card) => {
                    setMenuCard(undefined);
                    setZoomCard(card);
                }}
            />
            <PileModal
                visible={!!pileView}
                title={
                    pileView
                        ? `${pileView.player === 'me' ? perspective.name : opponent?.name} · ${
                              pileView.pile
                          }`
                        : undefined
                }
                cards={pileCards}
                onClose={() => setPileView(undefined)}
                onCardPress={(card) => {
                    if (!isSpectator && card.selectable) {
                        sendGameMessage('cardClicked', card.uuid);
                        setPileView(undefined);
                    } else {
                        setZoomCard(card);
                    }
                }}
                onCardLongPress={setZoomCard}
            />
            <LogSheet
                visible={logOpen}
                messages={rootState.messages ?? []}
                onClose={() => setLogOpen(false)}
                onSend={(text) => sendGameMessage('chat', text)}
                onCardPress={onLogCardPress}
            />
            </DragDropProvider>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    loading: {
        flex: 1,
        backgroundColor: colors.bg,
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.md
    },
    loadingText: {
        color: colors.textDim,
        fontSize: 14
    },
    loadingIcon: {
        color: colors.warning,
        fontSize: 40
    },
    reconnectButton: {
        backgroundColor: colors.warning,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 6
    },
    reconnectButtonText: {
        color: '#161006',
        fontSize: 13,
        fontWeight: '800'
    },
    loadingLeave: {
        color: colors.accent,
        fontSize: 14,
        fontWeight: '700',
        padding: spacing.md
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.md,
        paddingVertical: 6,
        gap: spacing.sm
    },
    gameName: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '800'
    },
    phase: {
        color: colors.textFaint,
        fontSize: 11,
        textTransform: 'capitalize'
    },
    reconnecting: {
        color: colors.warning,
        fontSize: 11,
        fontWeight: '700'
    },
    headerButton: {
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 6
    },
    headerButtonText: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '700'
    },
    winnerBanner: {
        backgroundColor: '#233a2a',
        borderColor: colors.success,
        borderWidth: 1,
        marginHorizontal: spacing.md,
        marginBottom: 4,
        borderRadius: 10,
        padding: spacing.sm
    },
    winnerText: {
        color: '#7ed494',
        fontWeight: '800',
        textAlign: 'center',
        fontSize: 14
    },
    board: {
        flex: 1
    },
    cardRow: {
        gap: 6,
        paddingHorizontal: spacing.sm,
        paddingVertical: 4,
        alignItems: 'center'
    },
    emptyRow: {
        alignItems: 'center',
        justifyContent: 'center'
    },
    emptyRowText: {
        color: colors.textFaint,
        fontSize: 11
    },
    handStrip: {
        backgroundColor: '#0e1420',
        borderTopColor: colors.border,
        borderTopWidth: 1,
        maxHeight: 190,
        minHeight: 44
        // NOTE: never put justifyContent/alignItems that centers the MAIN
        // (horizontal) axis here — on a horizontal ScrollView that centers the
        // overflowing row and makes the leftmost cards impossible to scroll to.
    },
    handContent: {
        gap: 6,
        paddingHorizontal: spacing.sm,
        paddingVertical: 8,
        // Cross-axis (vertical) centering only — safe for horizontal scrolling.
        alignItems: 'center'
    },
    handStripEmpty: {
        alignItems: 'center',
        justifyContent: 'center'
    },
    handDivider: {
        width: 1,
        alignSelf: 'stretch',
        marginHorizontal: 5,
        marginVertical: 6,
        backgroundColor: colors.borderLight
    },
    handLegend: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: spacing.md,
        paddingBottom: 3,
        backgroundColor: '#0e1420'
    },
    handLegendItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3
    },
    handLegendCount: {
        color: colors.textFaint,
        fontSize: 10,
        fontWeight: '700'
    },
    logGrabber: {
        alignItems: 'center',
        paddingTop: 3,
        paddingBottom: 4,
        gap: 2
    },
    logGrabberBar: {
        width: 34,
        height: 3,
        borderRadius: 2,
        backgroundColor: colors.borderLight
    },
    logGrabberText: {
        color: colors.textFaint,
        fontSize: 9
    }
});
