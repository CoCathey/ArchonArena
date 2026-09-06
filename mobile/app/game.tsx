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
import { ReportPlayerSheet } from '../src/safety/ReportPlayerSheet';
import { useGameStore } from '../src/stores/gameStore';
import { useLobbyStore } from '../src/stores/lobbyStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import { colors, spacing } from '../src/theme';
import CardTile from '../src/game/CardTile';
import EffectsBar from '../src/game/EffectsBar';
import PlayerHud from '../src/game/PlayerHud';
import PromptPanel from '../src/game/PromptPanel';
import LogSheet from '../src/game/LogSheet';
import TimeLimitClock from '../src/game/TimeLimitClock';
import { DragDropProvider, DropZone, type DropZoneName } from '../src/game/DragDrop';
import { useVerticalSwipe } from '../src/game/gestures';
import { groupHandByHouse } from '../src/game/handOrder';
import { isHandHidden } from '../src/game/handVisibility';
import { hasProphecies } from '../src/game/prophecies';
import { ProphecySheet, ProphecyStrip } from '../src/game/ProphecyView';
import { CardMenuSheet, CardZoomOverlay, PileViewer } from '../src/game/GameModals';
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
    const username = useAuthStore((state) => state.user?.username);
    const [reporting, setReporting] = useState(false);
    const handByHouse = useSettingsStore((state) => state.groupHandByHouse);
    const hideHandSetting = useSettingsStore((state) => state.hideHandOnOpponentTurn);
    const setHideHandSetting = useSettingsStore((state) => state.setHideHandOnOpponentTurn);
    const { width: screenWidth } = useWindowDimensions();

    const [zoomCard, setZoomCard] = useState<CardSummary | undefined>();
    const [menuCard, setMenuCard] = useState<CardSummary | undefined>();
    const [logOpen, setLogOpen] = useState(false);
    const [pileView, setPileView] = useState<
        { player: 'me' | 'opponent'; pile: PileName } | undefined
    >();
    // Held by uuid rather than by value: prophecies change state under us
    // (activated, flipped) and the sheet has to show what is true now.
    const [prophecyView, setProphecyView] = useState<
        { uuid: string; mine: boolean } | undefined
    >();
    // "Show me my hand anyway" for the rest of the opponent's turn.
    const [peekingHand, setPeekingHand] = useState(false);
    // While a card is being dragged, the scroll views release the gesture.
    const [dragActive, setDragActive] = useState(false);
    const leftGame = useRef(false);

    const players = useMemo(() => Object.values(rootState?.players ?? {}), [rootState?.players]);
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

    // A peek lasts until the turn comes back round, so the setting behaves the
    // same way every opponent turn rather than quietly staying off after the
    // one time somebody looked.
    const myTurn = !!me?.activePlayer;
    useEffect(() => {
        if (myTurn) {
            setPeekingHand(false);
        }
    }, [myTurn]);

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

    // The account carries this setting too (set from the website), and either
    // one turns it on. The in-game toggle writes both, so switching it off here
    // is not overridden by an account value that is still on.
    const hideHandEnabled = hideHandSetting || !!me?.optionSettings?.hideHandOnOpponentTurn;

    const toggleHideHand = () => {
        const next = !hideHandEnabled;
        setHideHandSetting(next);
        // Keep the game node's copy in step, so a game watched from the web at
        // the same time agrees about it.
        sendGameMessage('toggleOptionSetting', 'hideHandOnOpponentTurn', next);
        if (next) {
            setPeekingHand(false);
        }
    };

    const showGameMenu = () => {
        Alert.alert(rootState?.name ?? 'Game', undefined, [
            {
                text: hideHandEnabled
                    ? 'Show my hand on their turn'
                    : 'Hide my hand on their turn',
                onPress: toggleHideHand
            },
            { text: 'Resync game', onPress: resyncGame },
            {
                text: rootState?.manualMode ? 'Disable manual mode' : 'Enable manual mode',
                onPress: () => sendGameMessage('toggleManualMode')
            },
            // ARCHON: Guideline 1.2 wants reporting reachable where the
            // user-generated content is, and in this app that is the in-game
            // chat above all - it is the one screen two strangers share for
            // half an hour. It was reportable from the game LOBBY and nowhere
            // after that, and this screen has no back gesture and no header
            // back button, so conceding was the only way out of a conversation.
            ...(opponent?.name
                ? [
                      {
                          text: `Report or block ${opponent.name}`,
                          onPress: () => setReporting(true)
                      }
                  ]
                : []),
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

    // ---- prophecies ----
    // `clickProphecy` is the same message the web client sends; the engine
    // routes it through the current pipeline step, which is what makes it work
    // both as an activation and as an answer to a prompt.
    const onProphecySelect = (card: CardSummary) => {
        if (isSpectator) {
            setZoomCard(card);
            return;
        }
        tapFeedback();
        sendGameMessage('cardClicked', card.uuid);
    };

    const onProphecyActivate = (card: CardSummary) => {
        if (isSpectator) {
            return;
        }
        tapFeedback();
        sendGameMessage('clickProphecy', card.uuid);
        setProphecyView(undefined);
    };

    const onProphecyMenuItem = (card: CardSummary, item: CardMenuItem) => {
        tapFeedback();
        sendGameMessage('menuItemClick', card.uuid, item);
        setProphecyView(undefined);
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
                    {failed ? 'Could not reach the game server.' : 'Connecting to the game…'}
                </Text>
                {failed ? <Button title='Retry connection' onPress={reconnectGameSocket} /> : null}
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

    // Stand the hand down while the opponent plays, if asked. Never when the
    // game wants something from this player — see handVisibility.ts.
    const handHidden = isHandHidden({
        me,
        localSetting: hideHandSetting,
        isPeeking: peekingHand,
        isSpectator
    });

    const pileCards = (() => {
        if (!pileView) {
            return undefined;
        }
        const target = pileView.player === 'me' ? perspective : opponent;
        return target?.cardPiles?.[pileView.pile === 'deck' ? 'discard' : pileView.pile];
    })();

    // Prophecies live beside the board rather than in a pile, and both sides
    // are public, so each player's are drawn under their own stats.
    const prophecyOwner = prophecyView
        ? prophecyView.mine
            ? perspective
            : opponent
        : undefined;
    const prophecyCard = prophecyView
        ? prophecyOwner?.prophecyCards?.find((card) => card.uuid === prophecyView.uuid)
        : undefined;
    const showProphecies = hasProphecies(perspective, opponent);

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
        <View style={styles.container}>
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
                                {/* Joined rather than concatenated: once the
                                    game is over the phase is blank, and a
                                    fixed separator left " · manual" hanging. */}
                                {[
                                    String(perspective.phase ?? ''),
                                    rootState.manualMode ? 'manual' : '',
                                    isSpectator ? 'spectating' : ''
                                ]
                                    .filter(Boolean)
                                    .join(' · ')}
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
                        <Pressable
                            onPress={() => setLogOpen(true)}
                            style={styles.headerButton}
                            hitSlop={8}
                        >
                            <Text style={styles.headerButtonText}>Log</Text>
                        </Pressable>
                        <Pressable onPress={showGameMenu} style={styles.headerButton} hitSlop={8}>
                            <Text style={styles.headerButtonText}>⋯</Text>
                        </Pressable>
                    </View>

                    {rootState.useGameTimeLimit ? (
                        <TimeLimitClock
                            timeLimit={rootState.gameTimeLimitTime}
                            started={rootState.gameTimeLimitStarted}
                            startedAt={rootState.gameTimeLimitStartedAt}
                            paused={!!rootState.winner}
                        />
                    ) : null}

                    {winnerBanner}

                    {/* Opponent */}
                    {opponent ? (
                        <PlayerHud
                            player={opponent}
                            active={!!opponent.activePlayer}
                            onPilePress={(pile) => setPileView({ player: 'opponent', pile })}
                            onTokenPress={setZoomCard}
                        />
                    ) : null}
                    {showProphecies && opponent ? (
                        <ProphecyStrip
                            cards={opponent.prophecyCards}
                            isMine={false}
                            manualMode={!!rootState.manualMode}
                            onSelect={onProphecySelect}
                            onOpen={(card) =>
                                setProphecyView({ uuid: String(card.uuid), mine: false })
                            }
                            onZoom={setZoomCard}
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
                        // A spectator is not "you" — they get both players named.
                        me={isSpectator ? undefined : perspective.name}
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
                    {showProphecies ? (
                        <ProphecyStrip
                            cards={perspective.prophecyCards}
                            isMine={!isSpectator}
                            manualMode={!!rootState.manualMode}
                            onSelect={onProphecySelect}
                            onOpen={(card) =>
                                setProphecyView({ uuid: String(card.uuid), mine: true })
                            }
                            onZoom={setZoomCard}
                        />
                    ) : null}
                    <PlayerHud
                        player={perspective}
                        isMe={!isSpectator}
                        active={!!perspective.activePlayer}
                        onPilePress={(pile) => setPileView({ player: 'me', pile })}
                        onTokenPress={setZoomCard}
                    />

                    {/* Hand */}
                    <DropZone name='hand'>
                        {handHidden ? (
                            /* Not unmounted, just stood down: the count is
                               still there, and one tap brings the cards back
                               for the rest of the opponent's turn. A hidden
                               hand you cannot look at would be a worse
                               distraction than the one this setting is for. */
                            <Pressable
                                onPress={() => {
                                    tapFeedback();
                                    setPeekingHand(true);
                                }}
                                style={({ pressed }) => [
                                    styles.handStrip,
                                    styles.handStripEmpty,
                                    styles.handHidden,
                                    pressed && { opacity: 0.7 }
                                ]}
                                accessibilityRole='button'
                                accessibilityLabel='Show my hand'
                            >
                                <Text style={styles.handHiddenText}>
                                    Hand hidden · {hand.length} card
                                    {hand.length === 1 ? '' : 's'}
                                </Text>
                                <Text style={styles.handHiddenHint}>Tap to look</Text>
                            </Pressable>
                        ) : hand.length > 0 ? (
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
                                        {groupIndex > 0 ? (
                                            <View style={styles.handDivider} />
                                        ) : null}
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
                                        <Text style={styles.handLegendCount}>
                                            {group.cards.length}
                                        </Text>
                                    </View>
                                ))}
                            </View>
                        ) : null}
                    </DropZone>

                    {/* The log is the board's only native presentation, and it
                        never has anything else open over or under it. */}
                    <LogSheet
                        visible={logOpen}
                        messages={rootState.messages ?? []}
                        onClose={() => setLogOpen(false)}
                        onSend={(text) => sendGameMessage('chat', text)}
                        onCardPress={onLogCardPress}
                        onReport={opponent?.name ? () => setReporting(true) : undefined}
                        opponentName={opponent?.name}
                    />

                    {/* Reachable from the chat sheet itself and from the game
                        menu - Guideline 1.2 asks for it where the content is. */}
                    {opponent?.name ? (
                        <ReportPlayerSheet
                            onClose={() => setReporting(false)}
                            username={opponent.name}
                            visible={reporting}
                        />
                    ) : null}
                </DragDropProvider>
            </SafeAreaView>

            {/* ARCHON: everything else the board puts over itself — a pile, a
                card menu, a prophecy, a zoom — is a plain sibling overlay
                rather than a native Modal, and they are ordered here so a zoom
                opened from any of them lands on top.

                Native modals stacked over each other and then unwound out of
                order leave iOS with an orphaned presentation that swallows
                every touch, which is what made opening an opponent's discard
                pile able to freeze the app. There is nothing to orphan here.

                Outside the SafeAreaView so they cover the notch and the home
                indicator too. */}
            {pileView ? (
                <PileViewer
                    title={`${
                        pileView.player === 'me' ? perspective.name : opponent?.name ?? 'Opponent'
                    } · ${pileView.pile.charAt(0).toUpperCase()}${pileView.pile.slice(1)}`}
                    cards={pileCards}
                    onClose={() => setPileView(undefined)}
                    onCardZoom={setZoomCard}
                    onCardSelect={
                        isSpectator
                            ? undefined
                            : (card) => {
                                  sendGameMessage('cardClicked', card.uuid);
                                  setPileView(undefined);
                              }
                    }
                />
            ) : null}

            {menuCard ? (
                <CardMenuSheet
                    card={menuCard}
                    onClose={() => setMenuCard(undefined)}
                    onItem={onMenuItem}
                    onZoom={setZoomCard}
                />
            ) : null}

            {prophecyCard ? (
                <ProphecySheet
                    card={prophecyCard}
                    cards={prophecyOwner?.prophecyCards}
                    isMine={!!prophecyView?.mine && !isSpectator}
                    manualMode={!!rootState.manualMode}
                    onClose={() => setProphecyView(undefined)}
                    onActivate={onProphecyActivate}
                    onMenuItem={onProphecyMenuItem}
                    onZoom={setZoomCard}
                />
            ) : null}

            {zoomCard ? (
                <View style={styles.zoomLayer}>
                    <CardZoomOverlay card={zoomCard} onClose={() => setZoomCard(undefined)} />
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    // Above every other overlay (pile, card menu, prophecy), which sit at 20.
    zoomLayer: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 30,
        elevation: 30
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
    handHidden: {
        gap: 2,
        paddingVertical: 10,
        borderTopColor: colors.borderLight,
        borderStyle: 'dashed'
    },
    handHiddenText: {
        color: colors.textDim,
        fontSize: 13,
        fontWeight: '700'
    },
    handHiddenHint: {
        color: colors.textFaint,
        fontSize: 10
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
