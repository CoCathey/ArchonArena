const Lobby = require('../../server/lobby');
const PendingGame = require('../../server/pendinggame');

/**
 * ARCHON: a lobby socket that has already been replaced is not a player
 * leaving.
 *
 * A connection can be superseded while the old one is still open - a network
 * blip reconnects the client in a second or two, but the server does not
 * declare the old socket dead until its ping times out, much later; a second
 * tab does the same thing on purpose. When that late `disconnect` finally
 * arrived, this handler tore down the user's CURRENT state: it deleted their
 * name-to-socket entry and their user record, announced them as gone, and
 * removed them from a table they were still sitting at. Nothing ever put any
 * of it back.
 *
 * The rematch is where that was felt. Seating players for a rematch looks them
 * up by name, so a missing entry meant the rematch was refused - and a refusal
 * comes after the game node has already torn the finished game down, so both
 * players had pressed Rematch and been dropped out of their game.
 *
 * These drive the real handler against a minimal `this`, the same approach as
 * lobby.onLeaveGame.spec.js.
 */
function makeUser(username) {
    return {
        username,
        id: username,
        blockList: [],
        hasUserBlocked: () => false,
        getDetails: () => ({ username }),
        getShortSummary: () => ({ username })
    };
}

function makeSocket(username, id) {
    return { id, user: makeUser(username), send: () => {}, leaveChannel: () => {} };
}

describe('Lobby.onSocketDisconnected', function () {
    let lobby;
    let table;
    let broadcasts;
    let dequeued;
    let first;
    let second;

    beforeEach(function () {
        broadcasts = [];
        dequeued = [];

        first = makeSocket('alice', 'sock-alice-1');
        second = makeSocket('alice', 'sock-alice-2');

        table = new PendingGame(makeUser('alice'), { gameFormat: 'normal' });
        table.newGame('sock-alice-1', makeUser('alice'), undefined, true);

        lobby = {
            games: { [table.id]: table },
            sockets: { 'sock-alice-1': first, 'sock-alice-2': second },
            socketsByName: { alice: first },
            users: { alice: first.user },
            matchmaking: { dequeue: (name) => dequeued.push(name) },
            broadcastUserMessage: (user, message) =>
                broadcasts.push({ message, username: user.username }),
            broadcastGameMessage: (message, game) => broadcasts.push({ message, id: game.id }),
            sendGameState: () => {},
            findGameForUser: Lobby.prototype.findGameForUser,
            onSocketDisconnected: Lobby.prototype.onSocketDisconnected
        };
    });

    describe('the only socket a player has', function () {
        beforeEach(function () {
            lobby.onSocketDisconnected(first, 'transport close');
        });

        it('is treated as the player leaving', function () {
            expect(lobby.socketsByName.alice).toBeUndefined();
            expect(lobby.users.alice).toBeUndefined();
            expect(lobby.sockets['sock-alice-1']).toBeUndefined();
        });

        it('announces them as gone and takes them out of the queue', function () {
            expect(broadcasts.some((entry) => entry.message === 'userleft')).toBe(true);
            expect(dequeued).toEqual(['alice']);
        });

        it('takes them off the table they were waiting at', function () {
            expect(table.players.alice).toBeUndefined();
        });
    });

    describe('a socket that has already been replaced', function () {
        beforeEach(function () {
            // The reconnect landed first; this is the old connection's ping
            // finally timing out afterwards.
            lobby.socketsByName.alice = second;

            lobby.onSocketDisconnected(first, 'ping timeout');
        });

        it('leaves the live connection registered', function () {
            expect(lobby.socketsByName.alice).toBe(second);
            expect(lobby.users.alice).toBeDefined();
        });

        it('still forgets the socket itself', function () {
            expect(lobby.sockets['sock-alice-1']).toBeUndefined();
            expect(lobby.sockets['sock-alice-2']).toBe(second);
        });

        it('does not announce a player who is still here as gone', function () {
            expect(broadcasts.some((entry) => entry.message === 'userleft')).toBe(false);
            expect(dequeued).toEqual([]);
        });

        it('leaves them at the table they are still sitting at', function () {
            expect(table.players.alice).toBeDefined();
        });
    });
});
