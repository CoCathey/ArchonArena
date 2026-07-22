import React, { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import {
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
import type { Deck } from '../src/api/types';
import { fetchDecks, fetchStandaloneDecks } from '../src/api/client';
import { lobby } from '../src/net/lobbySocket';
import { useAuthStore } from '../src/stores/authStore';
import { useGameStore } from '../src/stores/gameStore';
import { useLobbyStore } from '../src/stores/lobbyStore';
import { colors, radius, spacing } from '../src/theme';
import { LogLine } from '../src/game/LogMessages';
import HouseIcon from '../src/ui/HouseIcon';
import { Button, Card, EmptyState, ErrorBanner, TextField } from '../src/ui/primitives';

function DeckPickRow(props: { deck: Deck; onPick: () => void }) {
    const sas = props.deck.dokStats?.sas;
    return (
        <Pressable onPress={props.onPick} style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
            <Card style={styles.deckPickRow}>
                <View style={{ flex: 1 }}>
                    <Text style={styles.deckPickName} numberOfLines={1}>
                        {props.deck.name}
                    </Text>
                    <View style={styles.deckPickMeta}>
                        {(props.deck.houses ?? []).map((house) => (
                            <HouseIcon key={house} house={house} size={18} />
                        ))}
                        {typeof sas === 'number' ? (
                            <Text style={styles.deckPickSas}>{Math.round(sas)} SAS</Text>
                        ) : null}
                    </View>
                </View>
            </Card>
        </Pressable>
    );
}

export default function PendingGameScreen() {
    const currentGame = useLobbyStore((state) => state.currentGame);
    const gameError = useLobbyStore((state) => state.gameError);
    const handoff = useGameStore((state) => state.handoff);
    const username = useAuthStore((state) => state.user?.username);

    const [deckModal, setDeckModal] = useState(false);
    const [deckTab, setDeckTab] = useState<'mine' | 'standalone'>('mine');
    const [myDecks, setMyDecks] = useState<Deck[]>([]);
    const [standaloneDecks, setStandaloneDecks] = useState<Deck[]>([]);
    const [loadingDecks, setLoadingDecks] = useState(false);
    const [chatText, setChatText] = useState('');
    const navigatedToGame = useRef(false);

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

    const openDeckModal = async () => {
        setDeckModal(true);
        setLoadingDecks(true);
        try {
            const [mine, standalone] = await Promise.all([
                fetchDecks({ pageSize: 100 }).catch(() => ({ decks: [] as Deck[] })),
                fetchStandaloneDecks().catch(() => ({ decks: [] as Deck[] }))
            ]);
            setMyDecks(mine.decks ?? []);
            setStandaloneDecks(standalone.decks ?? []);
            if ((mine.decks ?? []).length === 0 && (standalone.decks ?? []).length > 0) {
                setDeckTab('standalone');
            }
        } finally {
            setLoadingDecks(false);
        }
    };

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
            keyboardVerticalOffset={90}
        >
            <ScrollView contentContainerStyle={{ padding: spacing.md }}>
                <Text style={styles.gameName}>{currentGame.name}</Text>
                <Text style={styles.gameMeta}>
                    {String(currentGame.gameType ?? 'casual')}
                    {currentGame.gameFormat && currentGame.gameFormat !== 'normal'
                        ? ` · ${currentGame.gameFormat}`
                        : ''}
                </Text>

                <ErrorBanner message={gameError} />

                {players.map((player) => (
                    <Card key={player.name} style={styles.playerRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.playerName}>
                                {player.name}
                                {player.owner ? '  ⭐' : ''}
                            </Text>
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
                            <LogLine key={index} message={message} onCardPress={() => {}} />
                        ))}
                    </View>
                ) : null}
            </ScrollView>

            <View style={styles.chatInputRow}>
                <TextField
                    placeholder='Say something…'
                    value={chatText}
                    onChangeText={setChatText}
                    containerStyle={{ flex: 1, marginBottom: 0 }}
                    onSubmitEditing={sendChat}
                    returnKeyType='send'
                />
                <Button small title='Send' onPress={sendChat} />
            </View>

            <Modal
                visible={deckModal}
                animationType='slide'
                onRequestClose={() => setDeckModal(false)}
            >
                <View style={styles.modalContainer}>
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
                    <FlatList
                        data={deckTab === 'mine' ? myDecks : standaloneDecks}
                        keyExtractor={(deck) => `${deckTab}-${deck.id}`}
                        renderItem={({ item }) => (
                            <DeckPickRow
                                deck={item}
                                onPick={() => pickDeck(item, deckTab === 'standalone')}
                            />
                        )}
                        contentContainerStyle={{ padding: spacing.md }}
                        ListEmptyComponent={
                            <EmptyState
                                title={loadingDecks ? 'Loading decks…' : 'No decks'}
                                subtitle={
                                    deckTab === 'mine'
                                        ? 'Import decks in the Decks tab first, or use a standalone deck.'
                                        : undefined
                                }
                            />
                        }
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
    deckStatus: {
        color: colors.textDim,
        fontSize: 13,
        marginTop: 3
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
        backgroundColor: colors.bg,
        paddingTop: 60
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
    deckPickRow: {
        marginBottom: spacing.sm
    },
    deckPickName: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700'
    },
    deckPickMeta: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 6
    },
    deckPickSas: {
        color: colors.brand,
        fontSize: 12,
        fontWeight: '700',
        marginLeft: 6
    }
});
