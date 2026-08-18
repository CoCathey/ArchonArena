import React, { useEffect, useMemo, useRef, useState } from 'react';
import { router } from 'expo-router';
import {
    ActivityIndicator,
    FlatList,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Deck } from '../src/api/types';
import { fetchStandaloneDecks } from '../src/api/client';
import DeckFilterBar from '../src/decks/DeckFilterBar';
import DeckPreview from '../src/decks/DeckPreview';
import DeckRow from '../src/decks/DeckRow';
import { useDeckLibrary } from '../src/decks/useDeckLibrary';
import { ReportPlayerButton } from '../src/safety/ReportPlayerSheet';
import { formatLabel, isUnchainedFormat } from '../src/game/gameFormats';
import {
    allPlayersReady,
    choosesOwnDeck as gameChoosesOwnDeck,
    deckStatusLabel,
    isLuckyDiceGame,
    isSealedGame,
    startHint
} from '../src/game/pendingGame';
import { lobby } from '../src/net/lobbySocket';
import BotTableControls from '../src/lobby/BotTableControls';
import { useAuthStore } from '../src/stores/authStore';
import { useGameStore } from '../src/stores/gameStore';
import { useLobbyStore } from '../src/stores/lobbyStore';
import { colors, radius, spacing } from '../src/theme';
import { LogLine } from '../src/game/LogMessages';
import { Button, Card, EmptyState, ErrorBanner, TextField } from '../src/ui/primitives';

export default function PendingGameScreen() {
    const currentGame = useLobbyStore((state) => state.currentGame);
    const gameError = useLobbyStore((state) => state.gameError);
    const handoff = useGameStore((state) => state.handoff);
    const username = useAuthStore((state) => state.user?.username);

    const [deckModal, setDeckModal] = useState(false);
    const [deckTab, setDeckTab] = useState<'mine' | 'standalone'>('mine');
    const [standaloneDecks, setStandaloneDecks] = useState<Deck[]>([]);
    const [standaloneSearch, setStandaloneSearch] = useState('');
    const [standaloneHouses, setStandaloneHouses] = useState<string[]>([]);
    const [loadingStandalone, setLoadingStandalone] = useState(false);
    const [deckError, setDeckError] = useState<string | undefined>();
    const [previewDeck, setPreviewDeck] = useState<Deck | undefined>();
    const [chatText, setChatText] = useState('');
    const navigatedToGame = useRef(false);
    const insets = useSafeAreaInsets();

    const gameFormat = currentGame?.gameFormat ?? 'normal';
    // Sealed hands both players a generated deck; Lucky Dice rolls one for each
    // of them when the owner starts. Neither has anything to pick.
    const isSealed = isSealedGame(currentGame);
    const isLuckyDice = isLuckyDiceGame(currentGame);
    const sasBound = currentGame?.sasBound;
    const choosesOwnDeck = gameChoosesOwnDeck(currentGame);

    // The collection pages in from the server (search/sort/house filter all run
    // there), so every deck is reachable rather than just the first page. The
    // picker also applies the game's own rules — alliance decks are legal in an
    // alliance game and only there, and a SAS bound hides what it would refuse
    // — so it never offers a deck the game would reject.
    const library = useDeckLibrary({
        pageSize: 30,
        enabled: deckModal,
        isAlliance: gameFormat === 'alliance',
        sasMin: sasBound?.min,
        sasMax: sasBound?.max,
        // Always one or the other, never absent: Unchained decks are legal in
        // an Unchained game and nowhere else, so "no opinion" would offer decks
        // the server is about to refuse.
        unchained: isUnchainedFormat(gameFormat)
    });

    // Handoff arrives when the owner starts the game: open the board.
    useEffect(() => {
        if (handoff && !navigatedToGame.current) {
            navigatedToGame.current = true;
            router.replace('/game');
        }
    }, [handoff]);

    // A sealed game has no deck to choose: ask the lobby to deal one as soon
    // as we arrive, the same as the web pending screen does.
    const sealedRequested = useRef(false);
    useEffect(() => {
        if (isSealed && currentGame && !sealedRequested.current) {
            sealedRequested.current = true;
            lobby.getSealedDeck(currentGame.id);
        }
    }, [currentGame, isSealed]);

    // If the pending game disappears (we left / it timed out), close.
    useEffect(() => {
        if (!currentGame && !navigatedToGame.current) {
            if (router.canGoBack()) {
                router.back();
            } else {
                router.replace('/(tabs)');
            }
        }
    }, [currentGame]);

    const loadStandalone = async () => {
        setLoadingStandalone(true);
        setDeckError(undefined);
        try {
            const result = await fetchStandaloneDecks();
            setStandaloneDecks(result.decks ?? []);
        } catch (err) {
            setDeckError(
                err instanceof Error ? err.message : 'Could not load the standalone decks.'
            );
        } finally {
            setLoadingStandalone(false);
        }
    };

    const openDeckModal = () => {
        setDeckModal(true);
        loadStandalone();
    };

    // Standalone decks are a short fixed list served whole, so their search and
    // house filter are applied here rather than by the server.
    const visibleStandalone = useMemo(() => {
        const term = standaloneSearch.trim().toLowerCase();
        return standaloneDecks.filter((deck) => {
            if (term && !deck.name.toLowerCase().includes(term)) {
                return false;
            }
            return standaloneHouses.every((house) => (deck.houses ?? []).includes(house));
        });
    }, [standaloneDecks, standaloneHouses, standaloneSearch]);

    if (!currentGame) {
        return <View style={styles.container} />;
    }

    const players = Object.values(currentGame.players ?? {});
    const me = players.find((player) => player.name === username);
    const isOwner =
        typeof currentGame.owner === 'string'
            ? currentGame.owner === username
            : currentGame.owner?.username === username;
    // Lucky Dice games start deckless — the lobby rolls both decks when the
    // owner presses Start — so readiness cannot be "everyone holds a deck".
    const everyoneReady = allPlayersReady(currentGame);
    const iAmSpectator = !me;

    const pickDeck = (deck: Deck, standalone: boolean) => {
        lobby.selectDeck(currentGame.id, deck.id, standalone);
        setPreviewDeck(undefined);
        setDeckModal(false);
    };

    const sendChat = () => {
        if (chatText.trim()) {
            lobby.pendingChat(chatText.trim());
            setChatText('');
        }
    };

    const messages = currentGame.messages ?? [];

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.container}
            keyboardVerticalOffset={insets.top + 44}
        >
            <ScrollView contentContainerStyle={{ padding: spacing.md }}>
                <Text style={styles.gameName}>{currentGame.name}</Text>
                <View style={styles.gameMetaRow}>
                    <Text style={styles.gameMeta}>{formatLabel(currentGame.gameFormat)}</Text>
                    {isLuckyDice ? <Text style={styles.ruleBadge}>🎲 Lucky Dice</Text> : null}
                    {sasBound ? (
                        <Text style={styles.ruleBadge}>
                            SAS {sasBound.min}–{sasBound.max}
                        </Text>
                    ) : null}
                </View>
                {isLuckyDice ? (
                    <Text style={styles.ruleHint}>
                        Both players are dealt a random deck from their collection when the game
                        starts.
                    </Text>
                ) : null}
                {sasBound ? (
                    <Text style={styles.ruleHint}>
                        Only decks rated between {sasBound.min} and {sasBound.max} SAS can be
                        played.
                    </Text>
                ) : null}

                <ErrorBanner message={gameError} />

                {players.map((player) => (
                    <Card key={player.name} style={styles.playerRow}>
                        <View style={{ flex: 1 }}>
                            <View style={styles.playerNameRow}>
                                <Text style={styles.playerName}>
                                    {player.name}
                                    {player.owner ? '  ⭐' : ''}
                                </Text>
                                {/* ARCHON: Guideline 1.2 - reporting and
                                    blocking have to be reachable where the chat
                                    is, which is here and in the game itself.
                                    Not offered against yourself. */}
                                {player.name !== username ? (
                                    <ReportPlayerButton username={player.name} />
                                ) : null}
                            </View>
                            <View style={styles.deckStatusRow}>
                                <Text
                                    style={[
                                        styles.deckStatus,
                                        player.deck?.selected && { color: '#7ed494' }
                                    ]}
                                    numberOfLines={1}
                                >
                                    {player.deck?.selected
                                        ? player.name === username && player.deck.name
                                            ? player.deck.name
                                            : 'Deck selected'
                                        : deckStatusLabel(currentGame)}
                                </Text>
                                {/* The server sends the opponent's SAS too, unless
                                    the game hides decklists. */}
                                {typeof player.deck?.sasRating === 'number' ? (
                                    <Text style={styles.deckSas}>
                                        {Math.round(player.deck.sasRating)} SAS
                                    </Text>
                                ) : null}
                            </View>
                        </View>
                        {player.name === username && choosesOwnDeck ? (
                            <View style={styles.seatActions}>
                                <Button
                                    small
                                    variant='secondary'
                                    title='Select deck'
                                    onPress={openDeckModal}
                                />
                                {/* Rolled server side: it draws from the whole
                                    collection, which the app only ever holds a
                                    page of. */}
                                <Button
                                    small
                                    variant='ghost'
                                    title='🎲 Lucky Dice'
                                    onPress={() => lobby.selectRandomDeck(currentGame.id)}
                                />
                            </View>
                        ) : null}
                    </Card>
                ))}
                {players.length < 2 ? (
                    <Card style={styles.playerRow}>
                        <Text style={styles.waiting}>Waiting for an opponent to join…</Text>
                    </Card>
                ) : null}

                {/* ARCHON (F9/N31): who you are practising against, and how
                    hard. Above the start button because both settings stop
                    meaning anything the moment the game starts. */}
                <BotTableControls game={currentGame} seated={!iAmSpectator} />

                <View style={styles.actionRow}>
                    {isOwner ? (
                        <View style={{ flex: 1 }}>
                            <Button
                                title={
                                    everyoneReady
                                        ? isLuckyDice
                                            ? '🎲 Roll decks & start'
                                            : 'Start game'
                                        : 'Waiting…'
                                }
                                disabled={!everyoneReady}
                                onPress={() => lobby.startGame(currentGame.id)}
                            />
                            <Text style={styles.startHint}>{startHint(currentGame)}</Text>
                        </View>
                    ) : (
                        <Text style={styles.waiting}>
                            {iAmSpectator
                                ? 'Spectating — the game will open when it starts.'
                                : everyoneReady
                                ? 'Waiting for the host to start the game…'
                                : startHint(currentGame)}
                        </Text>
                    )}
                </View>
                <Button
                    variant='danger'
                    title='Leave game'
                    onPress={() => {
                        lobby.leaveGame(currentGame.id);
                    }}
                />

                {messages.length > 0 ? (
                    <View style={styles.chatBox}>
                        {messages.slice(-30).map((message, index) => (
                            <LogLine
                                key={String(message.date ?? index)}
                                message={message}
                                onCardPress={() => {}}
                            />
                        ))}
                    </View>
                ) : null}
            </ScrollView>

            <View
                style={[
                    styles.chatInputRow,
                    { paddingBottom: Math.max(insets.bottom, spacing.md) }
                ]}
            >
                <TextField
                    placeholder='Say something…'
                    value={chatText}
                    onChangeText={setChatText}
                    containerStyle={{ flex: 1, marginBottom: 0 }}
                    onSubmitEditing={sendChat}
                    returnKeyType='send'
                    autoCapitalize='sentences'
                />
                <Button small title='Send' onPress={sendChat} />
            </View>

            <Modal
                visible={deckModal}
                animationType='slide'
                onRequestClose={() => setDeckModal(false)}
            >
                <View style={styles.modalContainer}>
                    <View style={{ flex: 1, paddingTop: insets.top + 12 }}>
                        <View style={styles.modalHeader}>
                            <Text style={styles.modalTitle}>Choose a deck</Text>
                            <Button
                                small
                                variant='secondary'
                                title='Close'
                                onPress={() => setDeckModal(false)}
                            />
                        </View>
                        <View style={styles.deckTabs}>
                            <Pressable
                                style={[
                                    styles.deckTabButton,
                                    deckTab === 'mine' && styles.deckTabActive
                                ]}
                                onPress={() => setDeckTab('mine')}
                            >
                                <Text
                                    style={[
                                        styles.deckTabText,
                                        deckTab === 'mine' && styles.deckTabTextActive
                                    ]}
                                >
                                    My decks
                                </Text>
                            </Pressable>
                            <Pressable
                                style={[
                                    styles.deckTabButton,
                                    deckTab === 'standalone' && styles.deckTabActive
                                ]}
                                onPress={() => setDeckTab('standalone')}
                            >
                                <Text
                                    style={[
                                        styles.deckTabText,
                                        deckTab === 'standalone' && styles.deckTabTextActive
                                    ]}
                                >
                                    Standalone
                                </Text>
                            </Pressable>
                        </View>

                        {deckTab === 'mine' ? (
                            <DeckFilterBar
                                search={library.searchInput}
                                onSearchChange={library.setSearchInput}
                                sort={library.sort}
                                onSortChange={library.setSort}
                                houses={library.houses}
                                onToggleHouse={library.toggleHouse}
                                onClear={library.clearFilters}
                                summary={
                                    library.filtered
                                        ? `${library.decks.length} of ${library.total} shown`
                                        : library.total > 0
                                        ? `${library.total} deck${library.total === 1 ? '' : 's'}`
                                        : undefined
                                }
                            />
                        ) : (
                            <DeckFilterBar
                                search={standaloneSearch}
                                onSearchChange={setStandaloneSearch}
                                sort={library.sort}
                                onSortChange={library.setSort}
                                houses={standaloneHouses}
                                onToggleHouse={(house) =>
                                    setStandaloneHouses((previous) =>
                                        previous.includes(house)
                                            ? previous.filter((entry) => entry !== house)
                                            : previous.concat(house)
                                    )
                                }
                                onClear={() => {
                                    setStandaloneSearch('');
                                    setStandaloneHouses([]);
                                }}
                            />
                        )}

                        <FlatList
                            data={deckTab === 'mine' ? library.decks : visibleStandalone}
                            keyExtractor={(deck) => `${deckTab}-${deck.id}`}
                            keyboardShouldPersistTaps='handled'
                            keyboardDismissMode='on-drag'
                            renderItem={({ item }) => (
                                <DeckRow
                                    deck={item}
                                    onPress={() => setPreviewDeck(item)}
                                    accessory={
                                        <View style={styles.deckRowActions}>
                                            <Button
                                                small
                                                variant='secondary'
                                                title='View'
                                                onPress={() => setPreviewDeck(item)}
                                            />
                                            <Button
                                                small
                                                title='Select'
                                                onPress={() =>
                                                    pickDeck(item, deckTab === 'standalone')
                                                }
                                            />
                                        </View>
                                    }
                                />
                            )}
                            contentContainerStyle={{
                                padding: spacing.md,
                                paddingBottom: insets.bottom + spacing.md
                            }}
                            onEndReached={deckTab === 'mine' ? library.loadMore : undefined}
                            onEndReachedThreshold={0.5}
                            ListFooterComponent={
                                deckTab === 'mine' && library.loadingMore ? (
                                    <ActivityIndicator
                                        color={colors.brand}
                                        style={{ marginVertical: 16 }}
                                    />
                                ) : deckTab === 'mine' && library.hasMore ? (
                                    <Button
                                        variant='secondary'
                                        title={`Load more (${
                                            library.total - library.decks.length
                                        } left)`}
                                        onPress={library.loadMore}
                                    />
                                ) : null
                            }
                            ListEmptyComponent={
                                (deckTab === 'mine' ? library.loading : loadingStandalone) ? (
                                    <ActivityIndicator
                                        color={colors.brand}
                                        style={{ marginTop: spacing.xl }}
                                    />
                                ) : (deckTab === 'mine' ? library.error : deckError) ? (
                                    <View style={{ padding: spacing.md }}>
                                        <ErrorBanner
                                            message={deckTab === 'mine' ? library.error : deckError}
                                        />
                                        <Button
                                            variant='secondary'
                                            title='Retry'
                                            onPress={
                                                deckTab === 'mine'
                                                    ? library.refresh
                                                    : loadStandalone
                                            }
                                        />
                                    </View>
                                ) : (
                                    <EmptyState
                                        title='No decks'
                                        subtitle={
                                            deckTab === 'mine'
                                                ? 'Import decks in the Decks tab first, or use a standalone deck.'
                                                : undefined
                                        }
                                    />
                                )
                            }
                        />
                    </View>

                    {/* Rendered inside the picker rather than as a modal of
                        its own — see the note on DeckPreview. Sits outside the
                        padded column so it covers the whole screen. */}
                    <DeckPreview
                        deck={previewDeck}
                        onClose={() => setPreviewDeck(undefined)}
                        confirmLabel='Play this deck'
                        onConfirm={(deck) => pickDeck(deck, deckTab === 'standalone')}
                    />
                </View>
            </Modal>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    gameName: {
        color: colors.text,
        fontSize: 22,
        fontWeight: '800'
    },
    gameMeta: {
        color: colors.textDim,
        fontSize: 13,
        fontWeight: '600'
    },
    playerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: spacing.sm,
        gap: spacing.md
    },
    playerNameRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm
    },
    playerName: {
        color: colors.text,
        fontSize: 16,
        fontWeight: '700'
    },
    deckStatusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginTop: 3
    },
    deckStatus: {
        color: colors.textDim,
        fontSize: 13,
        flexShrink: 1
    },
    deckSas: {
        color: colors.brand,
        fontSize: 12,
        fontWeight: '800'
    },
    gameMetaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: spacing.sm,
        marginTop: 2,
        marginBottom: spacing.sm
    },
    ruleBadge: {
        color: colors.brand,
        fontSize: 11,
        fontWeight: '800',
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: 9,
        paddingVertical: 3,
        overflow: 'hidden'
    },
    ruleHint: {
        color: colors.textFaint,
        fontSize: 11,
        lineHeight: 15,
        marginBottom: spacing.sm
    },
    seatActions: {
        gap: 4
    },
    waiting: {
        color: colors.textDim,
        fontSize: 14,
        textAlign: 'center',
        flex: 1
    },
    actionRow: {
        flexDirection: 'row',
        marginTop: spacing.md,
        marginBottom: spacing.sm
    },
    startHint: {
        color: colors.textFaint,
        fontSize: 11,
        textAlign: 'center',
        marginTop: 5
    },
    chatBox: {
        backgroundColor: colors.bgElevated,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        marginTop: spacing.lg,
        paddingVertical: spacing.sm
    },
    chatInputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        padding: spacing.md,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.bgElevated
    },
    modalContainer: {
        flex: 1,
        backgroundColor: colors.bg
    },
    modalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.lg,
        marginBottom: spacing.sm
    },
    modalTitle: {
        color: colors.text,
        fontSize: 20,
        fontWeight: '800'
    },
    deckTabs: {
        flexDirection: 'row',
        marginHorizontal: spacing.lg,
        backgroundColor: colors.bgElevated,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        overflow: 'hidden'
    },
    deckTabButton: {
        flex: 1,
        alignItems: 'center',
        paddingVertical: 9
    },
    deckTabActive: {
        backgroundColor: colors.brand
    },
    deckTabText: {
        color: colors.textDim,
        fontWeight: '600',
        fontSize: 13
    },
    deckTabTextActive: {
        color: '#161006'
    },
    deckRowActions: {
        gap: 6
    }
});
