const jsondiffpatch = require('jsondiffpatch').create({
    objectHash: (obj, index) => obj.uuid || obj.name || obj.id || obj._id || '$$index:' + index
});

const GameServer = require('../../server/gamenode/gameserver');

/**
 * The game node sends a player either a complete board or a jsondiffpatch delta
 * over the same `gamestate` event, and its diff baseline (`jsonForUsers`) is per
 * *player*, not per socket — it is reset whenever that player connects,
 * reconnects, disconnects or leaves.
 *
 * Clients used to work out which of the two they had been sent by looking at
 * themselves: "I am holding no board, so this must be a complete one". That is
 * wrong exactly when the reset happened on the node's side of a connection the
 * client still has open — a second tab, or the phone app signing in as the same
 * user, resets the baseline for a client that is still holding a board. The
 * client then feeds a whole game state to a delta patcher, which does not fail
 * loudly (see the last test in this file).
 *
 * These cover the fix: the node says which it sent, evicts a socket it has
 * superseded rather than leaving it silently starved, and can be asked for a
 * fresh snapshot without dropping the connection.
 */

function makeSocket(id, username) {
    return {
        id,
        user: { username },
        sent: [],
        disconnected: false,
        send(message, ...args) {
            this.sent.push({ message, args });
        },
        disconnect() {
            this.disconnected = true;
        },
        joinChannel() {},
        leaveChannel() {},
        registerEvent() {},
        on() {}
    };
}

function makeGame(states) {
    const players = {
        alice: { name: 'alice', id: 'sock-alice', socket: makeSocket('sock-alice', 'alice') },
        bob: { name: 'bob', id: 'sock-bob', socket: makeSocket('sock-bob', 'bob') }
    };

    return {
        id: 'game-1',
        jsonForUsers: {},
        playersAndSpectators: players,
        getPlayersAndSpectators: () => players,
        getState: (name) => jsondiffpatch.clone(states[name]),
        isSpectator: () => false,
        recordBoardSnapshot: () => {},
        addAlert: () => {}
    };
}

function makeServer() {
    // Object.create rather than `new`: the constructor stands up socket.io,
    // Redis and the health server.
    const server = Object.create(GameServer.prototype);
    server.games = {};

    return server;
}

describe('game state delivery', function () {
    let server;
    let game;
    let states;

    beforeEach(function () {
        states = {
            alice: { name: 'Test game', phase: 'main', players: { alice: { amber: 1 } } },
            bob: { name: 'Test game', phase: 'main', players: { bob: { amber: 0 } } }
        };
        game = makeGame(states);
        server = makeServer();
        server.games[game.id] = game;
    });

    function lastSendTo(playerName) {
        const sent = game.playersAndSpectators[playerName].socket.sent;

        return sent[sent.length - 1];
    }

    it('marks the first state a player is sent as a complete one', function () {
        server.sendGameState(game);

        const { message, args } = lastSendTo('alice');

        expect(message).toBe('gamestate');
        expect(args[0]).toEqual(states.alice);
        expect(args[1]).toEqual({ full: true });
    });

    it('marks a subsequent state as a delta', function () {
        server.sendGameState(game);
        states.alice.players.alice.amber = 3;
        server.sendGameState(game);

        const { args } = lastSendTo('alice');

        expect(args[1]).toEqual({ full: false });
        // A delta, not the board: [oldValue, newValue] at the changed leaf.
        expect(args[0]).toEqual({ players: { alice: { amber: [1, 3] } } });
    });

    // The case a client cannot detect for itself, and the reason the flag has to
    // be on the wire: the client's board is untouched, only the node's baseline
    // was reset.
    it('marks the state after a baseline reset as complete again', function () {
        server.sendGameState(game);
        game.jsonForUsers.alice = undefined;
        server.sendGameState(game);

        const { args } = lastSendTo('alice');

        expect(args[1]).toEqual({ full: true });
        expect(args[0]).toEqual(states.alice);
    });

    it('advances each player’s baseline independently', function () {
        server.sendGameState(game);
        game.jsonForUsers.alice = undefined;
        states.bob.players.bob.amber = 2;
        server.sendGameState(game);

        expect(lastSendTo('alice').args[1]).toEqual({ full: true });
        expect(lastSendTo('bob').args[1]).toEqual({ full: false });
    });

    it('holds a delayed spectator back but still marks their first state complete', function () {
        const spectator = {
            name: 'carol',
            id: 'sock-carol',
            socket: makeSocket('sock-carol', 'carol')
        };
        game.playersAndSpectators.carol = spectator;
        states.carol = { name: 'Test game', phase: 'main' };
        game.isSpectator = (player) => player.name === 'carol';
        game.spectatorDelaySeconds = 60;

        server.sendGameState(game);

        expect(spectator.socket.sent).toEqual([]);
        expect(game.spectatorDelayQueue.length).toBe(1);

        server.flushDelayedStates(game, { force: true });

        expect(lastSendTo('carol').args[1]).toEqual({ full: true });
    });
});

describe('resync requests', function () {
    let server;
    let game;
    let states;

    beforeEach(function () {
        states = {
            alice: { name: 'Test game', phase: 'main', players: { alice: { amber: 1 } } },
            bob: { name: 'Test game', phase: 'main', players: { bob: { amber: 0 } } }
        };
        game = makeGame(states);
        server = makeServer();
        server.games[game.id] = game;
        server.sendGameState(game); // establish a baseline for both players
    });

    function resyncAs(username, socket) {
        server.onGameMessage(socket || game.playersAndSpectators[username].socket, 'resync');
    }

    it('sends a complete board back over the live socket', function () {
        resyncAs('alice');

        const sent = game.playersAndSpectators.alice.socket.sent;
        const last = sent[sent.length - 1];

        expect(last.args[1]).toEqual({ full: true });
        expect(last.args[0]).toEqual(states.alice);
    });

    it('does not disturb the other player', function () {
        const before = game.playersAndSpectators.bob.socket.sent.length;

        resyncAs('alice');

        expect(game.playersAndSpectators.bob.socket.sent.length).toBe(before);
        expect(game.jsonForUsers.bob).toBeDefined();
    });

    it('leaves the next state a delta again', function () {
        resyncAs('alice');
        states.alice.players.alice.amber = 4;
        server.sendGameState(game);

        const sent = game.playersAndSpectators.alice.socket.sent;

        expect(sent[sent.length - 1].args[1]).toEqual({ full: false });
    });

    // A socket the node has already replaced must not be able to reset the
    // baseline: that would desynchronise the client that actually holds the
    // player's connection.
    it('ignores a request from a superseded socket', function () {
        const superseded = makeSocket('sock-alice-old', 'alice');

        resyncAs('alice', superseded);

        expect(superseded.sent).toEqual([]);
        expect(game.jsonForUsers.alice).toBeDefined();
    });
});

describe('a second connection for the same user', function () {
    let server;
    let game;
    let states;

    beforeEach(function () {
        states = {
            alice: { name: 'Test game', phase: 'main', players: { alice: { amber: 1 } } },
            bob: { name: 'Test game', phase: 'main', players: { bob: { amber: 0 } } }
        };
        game = makeGame(states);
        server = makeServer();
        server.games[game.id] = game;
        server.configService = { getValue: () => 'secret' };
    });

    // The real `Socket` wrapper is used here (that is what onConnection builds),
    // so what it emits lands on the underlying io socket rather than on a stub.
    function connectAs(username, socketId) {
        const emitted = [];
        const ioSocket = {
            id: socketId,
            request: { user: { username } },
            join: () => {},
            leave: () => {},
            emit: (message, ...args) => emitted.push({ message, args }),
            disconnect: () => {},
            on: () => {}
        };

        server.onConnection(ioSocket);

        return emitted;
    }

    it('closes the socket it supersedes instead of starving it', function () {
        const first = game.playersAndSpectators.alice.socket;

        connectAs('alice', 'sock-alice-2');

        expect(first.disconnected).toBe(true);
        expect(first.tIsClosing).toBe(true);
    });

    it('leaves the player pointing at the new socket, with a complete state', function () {
        const emitted = connectAs('alice', 'sock-alice-2');

        expect(game.playersAndSpectators.alice.id).toBe('sock-alice-2');
        expect(game.playersAndSpectators.alice.socket.id).toBe('sock-alice-2');
        expect(emitted[emitted.length - 1]).toEqual({
            message: 'gamestate',
            args: [states.alice, { full: true }]
        });
    });

    it('does not touch the opponent', function () {
        const bobSocket = game.playersAndSpectators.bob.socket;

        connectAs('alice', 'sock-alice-2');

        expect(bobSocket.disconnected).toBe(false);
    });
});

/**
 * Why the flag exists at all. This is what a client did when it guessed wrong
 * and handed a whole game state to jsondiffpatch as if it were a delta: not an
 * exception it could catch, but silent destruction — and, on any string value
 * (a player name, the phase, a card name, so: every real board), a loop that
 * never returns, which is a hung browser tab.
 *
 * Only the terminating cases are asserted here, for the obvious reason.
 */
describe('applying a complete board as if it were a delta', function () {
    it('silently deletes numbers instead of setting them', function () {
        expect(jsondiffpatch.patch({ amber: 2 }, { amber: 3 })).toEqual({});
    });

    it('silently deletes booleans instead of setting them', function () {
        expect(jsondiffpatch.patch({ activePlayer: false }, { activePlayer: true })).toEqual({});
    });

    it('replaces a card pile with a single card', function () {
        expect(
            jsondiffpatch.patch({ hand: [{ uuid: 'a' }] }, { hand: [{ uuid: 'a' }, { uuid: 'b' }] })
        ).toEqual({ hand: { uuid: 'b' } });
    });
});
