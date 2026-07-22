import React, { useEffect, useRef, useState } from 'react';
import { router, usePathname } from 'expo-router';
import {
    FlatList,
    Modal,
    RefreshControl,
    StyleSheet,
    Text,
    View
} from 'react-native';
import type { GameSummary } from '../../src/api/types';
import { connectLobby, lobby } from '../../src/net/lobbySocket';
import { useAuthStore } from '../../src/stores/authStore';
import { useGameStore } from '../../src/stores/gameStore';
import { useLobbyStore } from '../../src/stores/lobbyStore';
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
                    {game.gameType ? <Badge text={String(game.gameType)} /> : null}
                    {game.gameFormat && game.gameFormat !== 'normal' ? (
                        <Badge text={String(game.gameFormat)} />
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
    const prevGameId = useRef<string | undefined>(undefined);
    const pathname = usePathname();

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

    const openGames = games.filter((game) => !game.started);
    const runningGames = games.filter((game) => game.started);
    const ordered = [...openGames, ...runningGames];

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
                    <Button
                        small
                        variant='secondary'
                        title='Quick join'
                        onPress={() => router.push({ pathname: '/new-game', params: { quick: '1' } })}
                    />
                    <Button small title='New game' onPress={() => router.push('/new-game')} />
                </View>
            </View>

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
                        refreshing={status === 'connecting'}
                        onRefresh={() => connectLobby()}
                        tintColor={colors.textDim}
                    />
                }
                ListEmptyComponent={
                    <EmptyState
                        title='No games right now'
                        subtitle='Create one and invite a friend, or wait for an open table.'
                    />
                }
            />

            <Modal
                visible={!!passwordGame}
                transparent
                animationType='fade'
                onRequestClose={() => setPasswordGame(undefined)}
            >
                <View style={styles.modalBackdrop}>
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
                </View>
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
