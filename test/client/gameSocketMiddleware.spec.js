import { vi } from 'vitest';

/**
 * The lobby re-sends a `handoff` on *every* lobby (re)connect while a game is
 * running, not only when the game starts. The web client used to answer each one
 * by tearing the game socket down and building a new one, which did three things
 * to a player who was mid-game and had only had a network blip:
 *
 *   - closing the socket cleared `lobby.currentGame`, and `/play` renders the
 *     board only while that is set, so the board was swapped out for the
 *     pending-game screen — with no way back, because the lobby stops sending
 *     `gamestate` for a game once it has started;
 *   - the outgoing socket's `disconnect` landed after the replacement had
 *     already delivered its first board and wiped it again; and
 *   - two live sockets for one user made the node hand the player to whichever
 *     connected last, starving the other.
 *
 * These cover the fix, and the other half of it: the node now says whether what
 * it sent is a complete board or a delta, so the client no longer has to guess
 * from whether it happens to be holding one.
 */

const sockets = [];

function makeSocket(options) {
    const socket = {
        options,
        /** What the socket would present at its next handshake. */
        auth() {
            let presented;
            options.auth((values) => {
                presented = values;
            });

            return presented;
        },
        handlers: {},
        managerHandlers: {},
        emitted: [],
        connected: false,
        closed: false,
        connectCalls: 0,
        removedAllListeners: false,
        on(event, handler) {
            socket.handlers[event] = handler;
        },
        removeAllListeners() {
            socket.removedAllListeners = true;
            socket.handlers = {};
        },
        emit(...args) {
            socket.emitted.push(args);
        },
        connect() {
            socket.connectCalls++;
        },
        close() {
            socket.closed = true;
        },
        io: {
            on(event, handler) {
                socket.managerHandlers[event] = handler;
            }
        },
        fire(event, ...args) {
            socket.handlers[event]?.(...args);
        }
    };

    sockets.push(socket);

    return socket;
}

vi.mock('socket.io-client', () => ({
    io: (url, options) => makeSocket(options)
}));

// The middleware reads the lobby origin off `window`; these run under the node
// environment the rest of the suite uses.
globalThis.window = { location: { origin: 'https://arena.test', hostname: 'arena.test' } };

describe('game socket middleware', function () {
    let state;
    let dispatched;
    let dispatch;

    // A store just real enough for the middleware: the handful of reducers it
    // actually depends on, applied as actions pass through `next`.
    const reduce = (action) => {
        switch (action.type) {
            case 'lobby/setRootState':
                state.lobby.rootState = action.payload;
                break;
            case 'lobby/gameSocketClosed':
                state.lobby.currentGame = undefined;
                state.lobby.rootState = undefined;
                break;
            case 'lobby/gameSocketDisconnected':
                state.lobby.rootState = undefined;
                break;
            case 'games/handoffReceived':
                state.games.gameId = action.payload.gameId;
                break;
            case 'auth/setAuthTokens':
                state.auth.token = action.payload.token;
                break;
            default:
                break;
        }
    };

    // The middleware keeps its sockets in module scope, so each test needs a
    // fresh copy of the module rather than one carried over from the last.
    beforeEach(async function () {
        vi.resetModules();
        sockets.length = 0;

        const { socketMiddleware } = await import(
            '../../client/redux/middleware/socket-middleware'
        );
        const { lobbyConnectRequested } = await import('../../client/redux/socketActions');

        state = {
            auth: { token: 'jwt', refreshToken: 'refresh' },
            account: { user: { username: 'alice' } },
            games: {},
            lobby: { currentGame: { id: 'game-1', started: true } }
        };
        dispatched = [];

        dispatch = socketMiddleware({ getState: () => state, dispatch: (a) => dispatch(a) })(
            (action) => {
                dispatched.push(action);
                reduce(action);

                return action;
            }
        );

        dispatch(lobbyConnectRequested());
    });

    const lobbySocket = () => sockets[0];
    const gameSocket = () => sockets[sockets.length - 1];

    const handoff = (overrides = {}) => ({
        authToken: 'game-jwt',
        gameId: 'game-1',
        name: 'node-0',
        user: { username: 'alice' },
        ...overrides
    });

    function joinGame() {
        lobbySocket().fire('handoff', handoff());
        gameSocket().connected = true;
        gameSocket().fire('connect');
        gameSocket().fire('gamestate', { name: 'Test game', players: {} }, { full: true });
    }

    describe('a repeated handoff for the game already being played', function () {
        beforeEach(joinGame);

        it('keeps the same socket', function () {
            const before = gameSocket();

            lobbySocket().fire('handoff', handoff());

            expect(gameSocket()).toBe(before);
            expect(before.closed).toBe(false);
        });

        it('leaves the board and the current game alone', function () {
            lobbySocket().fire('handoff', handoff());

            expect(state.lobby.rootState).toEqual({ name: 'Test game', players: {} });
            expect(state.lobby.currentGame).toEqual({ id: 'game-1', started: true });
        });

        it('adopts the fresh auth token that came with it', function () {
            lobbySocket().fire('handoff', handoff({ authToken: 'newer-jwt' }));

            const authAction = dispatched.filter((a) => a.type === 'auth/setAuthTokens').pop();

            expect(authAction.payload.token).toBe('newer-jwt');
            expect(authAction.payload.refreshToken).toBe('refresh');
        });

        it('nudges a socket that is down back into reconnecting', function () {
            const socket = gameSocket();
            socket.connected = false;

            lobbySocket().fire('handoff', handoff());

            expect(socket.connectCalls).toBe(1);
            expect(socket.closed).toBe(false);
        });

        // Handoff JWTs last five minutes. Keeping the socket is only safe if the
        // token it presents is read when it reconnects, not when it was built —
        // otherwise every reconnection attempt after the first five minutes is
        // refused, and rebuilding the socket was previously the only thing
        // getting a fresh token to the handshake.
        it('presents the newest token at the next handshake', function () {
            const socket = gameSocket();

            expect(socket.auth()).toEqual({ token: 'game-jwt' });

            state.auth.token = 'refreshed-jwt';

            expect(socket.auth()).toEqual({ token: 'refreshed-jwt' });
        });
    });

    describe('a handoff for a different game', function () {
        beforeEach(joinGame);

        it('replaces the socket and clears the old board', function () {
            const previous = gameSocket();

            lobbySocket().fire('handoff', handoff({ gameId: 'game-2' }));

            expect(gameSocket()).not.toBe(previous);
            expect(state.lobby.rootState).toBeUndefined();
        });

        it('ignores the outgoing socket once it has been replaced', function () {
            const previous = gameSocket();

            lobbySocket().fire('handoff', handoff({ gameId: 'game-2' }));
            gameSocket().fire('gamestate', { name: 'Rematch', players: {} }, { full: true });

            // The straggler: a `disconnect` from the socket on its way out used
            // to wipe the board its replacement had just delivered.
            previous.fire('disconnect');

            expect(state.lobby.rootState).toEqual({ name: 'Rematch', players: {} });
        });
    });

    describe('applying what the node sent', function () {
        beforeEach(joinGame);

        it('patches a delta onto the board', function () {
            gameSocket().fire('gamestate', { players: { alice: [{ amber: 2 }] } }, { full: false });

            expect(state.lobby.rootState).toEqual({
                name: 'Test game',
                players: { alice: { amber: 2 } }
            });
        });

        // The case that hung the tab: a complete board arriving while one is
        // already held, because the node reset its baseline for a second client
        // signed in as the same user.
        it('replaces the board wholesale when the node says the state is complete', function () {
            const replacement = { name: 'Test game', phase: 'key', players: { alice: {} } };

            gameSocket().fire('gamestate', replacement, { full: true });

            expect(state.lobby.rootState).toEqual(replacement);
        });

        it('asks for a snapshot rather than adopting a delta as a board', function () {
            gameSocket().fire('disconnect'); // clears rootState
            gameSocket().fire('gamestate', { players: { alice: [{ amber: 2 }] } }, { full: false });

            expect(state.lobby.rootState).toBeUndefined();
            expect(gameSocket().emitted).toContainEqual(['game', 'resync']);
        });

        it('keeps the last good board and resyncs when a delta will not apply', function () {
            const before = state.lobby.rootState;

            gameSocket().fire(
                'gamestate',
                { players: { alice: { amber: [1, 2, 9] } } },
                {
                    full: false
                }
            );

            expect(state.lobby.rootState).toEqual(before);
            expect(gameSocket().emitted).toContainEqual(['game', 'resync']);
        });

        // Talking to a node older than this change, which sends no marker.
        it('falls back to the old guess when the node sends no marker', function () {
            gameSocket().fire('gamestate', { players: { alice: [{ amber: 2 }] } });

            expect(state.lobby.rootState).toEqual({
                name: 'Test game',
                players: { alice: { amber: 2 } }
            });
        });
    });
});
