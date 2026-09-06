const Lobby = require('../../server/lobby');
const PendingGame = require('../../server/pendinggame');

/**
 * ARCHON: a tournament table must not start a game nobody agreed to play.
 *
 * Reported from a live event: "when I opened and joined my table it said my
 * opponent joined and it auto started the game and then gave me the win and
 * opened the next game." Three separate faults line up to produce that, and
 * these cover the two that live in the lobby.
 *
 * The first is consent. Opening a table on demand - one player pressing "Open
 * my table" on the event page, which is the whole of how an asynchronous event
 * is played - seated BOTH players from the mere fact that they had a lobby
 * socket open, and a table with two seated players starts itself. Somebody
 * reading the standings was dropped into a live game.
 *
 * The second is reachability. A seat records the socket id it was filled with,
 * and that id goes stale on every reconnect. The start used to log a missing
 * handoff and go ahead anyway, which leaves one player at a board and an
 * opponent who never learns the game exists - and the engine's abandonment
 * rules then hand the game to whoever is standing there.
 *
 * These hold the REAL Lobby.prototype methods against REAL PendingGames, in the
 * seam style of lobby.tournamentSeries.spec.js: a stubbed lobby cannot see a
 * fault whose whole nature is that two real methods disagree.
 */
describe('Lobby tournament table safety', function () {
    const makeUser = (username, id) => ({
        username,
        id,
        blockList: [],
        permissions: {},
        hasUserBlocked: () => false,
        getDetails: () => ({ username })
    });

    const alice = makeUser('alice', 11);
    const bob = makeUser('bob', 12);

    let lobby;
    let sent;
    let started;

    const socketFor = (user) => ({
        id: `sock-${user.username}`,
        user,
        joinChannel: vi.fn(),
        leaveChannel: vi.fn(),
        send: (...args) => sent.push([user.username, ...args])
    });

    const matchInfo = (gameNumber = 1, overrides = {}) => ({
        tournamentId: 5,
        tournamentName: 'Friday Night',
        matchId: 7,
        gameNumber,
        bestOf: 3,
        round: 1,
        table: 1,
        gameFormat: 'normal',
        deckSwapPolicy: 'locked',
        players: [
            { username: 'alice', deckId: 101, deckName: 'Alpha Deck' },
            { username: 'bob', deckId: 201, deckName: 'Bravo Deck' }
        ],
        ...overrides
    });

    const noticesFor = (username) =>
        sent.filter(([to, event]) => to === username && event === 'lobbynotice').map((x) => x[2]);

    beforeEach(function () {
        sent = [];
        started = [];

        const aliceSocket = socketFor(alice);
        const bobSocket = socketFor(bob);

        lobby = {
            games: {},
            sockets: { 'sock-alice': aliceSocket, 'sock-bob': bobSocket },
            socketsByName: { alice: aliceSocket, bob: bobSocket },
            configService: { getValueForSection: () => 1000 },
            userService: {
                getUserByUsername: vi.fn(async (username) => (username === 'alice' ? alice : bob))
            },
            tournamentService: {
                attachGame: vi.fn(async () => ({ success: true })),
                getMatchesNeedingGames: vi.fn(async () => []),
                describeMatchReadiness: vi.fn(async () => ({ state: 'ready' }))
            },
            router: {
                startGame: vi.fn((game) => {
                    started.push(game.id);

                    return { identity: 'node1' };
                })
            },
            matchmaking: { dequeue: vi.fn() },
            sendGameState: vi.fn(),
            broadcastGameMessage: vi.fn(),
            sendHandoff: vi.fn(),
            // The deck each seat is pinned to arrives already loaded; what is
            // under test is what happens once both seats hold one.
            applyDeckSelection: vi.fn(async (game, username, deckId) => {
                game.selectDeck(username, { id: deckId, name: `Deck ${deckId}` });
            }),
            refuseUnpinnedStart: vi.fn(() => false),
            reportAutoSelectFailure: vi.fn(),
            findGameForUser: Lobby.prototype.findGameForUser,
            gameForSocket: Lobby.prototype.gameForSocket,
            socketForSeat: Lobby.prototype.socketForSeat,
            findTournamentGame: Lobby.prototype.findTournamentGame,
            staleTournamentTables: Lobby.prototype.staleTournamentTables,
            notifyPlayers: Lobby.prototype.notifyPlayers,
            seatTournamentPlayers: Lobby.prototype.seatTournamentPlayers,
            startTournamentGameIfReady: Lobby.prototype.startTournamentGameIfReady,
            ensureTournamentGame: Lobby.prototype.ensureTournamentGame,
            createTournamentGame: Lobby.prototype.createTournamentGame,
            onTournamentEnsureMatchGame: Lobby.prototype.onTournamentEnsureMatchGame,
            onJoinGame: Lobby.prototype.onJoinGame,
            onLeaveGame: Lobby.prototype.onLeaveGame
        };
    });

    describe('a table opened on demand', function () {
        beforeEach(function () {
            lobby.tournamentService.getMatchesNeedingGames = vi.fn(async () => [matchInfo(1)]);
        });

        it('seats the player who asked and nobody else', async function () {
            const game = await lobby.onTournamentEnsureMatchGame({
                tournamentId: 5,
                matchId: 7,
                requestedBy: 'alice'
            });

            expect(game.getPlayerByName('alice')).toBeTruthy();
            expect(game.getPlayerByName('bob')).toBeUndefined();
        });

        it('does not start a game the other player has not sat down for', async function () {
            await lobby.onTournamentEnsureMatchGame({
                tournamentId: 5,
                matchId: 7,
                requestedBy: 'alice'
            });

            expect(started).toEqual([]);
            expect(lobby.router.startGame).not.toHaveBeenCalled();
        });

        it('tells the other player their table is waiting', async function () {
            await lobby.onTournamentEnsureMatchGame({
                tournamentId: 5,
                matchId: 7,
                requestedBy: 'alice'
            });

            const [notice] = noticesFor('bob');

            expect(notice).toBeTruthy();
            expect(notice.message).toMatch(/ready/i);
            expect(notice.url).toBe('/tournaments/5');
            // And the player who asked is at the table, not being told about it.
            expect(noticesFor('alice')).toEqual([]);
        });

        it('starts the game once that player joins of their own accord', async function () {
            const game = await lobby.onTournamentEnsureMatchGame({
                tournamentId: 5,
                matchId: 7,
                requestedBy: 'alice'
            });

            await lobby.onJoinGame(lobby.socketsByName.bob, game.id);
            // The deck selection the join kicks off is a promise chain.
            await new Promise((resolve) => setImmediate(resolve));

            expect(game.started).toBe(true);
            expect(started).toEqual([game.id]);
        });
    });

    describe('a round being paired', function () {
        it('still seats both players and starts their game', async function () {
            const game = await lobby.ensureTournamentGame(matchInfo(1));

            expect(game.getPlayerByName('alice')).toBeTruthy();
            expect(game.getPlayerByName('bob')).toBeTruthy();
            expect(game.started).toBe(true);
        });
    });

    describe('a seat nobody can be handed off to', function () {
        it('does not start the game', async function () {
            const game = await lobby.ensureTournamentGame(matchInfo(1));

            expect(game.started).toBe(true);

            // Rebuild the same table with bob's socket gone entirely: the seat
            // exists, the deck is in it, and there is nobody on the other end.
            const stranded = new PendingGame(alice, {
                name: 'Friday Night R1 T1: alice vs bob',
                tournament: game.tournament
            });

            stranded.newGame('sock-alice', alice, undefined, true);
            stranded.join('sock-gone', bob);
            stranded.selectDeck('alice', { id: 101, name: 'Alpha Deck' });
            stranded.selectDeck('bob', { id: 201, name: 'Bravo Deck' });
            lobby.games[stranded.id] = stranded;

            delete lobby.sockets['sock-gone'];
            delete lobby.socketsByName.bob;
            lobby.router.startGame.mockClear();

            lobby.startTournamentGameIfReady(stranded);

            expect(stranded.started).toBeFalsy();
            expect(lobby.router.startGame).not.toHaveBeenCalled();
        });

        it('starts it anyway when the seat is simply on a newer socket', function () {
            const game = new PendingGame(alice, {
                name: 'Friday Night R1 T1: alice vs bob',
                tournament: {
                    tournamentId: 5,
                    matchId: 7,
                    gameNumber: 1,
                    bestOf: 3,
                    players: ['alice', 'bob'],
                    decks: { alice: 101, bob: 201 }
                }
            });

            game.newGame('sock-alice', alice, undefined, true);
            // Seated on a socket that has since been replaced by a reconnect -
            // the player is here, on a different connection.
            game.join('sock-bob-old', bob);
            game.selectDeck('alice', { id: 101, name: 'Alpha Deck' });
            game.selectDeck('bob', { id: 201, name: 'Bravo Deck' });
            lobby.games[game.id] = game;

            lobby.startTournamentGameIfReady(game);

            expect(game.started).toBe(true);
        });
    });

    describe('answering an open-table request', function () {
        it('refuses to hand a started table to somebody not sitting at it', async function () {
            const game = await lobby.ensureTournamentGame(matchInfo(1));

            expect(game.started).toBe(true);
            game.leave('bob');

            lobby.tournamentService.getMatchesNeedingGames = vi.fn(async () => [matchInfo(1)]);

            const answer = await lobby.ensureTournamentGame(matchInfo(1), { seatOnly: 'bob' });

            expect(answer).toBeNull();
        });

        it('hands a started table back to the player who is in it, so they can rejoin', async function () {
            const game = await lobby.ensureTournamentGame(matchInfo(1));

            const answer = await lobby.ensureTournamentGame(matchInfo(1), { seatOnly: 'alice' });

            expect(answer).toBe(game);
        });
    });

    describe('leaving', function () {
        it('leaves the game the client named, not the first one it finds', function () {
            const finished = new PendingGame(alice, {
                name: 'game one',
                tournament: { tournamentId: 5, matchId: 7, gameNumber: 1, players: ['alice'] }
            });

            finished.newGame('sock-alice', alice, undefined, true);
            finished.started = true;
            lobby.games[finished.id] = finished;

            const next = new PendingGame(alice, {
                name: 'game two',
                tournament: { tournamentId: 5, matchId: 7, gameNumber: 2, players: ['alice'] }
            });

            next.newGame('sock-alice', alice, undefined, true);
            lobby.games[next.id] = next;

            lobby.onLeaveGame(lobby.socketsByName.alice, finished.id);

            // The seat given up is the one at the finished game; the table for
            // the game they are about to play is untouched.
            expect(finished.getPlayerByName('alice').left).toBe(true);
            expect(next.getPlayerByName('alice')).toBeTruthy();
        });
    });
});
