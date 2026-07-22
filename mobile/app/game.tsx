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
import { closeGameSocket, sendGameMessage } from '../src/net/gameSocket';
import { useAuthStore } from '../src/stores/authStore';
import { useGameStore } from '../src/stores/gameStore';
import { useLobbyStore } from '../src/stores/lobbyStore';
import { colors, spacing } from '../src/theme';
import CardTile from '../src/game/CardTile';
import PlayerHud from '../src/game/PlayerHud';
import PromptPanel from '../src/game/PromptPanel';
import LogSheet from '../src/game/LogSheet';
import { CardMenuModal, CardZoomModal, PileModal } from '../src/game/GameModals';
import type { CardMenuItem, CardSummary, PlayerState, PromptButton } from '../src/game/types';

type PileName = 'discard' | 'archives' | 'purged' | 'hand' | 'deck';

function CardRow(props: {
    cards: CardSummary[];
    width: number;
    minHeight: number;
    onPress: (card: CardSummary) => void;
    onLongPress: (card: CardSummary) => void;
    emptyLabel?: string;
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
        >
            {props.cards.map((card) => (
                <CardTile
                    key={card.uuid}
                    card={card}
                    width={props.width}
                    onPress={props.onPress}
                    onLongPress={props.onLongPress}
                />
            ))}
        </ScrollView>
    );
}

export default function GameScreen() {
    const rootState = useGameStore((state) => state.rootState);
    const status = useGameStore((state) => state.status);
    const currentGame = useLobbyStore((state) => state.currentGame);
    const username = useAuthStore((state) => state.user?.username);
    const { width: screenWidth } = useWindowDimensions();

    const [zoomCard, setZoomCard] = useState<CardSummary | undefined>();
    const [menuCard, setMenuCard] = useState<CardSummary | undefined>();
    const [logOpen, setLogOpen] = useState(false);
    const [pileView, setPileView] = useState<
        { player: 'me' | 'opponent'; pile: PileName } | undefined
    >();
    const leftGame = useRef(false);

    const players = useMemo(
        () => Object.values(rootState?.players ?? {}),
        [rootState?.players]
    );
    const me = username ? rootState?.players?.[username] : undefined;
    const isSpectator = !me;
    const perspective: PlayerState | undefined = me ?? players[0];
    const opponent = players.find((player) => player.name !== perspective?.name);

    // Rematch flow: the game node clears state and the lobby publishes a new
    // pending game. Follow it back to the pending screen.
    useEffect(() => {
        if (!rootState && currentGame && !currentGame.started && !leftGame.current) {
            closeGameSocket();
            router.replace('/pending');
        }
    }, [rootState, currentGame]);

    const smallCard = Math.max(56, Math.floor(screenWidth / 6.4));
    const handCard = Math.max(78, Math.floor(screenWidth / 4.6));

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
            { text: 'Concede', style: 'destructive', onPress: concede },
            { text: 'Leave game', style: 'destructive', onPress: leave },
            {
                text: rootState?.manualMode ? 'Disable manual mode' : 'Enable manual mode',
                onPress: () => sendGameMessage('toggleManualMode')
            },
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
        sendGameMessage('cardClicked', card.uuid);
    };

    const onHandCardPress = (card: CardSummary) => {
        if (isSpectator) {
            setZoomCard(card);
            return;
        }
        sendGameMessage('cardClicked', card.uuid);
    };

    const onMenuItem = (card: CardSummary, item: CardMenuItem) => {
        setMenuCard(undefined);
        sendGameMessage('menuItemClick', card.uuid, item);
    };

    const onPromptButton = (button: PromptButton) => {
        sendGameMessage(button.command ?? 'menuButton', button.arg, button.uuid, button.method);
    };

    const onLogCardPress = (card: CardSummary) => {
        setLogOpen(false);
        setZoomCard(card);
    };

    if (!rootState || !perspective) {
        return (
            <SafeAreaView style={styles.loading}>
                <ActivityIndicator size='large' color={colors.brand} />
                <Text style={styles.loadingText}>
                    {status === 'failed'
                        ? 'Could not reach the game server.'
                        : 'Connecting to the game…'}
                </Text>
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
                {status !== 'connected' ? (
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
            <ScrollView style={styles.board} contentContainerStyle={{ paddingVertical: 4 }}>
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

                {!isSpectator ? (
                    <PromptPanel me={me} onButton={onPromptButton} />
                ) : (
                    <View style={{ height: 8 }} />
                )}

                <CardRow
                    cards={myArea.creatures}
                    width={smallCard}
                    minHeight={smallCard * 1.4 + 8}
                    onPress={onPlayAreaCardPress}
                    onLongPress={setZoomCard}
                    emptyLabel={isSpectator ? undefined : 'Your battleline is empty'}
                />
                <CardRow
                    cards={myArea.artifacts}
                    width={smallCard}
                    minHeight={myArea.artifacts.length ? smallCard * 1.4 + 8 : 20}
                    onPress={onPlayAreaCardPress}
                    onLongPress={setZoomCard}
                />
            </ScrollView>

            {/* Me */}
            <PlayerHud
                player={perspective}
                isMe={!isSpectator}
                active={!!perspective.activePlayer}
                onPilePress={(pile) => setPileView({ player: 'me', pile })}
            />

            {/* Hand */}
            {(perspective.cardPiles?.hand?.length ?? 0) > 0 ? (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.handStrip}
                    contentContainerStyle={styles.handContent}
                >
                    {perspective.cardPiles.hand.map((card) => (
                        <CardTile
                            key={card.uuid}
                            card={card}
                            width={handCard}
                            onPress={onHandCardPress}
                            onLongPress={setZoomCard}
                        />
                    ))}
                </ScrollView>
            ) : (
                <View style={styles.handStrip}>
                    <Text style={styles.emptyRowText}>
                        {isSpectator ? 'Spectator view' : 'No cards in hand'}
                    </Text>
                </View>
            )}

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
        minHeight: 44,
        justifyContent: 'center'
    },
    handContent: {
        gap: 6,
        paddingHorizontal: spacing.sm,
        paddingVertical: 8,
        alignItems: 'flex-start'
    }
});
