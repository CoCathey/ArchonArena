const Lobby = require('../../server/lobby');
const PendingGame = require('../../server/pendinggame');

/**
 * ARCHON: one table per game of a match, however many times anybody asks.
 *
 * Reported from a live best-of-three: after game one finished, the match had
 * FOUR tables for game two, the player's own button appeared to do nothing, and
 * the end-of-game screen offered a rematch that led nowhere.
 *
 * All of it came from one ambiguity. A tournament table used to be looked up by
 * match id alone, and a best-of-three has a table per game with the finished
 * ones still in the lobby - so "the game for match 7" returned whichever was
 * inserted first, which after game one is always the FINISHED game one. The
 * creation guard compared that stale table's game number against the one being
 * asked for, found them different, and built another table. Every time.
 *
 * These hold the real Lobby methods against real PendingGames, in the seam
 * style of the other lobby specs: the bug lived between the lookup and the
 * guard, which a fully stubbed test cannot see.
 */
describe('Lobby tournament tables', function () {
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
            { username: 'alice', deckId: null },
            { username: 'bob', deckId: null }
        ],
        ...overrides
    });

    beforeEach(function () {
        attached = [];
        lobby = {
            games: {},
            sockets: {},
            socketsByName: {},
            configService: { getValueForSection: () => 1000 },
            userService: {
                getUserByUsername: vi.fn(async (username) => (username === 'alice' ? alice : bob)),
                // ARCHON: the table's owner - a real user, not the plain row
                // `getUserByUsername` returns - because `isVisibleFor` calls
                // `owner.hasUserBlocked(...)` on every broadcast.
                getFullUserByUsername: vi.fn(async (username) =>
                    username === 'alice' ? alice : bob
                )
            },
            tournamentService: {
                attachGame: vi.fn(async (...args) => attached.push(args)),
                getMatchesNeedingGames: vi.fn(async () => []),
                describeMatchReadiness: vi.fn(async () => ({ state: 'complete' }))
            },
            router: { startGame: vi.fn().mockReturnValue({ identity: 'node1' }) },
            sendGameState: vi.fn(),
            broadcastGameMessage: vi.fn(),
            sendHandoff: vi.fn(),
            socketForSeat: Lobby.prototype.socketForSeat,
            findGameForUser: vi.fn(() => null),
            applyDeckSelection: vi.fn(),
            refuseUnpinnedStart: vi.fn(() => false),
            startTournamentGameIfReady: vi.fn(),
            findTournamentGame: Lobby.prototype.findTournamentGame,
            seatTournamentPlayers: Lobby.prototype.seatTournamentPlayers,
            onTournamentNextGame: Lobby.prototype.onTournamentNextGame,
            // The collaborators onTournamentNextGame grew: the per-match queue,
            // the wait for the result to land, and the player notice.
            runForMatch: Lobby.prototype.runForMatch,
            awaitNextGameInfo: Lobby.prototype.awaitNextGameInfo,
            notifyPlayers: Lobby.prototype.notifyPlayers,
            nextGameRetryDelayMs: 0,
            staleTournamentTables: Lobby.prototype.staleTournamentTables,
            ensureTournamentGame: Lobby.prototype.ensureTournamentGame,
            createTournamentGame: Lobby.prototype.createTournamentGame,
            onTournamentEnsureMatchGame: Lobby.prototype.onTournamentEnsureMatchGame
        };
    });

    const tablesForMatch = (matchId) =>
        Object.values(lobby.games).filter(
            (game) => game.tournament && game.tournament.matchId === matchId
        );

    describe('creating the table for a game', function () {
        it('creates one and hands it back', async function () {
            const game = await lobby.ensureTournamentGame(matchInfo(1));

            expect(game).toBeTruthy();
            expect(game.tournament.gameNumber).toBe(1);
            expect(tablesForMatch(7)).toHaveLength(1);
        });

        it('returns the same table when asked again', async function () {
            const first = await lobby.ensureTournamentGame(matchInfo(1));
            const second = await lobby.ensureTournamentGame(matchInfo(1));

            expect(second).toBe(first);
            expect(tablesForMatch(7)).toHaveLength(1);
        });

        /**
         * THE REPORTED BUG. Game one is finished and started, and its table is
         * still in the lobby. Every subsequent ask for game two used to build
         * another table, because the lookup returned the game-one table and the
         * guard only compared game numbers.
         */
        it('does not build a new table each time once a game has finished', async function () {
            const gameOne = await lobby.ensureTournamentGame(matchInfo(1));

            gameOne.started = true;

            const first = await lobby.ensureTournamentGame(matchInfo(2));

            // Everything else that can ask, asking: the automatic open after
            // the win, the player pressing the button, and a second press.
            const repeats = [
                await lobby.ensureTournamentGame(matchInfo(2)),
                await lobby.ensureTournamentGame(matchInfo(2)),
                await lobby.ensureTournamentGame(matchInfo(2))
            ];

            // The same table every time, not a fresh one that happens to be
            // the only survivor. Counting what is left in the lobby is not
            // enough on its own: the duplicate reaping would tidy away each
            // previous table as the next was built, hiding a create-and-delete
            // churn behind a correct-looking final count.
            for (const again of repeats) {
                expect(again).toBe(first);
            }

            expect(
                tablesForMatch(7).filter((game) => game.tournament.gameNumber === 2)
            ).toHaveLength(1);

            // And it was built once. attachGame is the write that ties a table
            // to the match, so one call is one table ever created.
            expect(attached.filter(([, , gameNumber]) => gameNumber === 2)).toHaveLength(1);
        });

        // Two presses landing together: both used to find nothing, both waited
        // on the user lookups, and both created a table.
        it('creates one table when two requests arrive at once', async function () {
            const results = await Promise.all([
                lobby.ensureTournamentGame(matchInfo(1)),
                lobby.ensureTournamentGame(matchInfo(1)),
                lobby.ensureTournamentGame(matchInfo(1))
            ]);

            expect(tablesForMatch(7)).toHaveLength(1);
            // Exactly one call created it; the others declined rather than
            // duplicating.
            expect(results.filter(Boolean)).toHaveLength(1);
        });

        it('keeps a finished game table while removing an unstarted duplicate', async function () {
            const gameOne = await lobby.ensureTournamentGame(matchInfo(1));

            gameOne.started = true;

            // A leftover from before the guards, sitting unstarted.
            const orphan = new PendingGame(alice, {
                name: 'orphan',
                tournament: { matchId: 7, tournamentId: 5, gameNumber: 2, players: [] }
            });

            lobby.games[orphan.id] = orphan;

            await lobby.ensureTournamentGame(matchInfo(3));

            const ids = tablesForMatch(7).map((game) => game.id);

            expect(ids).toContain(gameOne.id);
            expect(ids).not.toContain(orphan.id);
        });
    });

    describe('finding a table', function () {
        it('finds the one for the game asked about, not the first for the match', async function () {
            const gameOne = await lobby.ensureTournamentGame(matchInfo(1));

            gameOne.started = true;

            const gameTwo = await lobby.ensureTournamentGame(matchInfo(2));

            expect(lobby.findTournamentGame(7, 1)).toBe(gameOne);
            expect(lobby.findTournamentGame(7, 2)).toBe(gameTwo);
            // Without a game number it is the old, ambiguous question - still
            // answerable, and still the first one.
            expect(lobby.findTournamentGame(7)).toBe(gameOne);
        });
    });

    /**
     * ARCHON: "can we make it where the current table just lets you click a
     * button to make that table the table for game 2".
     *
     * The next game's table already exists - opening it is the first thing
     * that happens when a result is recorded - so continuing a series is not a
     * question of creating anything. It is a question of retiring the table
     * that just finished and putting the two players in the seats of the one
     * that is waiting, without either of them going to look for it.
     */
    describe('continuing the series at the table', function () {
        it('retires the finished table and seats both players at the next one', async function () {
            const gameOne = await lobby.ensureTournamentGame(matchInfo(1));

            gameOne.started = true;
            lobby.socketsByName = {
                alice: { id: 'sock-a', user: alice, joinChannel: vi.fn() },
                bob: { id: 'sock-b', user: bob, joinChannel: vi.fn() }
            };
            lobby.tournamentService.getMatchesNeedingGames = vi.fn(async () => [matchInfo(2)]);

            await lobby.onTournamentNextGame({ gameId: gameOne.id });

            // The finished table is gone...
            expect(lobby.games[gameOne.id]).toBeUndefined();

            // ...and exactly one table remains, for game two, with both seats
            // filled.
            const remaining = tablesForMatch(7);

            expect(remaining).toHaveLength(1);
            expect(remaining[0].tournament.gameNumber).toBe(2);
            expect(Object.keys(remaining[0].getPlayers()).sort()).toEqual(['alice', 'bob']);
            expect(lobby.startTournamentGameIfReady).toHaveBeenCalled();
        });

        // A best-of-three decided 2-0 has no game three. Nothing to open, and
        // nobody left waiting at a table for a game that will never come.
        it('opens nothing when the match is already decided', async function () {
            const gameTwo = await lobby.ensureTournamentGame(matchInfo(2));

            gameTwo.started = true;
            lobby.tournamentService.getMatchesNeedingGames = vi.fn(async () => []);

            await lobby.onTournamentNextGame({ gameId: gameTwo.id });

            expect(tablesForMatch(7)).toHaveLength(0);
        });

        it('ignores a table that is not a tournament table', async function () {
            const casual = new PendingGame(alice, { name: 'casual' });

            lobby.games[casual.id] = casual;

            await lobby.onTournamentNextGame({ gameId: casual.id });

            expect(lobby.games[casual.id]).toBe(casual);
        });
    });

    /**
     * The request behind "why do you have to wait so long after you request a
     * table". It used to be fire-and-forget: the API said success before
     * anything existed, so the button did not change and people pressed it
     * again. It now answers with the table.
     */
    describe('answering an open-table request', function () {
        it('returns the table it created', async function () {
            lobby.tournamentService.getMatchesNeedingGames = vi.fn(async () => [matchInfo(1)]);

            const game = await lobby.onTournamentEnsureMatchGame({
                tournamentId: 5,
                matchId: 7
            });

            expect(game).toBeTruthy();
            expect(game.tournament.matchId).toBe(7);
        });

        // The match already has its table and needs no new one: the player
        // should be sent to it, not told nothing happened.
        it('returns the existing table when nothing needs creating', async function () {
            const existing = await lobby.ensureTournamentGame(matchInfo(1));

            lobby.tournamentService.getMatchesNeedingGames = vi.fn(async () => []);

            const game = await lobby.onTournamentEnsureMatchGame({
                tournamentId: 5,
                matchId: 7
            });

            expect(game).toBe(existing);
        });
    });
});
