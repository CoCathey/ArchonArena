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
import DeckPreviewModal from '../src/decks/DeckPreviewModal';
import DeckRow from '../src/decks/DeckRow';
import { useDeckLibrary } from '../src/decks/useDeckLibrary';
import { lobby } from '../src/net/lobbySocket';
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

    // The collection pages in from the server (search/sort/house filter all run
    // there), so every deck is reachable rather than just the first page.
    const library = useDeckLibrary({ pageSize: 30, enabled: deckModal });

    // Handoff arrives when the owner starts the game: open the board.
    useEffect(() => {
        if (handoff && !navigatedToGame.current) {
            navigatedToGame.current = true;
            router.replace('/game');
        }
    }, [handoff]);

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
    const everyoneReady =
        players.length === 2 && players.every((player) => player.deck?.selected);
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
                <Text style={styles.gameMeta}>
                    {currentGame.gameFormat && currentGame.gameFormat !== 'normal'
                        ? currentGame.gameFormat
                        : 'Archon'}
                </Text>

                <ErrorBanner message={gameError} />

                {players.map((player) => (
                    <Card key={player.name} style={styles.playerRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.playerName}>
                                {player.name}
                                {player.owner ? '  ⭐' : ''}
                            </Text>
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
                                        : 'Choosing a deck…'}
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
                        {player.name === username ? (
                            <Button small variant='secondary' title='Select deck' onPress={openDeckModal} />
                        ) : null}
                    </Card>
                ))}
                {players.length < 2 ? (
                    <Card style={styles.playerRow}>
                        <Text style={styles.waiting}>Waiting for an opponent to join…</Text>
                    </Card>
                ) : null}

                <View style={styles.actionRow}>
                    {isOwner ? (
                        <Button
                            title={everyoneReady ? 'Start game' : 'Waiting for decks…'}
                            disabled={!everyoneReady}
                            onPress={() => lobby.startGame(currentGame.id)}
                            style={{ flex: 1 }}
                        />
                    ) : (
                        <Text style={styles.waiting}>
                            {iAmSpectator
                                ? 'Spectating — the game will open when it starts.'
                                : everyoneReady
                                ? 'Waiting for the host to start the game…'
                                : 'Waiting for everyone to pick decks…'}
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
                <View style={[styles.modalContainer, { paddingTop: insets.top + 12 }]}>
                    <View style={styles.modalHeader}>
                        <Text style={styles.modalTitle}>Choose a deck</Text>
                        <Button small variant='secondary' title='Close' onPress={() => setDeckModal(false)} />
                    </View>
                    <View style={styles.deckTabs}>
                        <Pressable
                            style={[styles.deckTabButton, deckTab === 'mine' && styles.deckTabActive]}
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
                                            deckTab === 'mine' ? library.refresh : loadStandalone
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
            </Modal>

            <DeckPreviewModal
                deck={previewDeck}
                onClose={() => setPreviewDeck(undefined)}
                confirmLabel='Play this deck'
                onConfirm={(deck) => pickDeck(deck, deckTab === 'standalone')}
            />
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
        marginTop: 2,
        marginBottom: spacing.md,
        textTransform: 'capitalize'
    },
    playerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: spacing.sm,
        gap: spacing.md
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
