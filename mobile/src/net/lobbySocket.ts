import { io, Socket } from 'socket.io-client';
import { refreshAuthToken } from '../api/client';
import type { GameSummary, HandoffMessage, NewGameRequest } from '../api/types';
import { useAuthStore } from '../stores/authStore';
import { useGameStore } from '../stores/gameStore';
import { useLobbyStore } from '../stores/lobbyStore';
import { useSettingsStore } from '../stores/settingsStore';
import { connectToGame } from './gameSocket';

const CLIENT_VERSION = 'archon-arena-mobile';

let socket: Socket | undefined;

export function getLobbySocket(): Socket | undefined {
    return socket;
}

/**
 * Connect (or reuse) the lobby socket. Safe to call repeatedly — an existing
 * live connection is kept.
 */
export async function connectLobby(): Promise<void> {
    const lobby = useLobbyStore.getState();

    if (socket) {
        if (socket.connected) {
            return;
        }
        socket.connect();
        return;
    }

    // Make sure we hold a fresh JWT before the handshake; the server auths the
    // socket from auth.token at connect time.
    if (!useAuthStore.getState().token) {
        await refreshAuthToken();
    }

    const serverUrl = useSettingsStore.getState().serverUrl;
    lobby.setStatus('connecting');

    socket = io(serverUrl, {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity,
        transports: ['websocket'],
        auth: (cb) => {
            cb({
                token: useAuthStore.getState().token || undefined,
                version: CLIENT_VERSION
            });
        }
    });

    socket.on('connect', () => {
        useLobbyStore.getState().setStatus('connected');
    });

    socket.on('disconnect', () => {
        useLobbyStore.getState().setStatus('disconnected');
    });

    socket.io.on('reconnect_attempt', () => {
        useLobbyStore.getState().setStatus('connecting');
    });

    socket.on('authfailed', async () => {
        const token = await refreshAuthToken();
        if (token && socket) {
            socket.emit('authenticate', token);
        }
    });

    socket.on('games', (games: GameSummary[]) => {
        useLobbyStore.getState().setGames(games ?? []);
    });

    socket.on('newgame', (games: GameSummary[]) => {
        useLobbyStore.getState().addGames(games ?? []);
    });

    socket.on('updategame', (games: GameSummary[]) => {
        useLobbyStore.getState().updateGames(games ?? []);
    });

    socket.on('removegame', (games: GameSummary[]) => {
        useLobbyStore.getState().removeGames(games ?? []);
    });

    socket.on('users', (users: { name: string; avatar?: string }[]) => {
        useLobbyStore.getState().setUsers(users ?? []);
    });

    socket.on('gamestate', (game: GameSummary) => {
        useLobbyStore.getState().setCurrentGame(game ?? undefined);
    });

    socket.on('cleargamestate', () => {
        useLobbyStore.getState().setCurrentGame(undefined);
    });

    socket.on('passworderror', (message: string) => {
        useLobbyStore.getState().setPasswordError(message);
    });

    socket.on('gameerror', (message: string) => {
        useLobbyStore.getState().setGameError(message);
    });

    socket.on('banner', (notice: string) => {
        useLobbyStore.getState().setBanner(notice);
    });

    socket.on('motd', (motd: { message?: string }) => {
        useLobbyStore.getState().setMotd(motd);
    });

    socket.on('handoff', (handoff: HandoffMessage) => {
        const gameStore = useGameStore.getState();

        // The handoff carries a fresh game-node JWT; adopt it for future
        // requests too (it is a normal user JWT).
        useAuthStore.getState().setAuth({ token: handoff.authToken, user: handoff.user });

        gameStore.setHandoff(handoff);
        connectToGame(handoff);
    });
}

export function disconnectLobby(): void {
    if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket = undefined;
    }
    useLobbyStore.getState().reset();
}

function emit(message: string, ...args: unknown[]): void {
    if (socket) {
        socket.emit(message, ...args);
    }
}

export const lobby = {
    newGame(details: NewGameRequest): void {
        useLobbyStore.getState().setGameError(undefined);
        emit('newgame', details);
    },
    joinGame(gameId: string, password?: string): void {
        useLobbyStore.getState().setPasswordError(undefined);
        emit('joingame', gameId, password);
    },
    watchGame(gameId: string, password?: string): void {
        useLobbyStore.getState().setPasswordError(undefined);
        emit('watchgame', gameId, password);
    },
    leaveGame(gameId: string): void {
        emit('leavegame', gameId);
        useLobbyStore.getState().setCurrentGame(undefined);
    },
    startGame(gameId: string): void {
        emit('startgame', gameId);
    },
    selectDeck(gameId: string, deckId: string | number, isStandalone: boolean): void {
        emit('selectdeck', gameId, deckId, isStandalone);
    },
    /**
     * Ask the lobby to deal this player a sealed deck. Sealed games have no
     * deck choice — the server builds one from the game's allowed sets and
     * assigns it — so the pending screen requests it on arrival.
     */
    getSealedDeck(gameId: string): void {
        emit('getsealeddeck', gameId);
    },
    /**
     * Lucky Dice: let the server pick a random deck. It rolls over the whole
     * collection — which the app only ever holds a page of — and applies the
     * game's own rules (alliance, SAS bound) to the roll.
     */
    selectRandomDeck(gameId: string): void {
        useLobbyStore.getState().setGameError(undefined);
        emit('selectrandomdeck', gameId);
    },
    pendingChat(message: string): void {
        emit('chat', message);
    },
    removeGame(gameId: string): void {
        emit('removegame', gameId);
    },
    connectFailed(): void {
        emit('connectfailed');
    }
};
