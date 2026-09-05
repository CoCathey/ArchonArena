import { io } from 'socket.io-client';
import * as jsondiffpatch from 'jsondiffpatch';

import { gamesActions } from '../slices/gamesSlice';
import { lobbyActions } from '../slices/lobbySlice';
import { adminActions } from '../slices/adminSlice';
import {
    gameCloseRequested,
    gameConnectRequested,
    gameSendMessage,
    lobbyAuthenticateRequested,
    lobbyConnectRequested,
    lobbyDisconnectRequested,
    lobbyLeaveGameRequested,
    lobbySendMessage,
    lobbyStartGameRequested
} from '../socketActions';
import { api } from '../api';
import { TAG_TYPES } from '../apiTags';
import { setAuthTokens } from '../slices/authSlice';

let lobbySocket;
let gameSocket;
// The game the live `gameSocket` belongs to. Kept here rather than read back out
// of the store: `gamesActions.handoffReceived` overwrites `games.gameId` with
// the incoming handoff's id, so by the time the handoff handler could look, the
// store can no longer tell "the game we are already playing" from "a new one".
let gameSocketGameId;
const patcher = jsondiffpatch.create({
    objectHash: (obj, index) => {
        return obj.uuid || obj.name || obj.id || obj._id || '$$index:' + index;
    }
});

const lobbyMessages = [
    'newgame',
    'removegame',
    'updategame',
    'games',
    'users',
    'newuser',
    'userleft',
    'lobbychat',
    'nochat',
    'passworderror',
    'lobbymessages',
    'banner',
    'motd',
    'cleargamestate',
    'gameerror',
    'matchmaking',
    // ARCHON: a sentence for THIS player from the lobby, toasted wherever they
    // are - see LobbyNoticeToaster. 'gameerror' only shows inside a pending
    // table, which is the one place a player who has just been cleared out of
    // a finished tournament game is not.
    'lobbynotice'
];

export const socketMiddleware = (store) => (next) => (action) => {
    const result = next(action);
    const state = store.getState();
    const refreshAndAuthenticateLobbySocket = () => {
        const verifyRequest = store.dispatch(
            api.endpoints.verifyAuthentication.initiate(undefined, { forceRefetch: true })
        );

        verifyRequest
            .unwrap()
            .then(() => {
                store.dispatch(lobbyAuthenticateRequested());
            })
            .catch(() => {});
    };

    if (lobbyConnectRequested.match(action)) {
        if (lobbySocket && lobbySocket.connected) {
            return result;
        }

        lobbySocket = io(window.location.origin, {
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity,
            auth: {
                token: state.auth.token || undefined,
                version: import.meta.env.VITE_VERSION || 'Local build'
            }
        });

        store.dispatch(lobbyActions.connecting({ socket: lobbySocket }));

        lobbySocket.on('pong', (responseTime) => {
            store.dispatch(lobbyActions.responseTimeReceived(responseTime));
        });

        lobbySocket.on('connect', () => {
            store.dispatch(lobbyActions.connected());
        });

        lobbySocket.on('disconnect', () => {
            store.dispatch(lobbyActions.disconnected());
        });

        lobbySocket.io.on('reconnect_attempt', () => {
            store.dispatch(lobbyActions.reconnecting());
        });

        for (const message of lobbyMessages) {
            lobbySocket.on(message, (arg) => {
                store.dispatch(lobbyActions.messageReceived({ message, args: [arg] }));
            });
        }

        /**
         * ARCHON: a direct message for (or from) this player arrived live.
         *
         * Every open query about messages refetches - the inbox, the thread,
         * the badge - and a message from somebody else surfaces as a toast
         * unless that thread is the one on screen, where the refetch already
         * shows it.
         */
        lobbySocket.on('directmessage', (message) => {
            store.dispatch(api.util.invalidateTags([TAG_TYPES.MESSAGES]));

            const me = store.getState().account.user?.username;

            if (!message || !me || message.recipientUsername !== me) {
                return;
            }

            const threadPath = `/messages/${encodeURIComponent(message.senderUsername)}`;

            if (
                typeof window !== 'undefined' &&
                decodeURIComponent(window.location.pathname) === decodeURIComponent(threadPath)
            ) {
                return;
            }

            const text = String(message.text || '');
            const excerpt = text.length > 120 ? `${text.slice(0, 117)}...` : text;

            store.dispatch(
                lobbyActions.messageReceived({
                    message: 'lobbynotice',
                    args: [
                        {
                            tone: 'info',
                            message: `${message.senderUsername}: ${excerpt}`,
                            url: threadPath
                        }
                    ]
                })
            );
        });

        lobbySocket.on('gamestate', (game) => {
            const currentState = store.getState();
            store.dispatch(
                lobbyActions.messageReceived({
                    message: 'gamestate',
                    args: [
                        game,
                        currentState.account.user ? currentState.account.user.username : undefined
                    ]
                })
            );
        });

        lobbySocket.on('handoff', (handoff) => {
            const standardPorts = [80, 443];
            let url =
                handoff.address && handoff.address !== 'undefined'
                    ? `//${handoff.address}`
                    : `//${window.location.hostname}`;

            // Captured before `handoffReceived` lands, which overwrites it.
            const connectedGameId = gameSocketGameId;

            store.dispatch(gamesActions.handoffReceived(handoff));

            if (handoff.port && !standardPorts.includes(handoff.port)) {
                url += `:${handoff.port}`;
            }

            store.dispatch(
                setAuthTokens({
                    token: handoff.authToken,
                    refreshToken: store.getState().auth.refreshToken,
                    user: handoff.user
                })
            );

            // ARCHON: the lobby re-sends the handoff on every lobby (re)connect
            // while a game is running, so most handoffs are for the game we are
            // already playing. Rebuilding the game socket for those did real
            // damage: closing it cleared `lobby.currentGame`, which swapped the
            // board out for the pending-game screen with no way back but a
            // refresh, and the outgoing socket's late `disconnect` raced the
            // replacement's first state. Keep the connection we have; just make
            // sure it is trying.
            if (gameSocket && connectedGameId === handoff.gameId) {
                if (!gameSocket.connected) {
                    gameSocket.connect();
                }

                return;
            }

            if (gameSocket) {
                store.dispatch(gameCloseRequested());
            }

            store.dispatch(gameConnectRequested(url, handoff.name, handoff.gameId));
        });

        lobbySocket.on('authfailed', () => {
            refreshAndAuthenticateLobbySocket();
        });

        lobbySocket.on('nodestatus', (status) => {
            store.dispatch(adminActions.nodeStatusReceived(status));
        });

        lobbySocket.on('removemessage', (messageId, deletedBy) => {
            store.dispatch(
                lobbyActions.messageReceived({
                    message: 'removemessage',
                    args: [messageId, deletedBy]
                })
            );
        });
    }

    if (lobbyDisconnectRequested.match(action)) {
        if (lobbySocket) {
            lobbySocket.closing = true;
            lobbySocket.disconnect();
        }
    }

    if (lobbyAuthenticateRequested.match(action)) {
        if (lobbySocket && state.auth.token) {
            lobbySocket.emit('authenticate', state.auth.token);
        }
    }

    if (lobbySendMessage.match(action)) {
        const { message, args } = action.payload;
        if (lobbySocket) {
            lobbySocket.emit(message, ...args);
        }
    }

    if (lobbyStartGameRequested.match(action)) {
        if (lobbySocket) {
            lobbySocket.emit('startgame', action.payload.gameId);
        }
        store.dispatch(lobbyActions.gameStarting());
    }

    if (lobbyLeaveGameRequested.match(action)) {
        if (lobbySocket) {
            lobbySocket.emit('leavegame', action.payload.gameId);
        }
        store.dispatch(lobbyActions.gameSocketClosed());
        store.dispatch(gamesActions.socketClosed());
    }

    if (gameConnectRequested.match(action)) {
        const { url, name, gameId } = action.payload;
        gameSocketGameId = gameId;
        const socket = io(url, {
            path: `/${name}/socket.io`,
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            // ARCHON: 5 attempts (~15s) was too few — a brief network blip mid
            // game would exhaust them and strand the player at a board whose
            // clicks no longer resolve. Give reconnection a couple of minutes to
            // recover. Safe now that a post-connect `connect_error` no longer
            // reports a failed handoff to the lobby (see the handler below).
            reconnectionAttempts: 20,
            // ARCHON: read at handshake time, not socket-construction time. The
            // node's handoff JWTs last five minutes, and a reconnect can happen
            // long after that; a fixed `auth` object would keep re-presenting an
            // expired token and every attempt would be refused. Rebuilding the
            // socket on each lobby handoff used to hide this by accident — it
            // was the only thing that got a fresh token to the handshake — and
            // now that a handoff for the game in progress keeps the connection,
            // the token has to reach it this way instead.
            auth: (cb) => {
                cb({ token: store.getState().auth.token || undefined });
            }
        });

        gameSocket = socket;

        // ARCHON: every handler below ignores events from a socket that is no
        // longer the live one. A replaced socket keeps firing while it closes -
        // and its `reconnect_*` listeners sit on a Manager that socket.io shares
        // between connections to the same node, so they outlive it entirely. A
        // late `disconnect` from the outgoing socket used to wipe the board the
        // incoming socket had just delivered.
        const isCurrent = () => gameSocket === socket;

        store.dispatch(
            gamesActions.socketConnecting({
                host: `${url}/${name}`,
                socket: socket
            })
        );

        socket.on('pong', (responseTime) => {
            if (!isCurrent()) {
                return;
            }

            store.dispatch(gamesActions.responseTimeReceived(responseTime));
        });

        socket.on('connect', () => {
            // ARCHON: remember that we reached the node at least once so a later
            // reconnection blip isn't misreported as a failed handoff.
            socket.tHasConnected = true;

            if (!isCurrent()) {
                return;
            }

            store.dispatch(gamesActions.socketConnected({ socket: socket }));
        });

        socket.on('connect_error', () => {
            if (!isCurrent()) {
                return;
            }

            // ARCHON: only tell the lobby the handoff failed if we NEVER managed
            // to connect to the game node. A `connect_error` fired after a
            // successful connect is a transient reconnection blip (socket.io
            // keeps retrying) — reporting it made the node run `failedConnect`
            // on a live game, marking it finished and leaving the player staring
            // at a board whose buttons (e.g. the mulligan prompt) did nothing.
            if (lobbySocket && !socket.tHasConnected) {
                lobbySocket.emit('connectfailed');
            }
            store.dispatch(gamesActions.socketConnectError());
        });

        socket.on('disconnect', () => {
            if (!isCurrent()) {
                return;
            }

            store.dispatch(gamesActions.socketDisconnected());
            store.dispatch(lobbyActions.gameSocketDisconnected());
        });

        socket.io.on('reconnect_attempt', () => {
            if (!isCurrent()) {
                return;
            }

            store.dispatch(gamesActions.socketReconnecting());
        });

        socket.io.on('reconnect', () => {
            if (!isCurrent()) {
                return;
            }

            store.dispatch(gamesActions.socketReconnected());
        });

        socket.io.on('reconnect_failed', () => {
            if (!isCurrent()) {
                return;
            }

            store.dispatch(gamesActions.socketConnectFailed());
        });

        socket.on('gamestate', (game, meta) => {
            if (!isCurrent()) {
                return;
            }

            const latestState = store.getState();
            let gameState;

            // ARCHON: the node says which of the two this is. Guessing from
            // whether we happen to hold a board is wrong whenever the node reset
            // its diff baseline while this socket stayed up (a second tab or the
            // phone app connecting as the same user does exactly that), and
            // getting it wrong is not a soft failure: jsondiffpatch loops
            // forever when handed a whole game state as a delta, hanging the
            // tab. `meta` is absent only when talking to a node older than this
            // change, where the old guess is still the best available.
            const isFullState = meta ? !!meta.full : !latestState.lobby.rootState;

            if (isFullState) {
                gameState = game;
            } else if (!latestState.lobby.rootState) {
                // A delta with nothing to apply it to. Ask for a clean copy
                // rather than adopting the delta as though it were a board.
                socket.emit('game', 'resync');

                return;
            } else {
                try {
                    gameState = patcher.patch(
                        jsondiffpatch.clone(latestState.lobby.rootState),
                        game
                    );
                } catch (error) {
                    // A delta that will not apply means our board has drifted
                    // from the node's. Keep showing the last good one and ask
                    // for a fresh snapshot instead of rendering something wrong.
                    // eslint-disable-next-line no-console
                    console.warn('Could not apply game state delta, resyncing', error);
                    socket.emit('game', 'resync');

                    return;
                }
            }

            store.dispatch(lobbyActions.setRootState(gameState));

            store.dispatch(
                lobbyActions.messageReceived({
                    message: 'gamestate',
                    args: [
                        gameState,
                        latestState.account.user ? latestState.account.user.username : undefined
                    ]
                })
            );
        });

        socket.on('cleargamestate', () => {
            if (!isCurrent()) {
                return;
            }

            const currentState = store.getState();
            // The game socket's `cleargamestate` for a finished game can arrive
            // *after* the lobby socket has already published a new pending
            // rematch game into `lobby.currentGame`. We only want to clear the
            // slot when it still holds the finished game we're being notified
            // about — not when it has been replaced by the rematch.
            //
            // A finished/in-progress game lives in the slot with `started: true`;
            // a newly created pending rematch arrives with `started: false`
            // (it doesn't flip to started until both players keep and the game
            // socket sends the first gamestate). So:
            //
            //   - !currentGame              -> nothing to clear (no-op).
            //   - currentGame.started       -> still the finished game, clear it.
            //   - currentGame && !started   -> a rematch raced ahead of us; leave it.
            //
            // `clearGameState` only resets `currentGame`/`newGame`; `rootState`
            // (the live board) is cleared separately by `gameSocketClosed` /
            // the next gamestate patch, so skipping here doesn't leak board data.
            if (!currentState.lobby.currentGame || currentState.lobby.currentGame.started) {
                store.dispatch(lobbyActions.clearGameState());
            }
        });
    }

    if (gameCloseRequested.match(action)) {
        if (gameSocket) {
            gameSocket.gameClosing = true;
            // Defer the actual close to the next macrotask so any in-flight
            // emit() calls dispatched immediately before this (e.g. 'concede'
            // and 'leavegame' from the Leave Game button) have a chance to
            // flush over the transport. Without this, closing on the same
            // tick can drop the just-queued packets and the server never
            // sees the leave — leaving the user "stuck" in the game until
            // they refresh.
            const socketToClose = gameSocket;
            setTimeout(() => {
                // Only the socket's own listeners: the shared Manager's are
                // guarded by `isCurrent()` instead, because removing them would
                // also strip the replacement socket's.
                socketToClose.removeAllListeners();
                socketToClose.close();
            }, 0);
            // Clearing this first is what makes the outgoing socket's handlers
            // no-ops from here on, including anything it fires while closing.
            gameSocket = undefined;
        }
        gameSocketGameId = undefined;
        store.dispatch(gamesActions.socketClosed());
        store.dispatch(lobbyActions.gameSocketClosed());
    }

    if (gameSendMessage.match(action)) {
        const { message, args } = action.payload;
        if (gameSocket) {
            gameSocket.emit('game', message, ...args);
        }
    }

    return result;
};
