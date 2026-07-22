import { io, Socket } from 'socket.io-client';
import { refreshAuthToken } from '../api/client';
import type { HandoffMessage } from '../api/types';
import type { GameState } from '../game/types';
import { useAuthStore } from '../stores/authStore';
import { useGameStore } from '../stores/gameStore';
import { useSettingsStore } from '../stores/settingsStore';
import { buildGameNodeUrl } from './gameNodeUrl';
import { patch } from './jsonpatch';

let socket: Socket | undefined;
let currentGameId: string | undefined;

export function getGameSocket(): Socket | undefined {
    return socket;
}

/** Build the game node origin from a lobby handoff message. */
export function gameNodeUrl(handoff: HandoffMessage): string {
    return buildGameNodeUrl(handoff, useSettingsStore.getState().serverUrl);
}

/**
 * Connect to the game node named in the handoff. Replaces any previous game
 * connection.
 */
export function connectToGame(handoff: HandoffMessage): void {
    const store = useGameStore.getState();

    if (socket && currentGameId === handoff.gameId && socket.connected) {
        return;
    }

    if (socket) {
        closeGameSocket({ resetStore: false });
    }

    currentGameId = handoff.gameId;
    store.setStatus('connecting');
    store.setRootState(undefined);

    socket = io(gameNodeUrl(handoff), {
        path: `/${handoff.name}/socket.io`,
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        // Mobile networks drop often (backgrounding, WiFi↔cellular, tunnels);
        // keep trying for ~1 min before surfacing a failure the user can retry.
        reconnectionAttempts: 12,
        transports: ['websocket'],
        auth: (cb) => {
            // Prefer the freshest JWT we hold; the handoff token was newest at
            // handoff time, but reconnects may happen much later.
            cb({ token: useAuthStore.getState().token || handoff.authToken });
        }
    });

    socket.on('connect', () => {
        const gameStore = useGameStore.getState();
        gameStore.setStatus('connected');
        // The server resets its diff baseline for us on every connection and
        // will send a complete state next — drop whatever we had.
        gameStore.setRootState(undefined);
    });

    socket.on('connect_error', async () => {
        // Most likely an expired JWT; refresh so the next retry can succeed.
        await refreshAuthToken();
    });

    socket.on('disconnect', () => {
        const gameStore = useGameStore.getState();
        if (gameStore.status !== 'closed') {
            gameStore.setStatus('reconnecting');
        }
    });

    socket.io.on('reconnect_attempt', () => {
        useGameStore.getState().setStatus('reconnecting');
    });

    socket.io.on('reconnect_failed', () => {
        useGameStore.getState().setStatus('failed');
    });

    socket.on('gamestate', (state: unknown) => {
        const gameStore = useGameStore.getState();
        if (state === undefined || state === null) {
            return;
        }
        if (gameStore.rootState) {
            try {
                gameStore.setRootState(patch(gameStore.rootState, state));
            } catch (err) {
                // A malformed/mismatched delta would corrupt the board; drop
                // state and force a clean resync instead.
                console.warn('gamestate patch failed; resyncing', err);
                gameStore.setRootState(undefined);
                socket?.disconnect();
                socket?.connect();
            }
        } else {
            gameStore.setRootState(state as GameState);
        }
    });

    socket.on('cleargamestate', () => {
        // The game node only sends this when the game is actually torn down
        // (game over, rematch, or a player left). Signal screens to leave the
        // board — as opposed to the transient rootState reset on (re)connect.
        useGameStore.getState().markCleared();
    });
}

/**
 * Nudge the game socket to reconnect — used when returning from the background
 * or when the user taps "Retry" after a failure. socket.connect() also resets
 * socket.io's exhausted reconnection counter, so a previously-failed socket
 * starts trying again. No-op when there's no game or it's already live.
 */
export function reconnectGameSocket(): void {
    if (!socket || socket.connected) {
        return;
    }
    useGameStore.getState().setStatus('reconnecting');
    socket.connect();
}

/**
 * Force a fresh full game state from the server. Cycling the connection makes
 * the game node reset its per-player diff baseline and resend the complete
 * state, which recovers a client whose board has drifted out of sync (the
 * "both players stuck on Waiting for opponent" case). Listeners are kept.
 */
export function resyncGame(): void {
    if (!socket) {
        return;
    }
    const store = useGameStore.getState();
    store.setStatus('reconnecting');
    store.setRootState(undefined); // the next gamestate will be a full snapshot
    socket.disconnect();
    socket.connect();
}

/** Send an in-game command (a Game method) to the game node. */
export function sendGameMessage(command: string, ...args: unknown[]): void {
    if (socket) {
        socket.emit('game', command, ...args);
    }
}

/**
 * Close the game connection. Deferred a tick so a just-queued 'concede' /
 * 'leavegame' emit can flush over the transport first.
 */
export function closeGameSocket(options: { resetStore?: boolean } = {}): void {
    const { resetStore = true } = options;
    if (socket) {
        const closing = socket;
        closing.removeAllListeners();
        setTimeout(() => closing.close(), 0);
        socket = undefined;
    }
    currentGameId = undefined;
    if (resetStore) {
        useGameStore.getState().reset();
    } else {
        useGameStore.getState().setStatus('closed');
    }
}
