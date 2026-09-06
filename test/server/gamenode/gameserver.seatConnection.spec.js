const GameServer = require('../../../server/gamenode/gameserver.js');

/**
 * ARCHON: a game connection goes to the game it was handed off to.
 *
 * Reported from a live best-of-three: "when I opened and joined my table it
 * said my opponent joined and it auto started the game and then gave me the win
 * and opened the next game." Nothing of the sort had happened. The player was
 * put back into game ONE - which the node keeps for twenty minutes after it
 * ends so its players can read the result - and shown its state: the opponent's
 * join, the start, the win, and the button offering game two.
 *
 * The cause was that the node ignored the game id in the handoff and asked
 * "which of my games is this user in?" instead. During a series that question
 * has two answers, and it answered with the older one.
 *
 * The constructor connects to Redis, so the object under test is built from the
 * prototype - the same approach as gameserver.abandonment.spec.js.
 */
const buildServer = (games = {}) => {
    const server = Object.create(GameServer.prototype);

    server.games = games;
    server.pushed = [];
    server.configService = { getValue: () => 'secret' };
    server.sendGameState = (game) => server.pushed.push(game.id);
    server.onGameMessage = () => {};
    server.onSocketDisconnected = () => {};

    return server;
};

const buildGame = (id, { username, finishedAt, winner, spectator = false } = {}) => {
    const player = {
        name: username,
        id: 'lobby-id',
        socket: undefined,
        disconnectedAt: undefined
    };

    return {
        id,
        finishedAt,
        winner,
        alerts: [],
        jsonForUsers: {},
        playersAndSpectators: username ? { [username]: player } : {},
        isSpectator: () => spectator,
        addAlert: function (...args) {
            this.alerts.push(args);
        },
        reconnect: vi.fn(),
        player
    };
};

const buildSocket = (username, gameId) => {
    const socket = {
        id: 'sock-1',
        request: { user: { username, settings: {} } },
        joined: [],
        disconnected: false,
        handlers: {},
        on: (event, handler) => {
            socket.handlers[event] = handler;
        },
        join: (channel) => socket.joined.push(channel),
        leave: () => {},
        emit: () => {},
        disconnect: () => {
            socket.disconnected = true;
        }
    };

    if (gameId !== undefined) {
        socket.request.gameId = gameId;
    }

    return socket;
};

describe('GameServer.seatConnection', function () {
    describe('the game id from the handoff', function () {
        it('seats the player at the game they were handed off to, not the first one they are in', function () {
            const finished = buildGame('game-one', {
                username: 'alice',
                finishedAt: new Date(),
                winner: { name: 'alice' }
            });
            const current = buildGame('game-two', { username: 'alice' });
            // Insertion order matters: the finished game is found first.
            const server = buildServer({ 'game-one': finished, 'game-two': current });

            server.seatConnection(buildSocket('alice', 'game-two'));

            expect(current.player.socket).toBeTruthy();
            expect(finished.player.socket).toBeUndefined();
            expect(server.pushed).toEqual(['game-two']);
        });

        it('refuses a connection for a game that is not the user’s', function () {
            const theirs = buildGame('game-one', { username: 'alice' });
            const somebody_elses = buildGame('game-two', { username: 'bob' });
            const server = buildServer({ 'game-one': theirs, 'game-two': somebody_elses });

            const socket = buildSocket('alice', 'game-two');
            server.seatConnection(socket);

            expect(socket.disconnected).toBe(true);
            expect(somebody_elses.player.socket).toBeUndefined();
            // And it does not quietly fall back to the game they ARE in: the
            // client asked for something specific and was wrong about it.
            expect(theirs.player.socket).toBeUndefined();
        });

        it('refuses a connection for a game that is gone', function () {
            const server = buildServer({
                'game-one': buildGame('game-one', { username: 'alice' })
            });

            const socket = buildSocket('alice', 'game-nine');
            server.seatConnection(socket);

            expect(socket.disconnected).toBe(true);
        });
    });

    describe('without a game id (an older client)', function () {
        it('prefers a game that is still being played over one that is decided', function () {
            const finished = buildGame('game-one', {
                username: 'alice',
                finishedAt: new Date(),
                winner: { name: 'alice' }
            });
            const current = buildGame('game-two', { username: 'alice' });
            const server = buildServer({ 'game-one': finished, 'game-two': current });

            server.seatConnection(buildSocket('alice'));

            expect(current.player.socket).toBeTruthy();
            expect(finished.player.socket).toBeUndefined();
        });

        it('still seats a player whose only game is a finished one', function () {
            const finished = buildGame('game-one', {
                username: 'alice',
                finishedAt: new Date(),
                winner: { name: 'alice' }
            });
            const server = buildServer({ 'game-one': finished });

            server.seatConnection(buildSocket('alice'));

            expect(finished.player.socket).toBeTruthy();
        });
    });

    it('records that the seat reached the board, so an abandonment can be judged', function () {
        const game = buildGame('game-one', { username: 'alice' });
        const server = buildServer({ 'game-one': game });

        server.seatConnection(buildSocket('alice', 'game-one'));

        expect(game.player.connectionSucceeded).toBe(true);
    });
});
