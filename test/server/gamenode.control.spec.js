const EventEmitter = require('events');

const GameSocket = require('../../server/gamenode/gamesocket.js');
const GameServer = require('../../server/gamenode/gameserver.js');

// Both constructors connect to Redis and open sockets, so the objects under test
// are built from the prototype - the same approach as gameRouterGameWin.spec.js.
const buildSocket = (fields = {}) => {
    const socket = Object.create(GameSocket.prototype);

    EventEmitter.call(socket);

    socket.nodeName = 'node-0';
    socket.version = 'test-build';
    socket.isDraining = false;
    socket.maxGames = undefined;
    socket.sent = [];
    socket.send = (command, arg) => socket.sent.push({ command, arg });

    return Object.assign(socket, fields);
};

const buildServer = (games = {}) => {
    const server = Object.create(GameServer.prototype);

    server.games = games;
    server.sent = [];
    server.gameSocket = {
        send: (command, arg) => server.sent.push({ command, arg })
    };

    return server;
};

const game = (id, overrides = {}) => ({
    id,
    getSaveState: () => ({ gameId: id }),
    getReplay: () => ({ log: [id] }),
    ...overrides
});

describe('game node control messages', function () {
    describe('RESTART', function () {
        /**
         * The regression. This used to `spawnSync('pm2', ['restart', ...])`,
         * inherited from an upstream deployment that ran under pm2. Nothing in
         * this stack installs pm2, so the admin panel's Restart button ran a
         * command that did not exist, reported nothing, and did nothing.
         */
        it('asks for a graceful restart rather than shelling out to pm2', function () {
            const socket = buildSocket();
            const requests = [];

            socket.on('onRestartRequested', () => requests.push(true));

            socket.onMessage(JSON.stringify({ command: 'RESTART' }), 'node-0');

            expect(requests).toEqual([true]);
        });

        it('drains the node instead of killing its games', function () {
            const server = buildServer();
            const drains = [];

            server.healthServer = { startDraining: () => drains.push(true) };

            server.onRestartRequested();

            expect(drains).toEqual([true]);
        });

        it('survives a restart arriving before the health server is up', function () {
            const server = buildServer();

            server.healthServer = undefined;

            expect(() => server.onRestartRequested()).not.toThrow();
        });
    });

    describe('HELLO', function () {
        it('advertises no cap when none is configured', function () {
            const socket = buildSocket();

            socket.onGameSync([]);

            expect(socket.sent[0].command).toBe('HELLO');
            expect(socket.sent[0].arg.maxGames).toBeUndefined();
        });

        it('advertises the configured cap', function () {
            const socket = buildSocket({ maxGames: 40 });

            socket.onGameSync([]);

            expect(socket.sent[0].arg.maxGames).toBe(40);
        });

        // maxGames: 0 is how a draining node tells the lobby to place nothing
        // here - the router reads any finite cap, including zero, as a limit.
        it('advertises a zero cap while draining', function () {
            const socket = buildSocket({ maxGames: 40, isDraining: true });

            socket.onGameSync([]);

            expect(socket.sent[0].arg.maxGames).toBe(0);
            expect(socket.sent[0].arg.draining).toBe(true);
        });
    });

    describe('LOBBYHELLO', function () {
        it('syncs the game list and announces that the lobby is back', function () {
            const socket = buildSocket();
            const events = [];

            socket.on('onGameSync', () => events.push('sync'));
            socket.on('onLobbyReconnected', () => events.push('reconnected'));

            socket.onMessage(JSON.stringify({ command: 'LOBBYHELLO' }), 'allnodes');

            // Order matters: the lobby has to know this node exists before it is
            // sent anything about that node's games.
            expect(events).toEqual(['sync', 'reconnected']);
        });
    });

    /**
     * Node -> lobby messages go over Redis pub/sub, which does not buffer:
     * anything published while the lobby's subscriber is down is dropped, with no
     * ack and no retry. A GAMEWIN lost that way is a game that finished and was
     * then never recorded - no Games row, no replay, no rating - and a lobby
     * restart during a rebuild is exactly when it happens.
     */
    describe('re-reporting finished games when the lobby comes back', function () {
        it('re-sends the result of a game that finished', function () {
            const finished = game('game-1', {
                reportedWin: { winner: 'alice', reason: 'keys' }
            });
            const server = buildServer({ 'game-1': finished });

            server.onLobbyReconnected();

            expect(server.sent).toHaveLength(1);
            expect(server.sent[0].command).toBe('GAMEWIN');
            expect(server.sent[0].arg).toMatchObject({
                game: { gameId: 'game-1' },
                winner: 'alice',
                reason: 'keys',
                replay: { log: ['game-1'] }
            });
        });

        it('says nothing about games still being played', function () {
            const server = buildServer({
                'game-1': game('game-1'),
                'game-2': game('game-2')
            });

            server.onLobbyReconnected();

            expect(server.sent).toEqual([]);
        });

        it('re-sends only the finished ones', function () {
            const server = buildServer({
                'game-1': game('game-1'),
                'game-2': game('game-2', { reportedWin: { winner: 'bob', reason: 'concede' } })
            });

            server.onLobbyReconnected();

            expect(server.sent).toHaveLength(1);
            expect(server.sent[0].arg.winner).toBe('bob');
        });

        it('records the result at the time the game is won, so it can be re-sent', function () {
            const won = game('game-1');
            const server = buildServer({ 'game-1': won });

            server.gameWon(won, 'keys', { name: 'alice' });

            expect(server.sent).toHaveLength(1);
            expect(won.reportedWin).toEqual({ winner: 'alice', reason: 'keys' });

            server.onLobbyReconnected();

            expect(server.sent).toHaveLength(2);
            expect(server.sent[1].arg).toMatchObject({ winner: 'alice', reason: 'keys' });
        });
    });
});
