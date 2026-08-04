import { io, Socket } from 'socket.io-client';
import { refreshAuthToken } from '../api/client';
import type { HandoffMessage } from '../api/types';
import type { GameState } from '../game/types';
import { useAuthStore } from '../stores/authStore';
import { useGameStore } from '../stores/gameStore';
import { useSettingsStore } from '../stores/settingsStore';
import { buildGameNodeUrl } from './gameNodeUrl';
import { patch } from './jsonpatch';
import { resolveGameState, type GameStateMeta } from './stateSync';

let socket: Socket | undefined;
let currentGameId: string | undefined;
/** When the last game state arrived, used to tell a live socket from a dead one. */
let lastStateAt = 0;
let resyncTimer: ReturnType<typeof setTimeout> | undefined;

/** How long to wait for a requested snapshot before assuming the socket is dead. */
const RESYNC_TIMEOUT_MS = 5000;

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

    // The lobby re-sends the handoff on every lobby (re)connect while a game is
    // running, so most handoffs are for the game we are already on. Keep the
    // socket we have — including while it is mid-reconnect, which is exactly
    // when the lobby reconnects too. Rebuilding it there put the outgoing
    // socket's in-flight reconnect in a race with the new one, and the node
    // gives the player to whichever lands last; when that was the outgoing one,
    // the new socket was never sent anything again and the screen sat on
    // "Connecting to the game…" until the app was killed.
    if (socket && currentGameId === handoff.gameId) {
        if (!socket.connected) {
            store.setStatus('reconnecting');
            socket.connect();
        }

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
        // Deliberately leaves the board alone. The node resets its diff baseline
        // on every connection and marks the state it sends next as a complete
        // one, so there is nothing to protect against by blanking — and blanking
        // is what threw the player off the board and onto the "Connecting to the
        // game…" screen on every reconnection blip and every return from the
        // background.
        useGameStore.getState().setStatus('connected');
    });

    socket.on('connect_error', async () => {
        // Most likely an expired JWT; refresh so the next retry can succeed.
        await refreshAuthToken();
    });

    socket.on('disconnect', (reason: string) => {
        const gameStore = useGameStore.getState();
        if (gameStore.status === 'closed') {
            return;
        }

        // The node closes this socket when the same account connects from
        // somewhere else — another device, or the web client — because a player
        // holds one connection there. socket.io does not retry a disconnect the
        // server asked for, so saying "reconnecting" would be a lie: surface it
        // as failed instead, which is the state that offers Reconnect. The board
        // stays on screen behind it.
        gameStore.setStatus(reason === 'io server disconnect' ? 'failed' : 'reconnecting');
    });

    socket.io.on('reconnect_attempt', () => {
        useGameStore.getState().setStatus('reconnecting');
    });

    socket.io.on('reconnect_failed', () => {
        useGameStore.getState().setStatus('failed');
    });

    socket.on('gamestate', (state: unknown, meta?: GameStateMeta) => {
        const gameStore = useGameStore.getState();
        const outcome = resolveGameState(gameStore.rootState, state, meta);

        if (outcome.action === 'resync') {
            requestResync();
            return;
        }

        // Stamped before the work, and only on payloads we did not have to ask
        // again for: this is what tells the resync watchdog below that the
        // socket is carrying traffic. Stamping it on the resync path above would
        // let the very payload that provoked the request stand in for the answer
        // to it.
        lastStateAt = Date.now();

        if (outcome.action === 'ignore') {
            return;
        }

        if (outcome.action === 'replace') {
            gameStore.setRootState(outcome.state);
            return;
        }

        try {
            gameStore.setRootState(patch(gameStore.rootState as GameState, outcome.delta));
        } catch (err) {
            // A delta that will not apply means our board has drifted from the
            // node's. Keep the last good one on screen and ask for a fresh
            // snapshot rather than rendering something wrong.
            console.warn('gamestate patch failed; resyncing', err);
            requestResync();
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
 * Ask the node for a complete, fresh copy of the board.
 *
 * Used when returning from the background — a socket the OS suspended can report
 * "connected" while being dead — and from the in-game menu, to recover a board
 * that has drifted out of sync (the "both players stuck on Waiting for opponent"
 * case). Over a live socket this is one request and the board stays on screen
 * until the snapshot replaces it. Only when the socket is genuinely down do we
 * reconnect it, which resets the node's diff baseline anyway.
 */
export function resyncGame(): void {
    if (!socket) {
        return;
    }

    if (socket.connected) {
        requestResync();
        return;
    }

    useGameStore.getState().setStatus('reconnecting');
    socket.connect();
}

/**
 * Request a snapshot and watch for it arriving.
 *
 * A socket suspended in the background comes back reporting `connected` when
 * nothing can actually traverse it, so the request alone is not enough: if no
 * state has landed by the deadline, cycle the connection, which is the one thing
 * that definitely re-establishes a working transport.
 */
function requestResync(): void {
    if (!socket) {
        return;
    }

    const requestedAt = Date.now();
    socket.emit('game', 'resync');

    if (resyncTimer) {
        clearTimeout(resyncTimer);
    }

    resyncTimer = setTimeout(() => {
        resyncTimer = undefined;

        if (!socket || lastStateAt >= requestedAt) {
            return;
        }

        useGameStore.getState().setStatus('reconnecting');
        socket.disconnect();
        socket.connect();
    }, RESYNC_TIMEOUT_MS);
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
    if (resyncTimer) {
        clearTimeout(resyncTimer);
        resyncTimer = undefined;
    }
    lastStateAt = 0;
    currentGameId = undefined;
    if (resetStore) {
        useGameStore.getState().reset();
    } else {
        useGameStore.getState().setStatus('closed');
    }
}
