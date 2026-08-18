import React, { useEffect, useRef, useState } from 'react';
import { router, usePathname } from 'expo-router';
import {
    FlatList,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    RefreshControl,
    StyleSheet,
    Text,
    View
} from 'react-native';
import type { GameSummary } from '../../src/api/types';
import { formatLabel } from '../../src/game/gameFormats';
import { connectLobby, lobby } from '../../src/net/lobbySocket';
import { useAuthStore } from '../../src/stores/authStore';
import { useGameStore } from '../../src/stores/gameStore';
import { useLobbyStore } from '../../src/stores/lobbyStore';
import LobbyChatSheet from '../../src/lobby/LobbyChatSheet';
import QuickMatchPanel from '../../src/lobby/QuickMatchPanel';
import {
    applyGameFilters,
    DEFAULT_GAME_FILTERS,
    FILTERABLE_FORMATS,
    filtersAreDefault,
    type GameFilterState
} from '../../src/lobby/gameFilters';
import { colors, radius, spacing } from '../../src/theme';
import { Badge, Button, Card, EmptyState, ErrorBanner, TextField } from '../../src/ui/primitives';

function playerLine(game: GameSummary): string {
    const players = Object.values(game.players ?? {});
    if (players.length === 0) {
        return 'Empty';
    }
    if (players.length === 1) {
        return `${players[0].name} waits for an opponent`;
    }
    return players.map((player) => player.name).join('  vs  ');
}

function GameRow(props: {
    game: GameSummary;
    username?: string;
    onJoin: (game: GameSummary) => void;
    onWatch: (game: GameSummary) => void;
    onRejoin: (game: GameSummary) => void;
}) {
    const { game, username } = props;
    const players = Object.values(game.players ?? {});
    const isMine = players.some((player) => player.name === username);
    const joinable = !game.started && players.length < 2 && !isMine;
    const watchable = game.allowSpectators && !isMine;

    return (
        <Card style={styles.gameRow}>
            <View style={{ flex: 1 }}>
                <Text style={styles.gameName} numberOfLines={1}>
                    {game.name}
                </Text>
                <Text style={styles.gamePlayers} numberOfLines={1}>
                    {playerLine(game)}
                </Text>
                <View style={styles.badgeRow}>
                    {game.started ? <Badge text='In progress' color='#274a33' textColor='#7ed494' /> : null}
                    {game.gameFormat && game.gameFormat !== 'normal' ? (
                        // 'adaptive-bo1' is an engine name, not something to
                        // put in front of a player.
                        <Badge text={formatLabel(game.gameFormat)} />
                    ) : null}
                    {game.luckyDice ? <Badge text='🎲 lucky dice' /> : null}
                    {game.sasBound ? (
                        <Badge text={`SAS ${game.sasBound.min}–${game.sasBound.max}`} />
                    ) : null}
                    {game.needsPassword ? <Badge text='🔒 password' /> : null}
                    {game.showHand ? <Badge text='open hands' /> : null}
                </View>
            </View>
            <View style={styles.gameActions}>
                {isMine ? (
                    <Button small title='Rejoin' onPress={() => props.onRejoin(game)} />
                ) : joinable ? (
                    <Button small title='Join' onPress={() => props.onJoin(game)} />
                ) : null}
                {!game.started && !joinable && !isMine ? (
                    <Badge text='Full' />
                ) : null}
                {watchable && game.started ? (
                    <Button
                        small
                        variant='secondary'
                        title='Watch'
                        onPress={() => props.onWatch(game)}
                    />
                ) : null}
            </View>
        </Card>
    );
}

export default function PlayScreen() {
    const status = useLobbyStore((state) => state.status);
    const games = useLobbyStore((state) => state.games);
    const currentGame = useLobbyStore((state) => state.currentGame);
    const gameError = useLobbyStore((state) => state.gameError);
    const passwordError = useLobbyStore((state) => state.passwordError);
    const banner = useLobbyStore((state) => state.banner);
    const handoff = useGameStore((state) => state.handoff);
    const username = useAuthStore((state) => state.user?.username);

    const [passwordGame, setPasswordGame] = useState<
        { game: GameSummary; mode: 'join' | 'watch' } | undefined
    >();
    const [password, setPassword] = useState('');
    const [refreshing, setRefreshing] = useState(false);
    const [quickMatchOpen, setQuickMatchOpen] = useState(false);
    const [chatOpen, setChatOpen] = useState(false);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [filters, setFilters] = useState<GameFilterState>(DEFAULT_GAME_FILTERS);
    const prevGameId = useRef<string | undefined>(undefined);
    const pathname = usePathname();

    // The game list is live over the socket, but honour a pull-to-refresh:
    // reconnect if we've dropped, and show a brief spinner as acknowledgement.
    const onRefresh = () => {
        setRefreshing(true);
        connectLobby();
        setTimeout(() => setRefreshing(false), 800);
    };

    // When we join a pending game from the lobby, open the pending screen once.
    // Skip when we're on the New game modal (it navigates to pending itself) or
    // already on pending/game, so we never push it twice.
    useEffect(() => {
        if (
            currentGame &&
            !currentGame.started &&
            prevGameId.current !== currentGame.id &&
            pathname !== '/new-game' &&
            pathname !== '/pending' &&
            pathname !== '/game'
        ) {
            prevGameId.current = currentGame.id;
            setPasswordGame(undefined);
            router.push('/pending');
        }
        if (!currentGame) {
            prevGameId.current = undefined;
        }
    }, [currentGame, pathname]);

    // A live handoff means an in-progress game (e.g. resuming one from the
    // lobby): jump straight to the board. When we're on the pending screen,
    // that screen owns the handoff→board transition, so skip it here to avoid
    // pushing the board twice.
    useEffect(() => {
        if (handoff && pathname !== '/pending' && pathname !== '/game') {
            router.push('/game');
        }
    }, [handoff, pathname]);

    const joinWithPassword = (game: GameSummary, mode: 'join' | 'watch') => {
        if (game.needsPassword) {
            setPassword('');
            setPasswordGame({ game, mode });
            return;
        }
        if (mode === 'join') {
            lobby.joinGame(game.id);
        } else {
            lobby.watchGame(game.id);
        }
    };

    const submitPassword = () => {
        if (!passwordGame) {
            return;
        }
        if (passwordGame.mode === 'join') {
            lobby.joinGame(passwordGame.game.id, password);
        } else {
            lobby.watchGame(passwordGame.game.id, password);
        }
    };

    const visible = applyGameFilters(games, filters);
    const openGames = visible.filter((game) => !game.started);
    const runningGames = visible.filter((game) => game.started);
    const ordered = [...openGames, ...runningGames];
    const hidden = games.length - visible.length;

    const toggleFormat = (key: string) =>
        setFilters((current) => ({
            ...current,
            formats: { ...current.formats, [key]: current.formats[key] === false }
        }));

    return (
        <View style={styles.container}>
            <View style={styles.topBar}>
                <View style={styles.statusRow}>
                    <View
                        style={[
                            styles.statusDot,
                            {
                                backgroundColor:
                                    status === 'connected'
                                        ? colors.success
                                        : status === 'connecting'
                                        ? colors.warning
                                        : colors.danger
                            }
                        ]}
                    />
                    <Text style={styles.statusText}>
                        {status === 'connected'
                            ? 'Lobby connected'
                            : status === 'connecting'
                            ? 'Connecting…'
                            : 'Disconnected'}
                    </Text>
                </View>
                <View style={styles.topActions}>
                    <Pressable onPress={() => setChatOpen(true)} hitSlop={8}>
                        <Text style={styles.iconAction}>💬</Text>
                    </Pressable>
                    <Pressable onPress={() => setFiltersOpen((open) => !open)} hitSlop={8}>
                        <Text
                            style={[
                                styles.iconAction,
                                !filtersAreDefault(filters) && { color: colors.brand }
                            ]}
                        >
                            ⚲
                        </Text>
                    </Pressable>
                    <Button
                        small
                        variant='secondary'
                        title='Find match'
                        onPress={() => setQuickMatchOpen(true)}
                    />
                    <Button small title='New game' onPress={() => router.push('/new-game')} />
                </View>
            </View>

            {/* ARCHON: the lobby filters, which the app never had. Collapsed
                by default — at four tables they are noise, and the point of
                them is the day there are forty. */}
            {filtersOpen ? (
                <View style={styles.filterPanel}>
                    <View style={styles.chipRow}>
                        {FILTERABLE_FORMATS.map((format) => {
                            const on = filters.formats[format.key] !== false;

                            return (
                                <Pressable
                                    key={format.key}
                                    onPress={() => toggleFormat(format.key)}
                                    style={[styles.filterChip, on && styles.filterChipOn]}
                                >
                                    <Text
                                        style={[
                                            styles.filterChipText,
                                            on && styles.filterChipTextOn
                                        ]}
                                    >
                                        {format.label}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>
                    <View style={styles.chipRow}>
                        {(
                            [
                                ['onlyOpenSeats', 'Open seats only'],
                                ['hideStarted', 'Hide in progress'],
                                ['hidePractice', 'Hide practice']
                            ] as const
                        ).map(([key, label]) => (
                            <Pressable
                                key={key}
                                onPress={() =>
                                    setFilters((current) => ({ ...current, [key]: !current[key] }))
                                }
                                style={[styles.filterChip, filters[key] && styles.filterChipOn]}
                            >
                                <Text
                                    style={[
                                        styles.filterChipText,
                                        filters[key] && styles.filterChipTextOn
                                    ]}
                                >
                                    {label}
                                </Text>
                            </Pressable>
                        ))}
                    </View>
                    {hidden > 0 ? (
                        <Pressable onPress={() => setFilters(DEFAULT_GAME_FILTERS)}>
                            <Text style={styles.filterSummary}>
                                {hidden} game{hidden === 1 ? '' : 's'} hidden · tap to clear
                            </Text>
                        </Pressable>
                    ) : null}
                </View>
            ) : null}

            {banner ? <ErrorBanner message={banner} /> : null}
            {gameError ? <ErrorBanner message={gameError} /> : null}

            {currentGame ? (
                <Card style={styles.currentGameCard}>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.currentGameLabel}>You are in a game</Text>
                        <Text style={styles.gameName} numberOfLines={1}>
                            {currentGame.name}
                        </Text>
                    </View>
                    <Button
                        small
                        title='Open'
                        onPress={() =>
                            currentGame.started && handoff
                                ? router.push('/game')
                                : router.push('/pending')
                        }
                    />
                </Card>
            ) : null}

            <FlatList
                data={ordered}
                keyExtractor={(game) => game.id}
                renderItem={({ item }) => (
                    <GameRow
                        game={item}
                        username={username}
                        onJoin={(game) => joinWithPassword(game, 'join')}
                        onWatch={(game) => joinWithPassword(game, 'watch')}
                        onRejoin={() => {
                            if (handoff) {
                                router.push('/game');
                            } else {
                                router.push('/pending');
                            }
                        }}
                    />
                )}
                contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={onRefresh}
                        tintColor={colors.textDim}
                    />
                }
                ListEmptyComponent={
                    hidden > 0 ? (
                        <EmptyState
                            title='Every game is filtered out'
                            subtitle={`${hidden} table${
                                hidden === 1 ? '' : 's'
                            } are hidden by your filters.`}
                        />
                    ) : (
                        <EmptyState
                            title='No games right now'
                            subtitle='Create one and invite a friend, or wait for an open table.'
                        />
                    )
                }
            />

            <QuickMatchPanel
                visible={quickMatchOpen}
                onClose={() => setQuickMatchOpen(false)}
            />
            <LobbyChatSheet visible={chatOpen} onClose={() => setChatOpen(false)} />

            <Modal
                visible={!!passwordGame}
                transparent
                animationType='fade'
                onRequestClose={() => setPasswordGame(undefined)}
            >
                <KeyboardAvoidingView
                    style={styles.modalBackdrop}
                    behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                >
                    <View style={styles.modalCard}>
                        <Text style={styles.modalTitle}>
                            {passwordGame?.mode === 'watch' ? 'Watch game' : 'Join game'}
                        </Text>
                        <Text style={styles.modalSubtitle} numberOfLines={1}>
                            {passwordGame?.game.name}
                        </Text>
                        {passwordError ? <ErrorBanner message={passwordError} /> : null}
                        <TextField
                            label='Password'
                            value={password}
                            onChangeText={setPassword}
                            placeholder='Game password'
                            secureTextEntry
                            onSubmitEditing={submitPassword}
                        />
                        <View style={styles.modalActions}>
                            <Button
                                variant='secondary'
                                title='Cancel'
                                onPress={() => setPasswordGame(undefined)}
                            />
                            <Button title='Enter' onPress={submitPassword} />
                        </View>
                    </View>
                </KeyboardAvoidingView>
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4
    },
    statusText: {
        color: colors.textDim,
        fontSize: 12
    },
    iconAction: {
        color: colors.textDim,
        fontSize: 19,
        paddingHorizontal: 2
    },
    filterPanel: {
        paddingHorizontal: spacing.md,
        paddingBottom: spacing.sm,
        gap: spacing.sm
    },
    chipRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6
    },
    filterChip: {
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 5,
        backgroundColor: colors.bgElevated
    },
    filterChipOn: {
        borderColor: colors.brand,
        backgroundColor: colors.surfaceHover
    },
    filterChipText: {
        color: colors.textFaint,
        fontSize: 12,
        fontWeight: '600'
    },
    filterChipTextOn: {
        color: colors.brand
    },
    filterSummary: {
        color: colors.accent,
        fontSize: 11,
        fontWeight: '600'
    },
    topActions: {
        flexDirection: 'row',
        gap: spacing.sm
    },
    currentGameCard: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: spacing.md,
        marginBottom: spacing.sm,
        borderColor: colors.brand,
        gap: spacing.md
    },
    currentGameLabel: {
        color: colors.brand,
        fontSize: 11,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.6
    },
    gameRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: spacing.sm,
        gap: spacing.md
    },
    gameName: {
        color: colors.text,
        fontSize: 16,
        fontWeight: '700'
    },
    gamePlayers: {
        color: colors.textDim,
        fontSize: 13,
        marginTop: 2
    },
    badgeRow: {
        flexDirection: 'row',
        gap: 6,
        marginTop: 8,
        flexWrap: 'wrap'
    },
    gameActions: {
        gap: 6,
        alignItems: 'flex-end'
    },
    modalBackdrop: {
        flex: 1,
        backgroundColor: colors.overlay,
        alignItems: 'center',
        justifyContent: 'center',
        padding: spacing.xl
    },
    modalCard: {
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        padding: spacing.lg,
        width: '100%'
    },
    modalTitle: {
        color: colors.text,
        fontSize: 18,
        fontWeight: '800'
    },
    modalSubtitle: {
        color: colors.textDim,
        fontSize: 13,
        marginBottom: spacing.md,
        marginTop: 2
    },
    modalActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: spacing.sm
    }
});
