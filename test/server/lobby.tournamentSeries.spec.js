const Lobby = require('../../server/lobby');
const PendingGame = require('../../server/pendinggame');

/**
 * ARCHON: continuing a best-of series at the table, without racing the result.
 *
 * Reported from a live best-of-three: both players pressed "Play Game 2", a
 * table appeared in the lobby list, and nothing told them it was theirs. The
 * mechanism: the handler that seats them for the next game read the match
 * score from the database while the handler recording the last result was
 * still writing it. Seeing no wins yet, it asked the event which game the match
 * needed, was told "game one", and built a second game-one table - whose
 * result was later discarded as a duplicate - while the real game-two table sat
 * unjoined.
 *
 * These hold the REAL Lobby.prototype methods against REAL PendingGames, in the
 * seam style of lobby.tournamentTables.spec.js, because the fault is in the
 * ordering between two handlers and a stubbed lobby cannot see ordering.
 */
describe('Lobby tournament series continuation', function () {
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
    let attached;
    let sent;

    const socketFor = (user) => ({
        id: `sock-${user.username}`,
        user,
        joinChannel: vi.fn(),
        send: (...args) => sent.push([user.username, ...args])
    });

    const matchInfo = (gameNumber, overrides = {}) => ({
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
        attached = [];
        sent = [];
        lobby = {
            games: {},
            sockets: {},
            socketsByName: { alice: socketFor(alice), bob: socketFor(bob) },
            nextGameRetryDelayMs: 0,
            configService: { getValueForSection: () => 1000 },
            userService: {
                getUserByUsername: vi.fn(async (username) => (username === 'alice' ? alice : bob))
            },
            tournamentService: {
                attachGame: vi.fn(async (...args) => attached.push(args)),
                getMatchesNeedingGames: vi.fn(async () => []),
                recordGameWin: vi.fn(async () => ({ handled: true, matchComplete: false }))
            },
            router: { startGame: vi.fn().mockReturnValue({ identity: 'node1' }) },
            sendGameState: vi.fn(),
            broadcastGameMessage: vi.fn(),
            sendHandoff: vi.fn(),
            findGameForUser: Lobby.prototype.findGameForUser,
            applyDeckSelection: vi.fn(async () => {}),
            refuseUnpinnedStart: vi.fn(() => false),
            startTournamentGameIfReady: vi.fn(),
            reportAutoSelectFailure: Lobby.prototype.reportAutoSelectFailure,
            findTournamentGame: Lobby.prototype.findTournamentGame,
            seatTournamentPlayers: Lobby.prototype.seatTournamentPlayers,
            onTournamentNextGame: Lobby.prototype.onTournamentNextGame,
            onTournamentGameWin: Lobby.prototype.onTournamentGameWin,
            runForMatch: Lobby.prototype.runForMatch,
            awaitNextGameInfo: Lobby.prototype.awaitNextGameInfo,
            notifyPlayers: Lobby.prototype.notifyPlayers,
            staleTournamentTables: Lobby.prototype.staleTournamentTables,
            ensureTournamentGame: Lobby.prototype.ensureTournamentGame,
            createTournamentGame: Lobby.prototype.createTournamentGame
        };
    });

    const tablesForMatch = (matchId) =>
        Object.values(lobby.games).filter(
            (game) => game.tournament && game.tournament.matchId === matchId
        );

    /** A finished game-one table, as the node would report it. */
    const finishGameOne = async () => {
        const gameOne = await lobby.ensureTournamentGame(matchInfo(1));

        gameOne.started = true;

        return gameOne;
    };

    describe('when the last result has not landed yet', function () {
        it('waits for the event to ask for the next game rather than rebuilding the last', async function () {
            const gameOne = await finishGameOne();

            // The first read still says "game one is unplayed"; the second has
            // caught up. The old handler took the first answer and built it.
            lobby.tournamentService.getMatchesNeedingGames = vi
                .fn()
                .mockResolvedValueOnce([matchInfo(1)])
                .mockResolvedValueOnce([matchInfo(2)]);

            await lobby.onTournamentNextGame({ gameId: gameOne.id });

            const tables = tablesForMatch(7);

            expect(tables).toHaveLength(1);
            expect(tables[0].tournament.gameNumber).toBe(2);
            expect(Object.keys(tables[0].getPlayers()).sort()).toEqual(['alice', 'bob']);
        });

        it('opens nothing and tells both players when the result never arrives', async function () {
            const gameOne = await finishGameOne();

            lobby.tournamentService.getMatchesNeedingGames = vi.fn(async () => [matchInfo(1)]);

            await lobby.onTournamentNextGame({ gameId: gameOne.id });

            // No table for game one was rebuilt, and none for game two either:
            // the event has not said it wants one.
            expect(tablesForMatch(7)).toHaveLength(0);
            expect(attached.filter(([, , gameNumber]) => gameNumber === 1)).toHaveLength(1);

            for (const username of ['alice', 'bob']) {
                const notices = noticesFor(username);

                expect(notices).toHaveLength(1);
                expect(notices[0].message).toMatch(/still being recorded/);
                expect(notices[0].url).toBe('/tournaments/5');
            }
        });
    });

    describe('ordering against the result', function () {
        /**
         * THE REPORTED RACE. GAMEWIN arrives first and its handler is slow;
         * TOURNAMENTNEXTGAME arrives while it is still writing. The event
         * reports game one as needed until the write lands.
         */
        it('lets the result be recorded before deciding which game comes next', async function () {
            const gameOne = await finishGameOne();

            let recorded = false;
            let finishRecording;

            lobby.tournamentService.recordGameWin = vi.fn(
                () =>
                    new Promise((resolve) => {
                        finishRecording = () => {
                            recorded = true;
                            resolve({ handled: true, matchComplete: false, nextGameNumber: 2 });
                        };
                    })
            );
            lobby.tournamentService.getMatchesNeedingGames = vi.fn(async () => [
                matchInfo(recorded ? 2 : 1)
            ]);

            const gameWin = lobby.onTournamentGameWin({
                gameId: gameOne.id,
                tournament: { tournamentId: 5, matchId: 7 }
            });
            const nextGame = lobby.onTournamentNextGame({ gameId: gameOne.id });

            // Nothing about the next game may happen until the result is in.
            await new Promise((resolve) => setImmediate(resolve));
            expect(tablesForMatch(7)).toHaveLength(0);

            finishRecording();
            await Promise.all([gameWin, nextGame]);

            const tables = tablesForMatch(7);

            expect(tables).toHaveLength(1);
            expect(tables[0].tournament.gameNumber).toBe(2);
            // Built once - by the result handler - and reused by the seating.
            expect(attached.filter(([, , gameNumber]) => gameNumber === 2)).toHaveLength(1);
            expect(Object.keys(tables[0].getPlayers()).sort()).toEqual(['alice', 'bob']);
        });

        it('runs work for different matches independently', async function () {
            const order = [];

            const slow = lobby.runForMatch(1, async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                order.push('slow-1');
            });
            const other = lobby.runForMatch(2, async () => {
                order.push('fast-2');
            });
            const queued = lobby.runForMatch(1, async () => {
                order.push('queued-1');
            });

            await Promise.all([slow, other, queued]);

            expect(order).toEqual(['fast-2', 'slow-1', 'queued-1']);
        });

        it('keeps the queue moving when a piece of work throws', async function () {
            await lobby
                .runForMatch(3, async () => {
                    throw new Error('boom');
                })
                .catch(() => {});

            const ran = await lobby.runForMatch(3, async () => 'ran');

            expect(ran).toBe('ran');
        });
    });

    describe('what the players are told', function () {
        it('says the match is decided when no further game is wanted', async function () {
            const gameTwo = await lobby.ensureTournamentGame(matchInfo(2));

            gameTwo.started = true;
            lobby.tournamentService.getMatchesNeedingGames = vi.fn(async () => []);

            await lobby.onTournamentNextGame({ gameId: gameTwo.id });

            expect(tablesForMatch(7)).toHaveLength(0);

            for (const username of ['alice', 'bob']) {
                const notices = noticesFor(username);

                expect(notices).toHaveLength(1);
                expect(notices[0].tone).toBe('success');
                expect(notices[0].message).toMatch(/decided your match/);
            }
        });

        it('points a player it could not seat at the event page', async function () {
            const gameOne = await finishGameOne();

            // Bob's socket is gone - he closed the tab. Alice is seated; Bob is
            // told where to come back to.
            delete lobby.socketsByName.bob;
            lobby.tournamentService.getMatchesNeedingGames = vi.fn(async () => [matchInfo(2)]);

            await lobby.onTournamentNextGame({ gameId: gameOne.id });

            const [table] = tablesForMatch(7);

            expect(Object.keys(table.getPlayers())).toEqual(['alice']);
            expect(noticesFor('alice')).toHaveLength(0);
            // Bob has no socket, so nothing can reach him now - but the table
            // is there for him, and nothing else was built.
            expect(table.tournament.gameNumber).toBe(2);
        });

        it('tells a seated player whose registered deck failed to load', async function () {
            lobby.applyDeckSelection = vi.fn(async (game, username) => {
                if (username === 'bob') {
                    throw Object.assign(new Error('missing'), {
                        playerMessage: 'Deck 201 is not in your collection.'
                    });
                }
            });

            const game = await lobby.ensureTournamentGame(matchInfo(1));

            expect(Object.keys(game.getPlayers()).sort()).toEqual(['alice', 'bob']);

            const errors = sent.filter(([to, event]) => to === 'bob' && event === 'gameerror');

            expect(errors).toHaveLength(1);
            expect(errors[0][2]).toMatch(/could not be loaded/);
            expect(errors[0][2]).toMatch(/Deck 201 is not in your collection/);
            expect(sent.some(([to, event]) => to === 'alice' && event === 'gameerror')).toBe(false);
        });
    });

    describe('what the table knows about its seats', function () {
        it('carries each seat’s registered deck name onto the table', async function () {
            const game = await lobby.ensureTournamentGame(matchInfo(1));

            expect(game.tournament.deckNames).toEqual({ alice: 'Alpha Deck', bob: 'Bravo Deck' });
            expect(game.tournament.decks).toEqual({ alice: 101, bob: 201 });
        });

        it('has no name for a seat the event pinned nothing to', async function () {
            const game = await lobby.ensureTournamentGame(
                matchInfo(1, {
                    players: [
                        { username: 'alice', deckId: 101, deckName: 'Alpha Deck' },
                        { username: 'bob', deckId: null }
                    ]
                })
            );

            expect(game.tournament.deckNames).toEqual({ alice: 'Alpha Deck', bob: null });
        });
    });

    it('ignores a table that is not a tournament table', async function () {
        const casual = new PendingGame(alice, { name: 'casual' });

        lobby.games[casual.id] = casual;

        await lobby.onTournamentNextGame({ gameId: casual.id });

        expect(lobby.games[casual.id]).toBe(casual);
    });
});
