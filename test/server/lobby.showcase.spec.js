const Lobby = require('../../server/lobby');
const BotService = require('../../server/services/botgames/BotService');
const { BOT_ROSTER } = require('../../server/services/botgames/roster');
const User = require('../../server/models/User');

/**
 * ARCHON (F9): the bot-vs-bot showcase - the last unbuilt piece of the empty-
 * lobby answer. `runShowcaseSweep` keeps `bots.showcaseTableCount` tables
 * running with BOTH seats played by the roster and nobody able to join, so a
 * logged-out visitor always has something live to watch on `/watch`.
 *
 * Reuses the exact harness `lobby.botTables.spec.js` pins for the practice
 * table: the real Lobby.prototype methods against a real BotService with
 * stubbed user/deck services.
 */

const botUserRow = (id, username, house) =>
    new User({
        id,
        username,
        email: `bot+${house}@archon-bots.invalid`,
        settings: {},
        permissions: {},
        blockList: []
    });

describe('the bot-vs-bot showcase', function () {
    let config;
    let lobby;
    let service;
    let db;
    let accounts;
    let houseDecks;

    const makeDb = () => {
        const bindings = new Map(
            BOT_ROSTER.map((entry, index) => [entry.house, { userId: 100 + index, enabled: true }])
        );

        accounts = new Map(
            BOT_ROSTER.map((entry, index) => [
                100 + index,
                botUserRow(100 + index, entry.defaultName, entry.house)
            ])
        );

        return {
            bindings,
            queries: [],
            query: async (sql, params) => {
                db.queries.push({ sql, params });

                if (sql.includes('FROM "Bots"')) {
                    return [...bindings.entries()].map(([house, binding]) => ({
                        House: house,
                        UserId: binding.userId,
                        Enabled: binding.enabled
                    }));
                }

                return [];
            }
        };
    };

    const makeLobby = () => {
        const made = Object.create(Lobby.prototype);

        made.games = {};
        made.sockets = {};
        made.socketsByName = {};
        made.botService = service;
        made.lastShowcaseDeckWarnMs = 0;
        made.broadcasts = [];
        made.broadcastGameMessage = (message, game) =>
            made.broadcasts.push({ message, gameId: game.id });
        made.sendGameState = () => {};
        made.handoffs = [];
        made.sendHandoff = () => {};
        made.closedGameIds = [];
        made.router = {
            startGame: () => ({ identity: 'node-1', port: 1234, protocol: 'http' }),
            closeGame: (game) => made.closedGameIds.push(game.id)
        };
        made.applyDeckSelection = async (game, username, deckId, isStandalone) => {
            game.selectDeck(username, { id: deckId, name: `Deck ${deckId}`, isStandalone });
        };

        return made;
    };

    beforeEach(function () {
        config = {
            showcaseEnabled: true,
            showcaseTableCount: 1,
            showcaseDifficulty: 'medium',
            defaultDifficulty: 'medium',
            thinkMs: 0,
            maxTurns: 80
        };
        db = makeDb();
        // Every house has one deck in the library, at every difficulty.
        houseDecks = new Map(BOT_ROSTER.map((entry, index) => [entry.house, 900 + index]));

        service = new BotService({
            userService: {
                getUserById: async (id) => accounts.get(id) || null,
                getUserByEmail: async () => null,
                getUserByUsername: async (name) =>
                    [...accounts.values()].find(
                        (user) => user.username.toLowerCase() === String(name).toLowerCase()
                    ) || null,
                addUser: async (user) => user
            },
            deckService: {
                getRandomPracticeDeckId: async ({ house, minAri, maxAri } = {}) => {
                    void minAri;
                    void maxAri;

                    return houseDecks.has(house) ? houseDecks.get(house) : null;
                },
                getStandaloneDecks: async () => [],
                countPracticeDecks: async ({ house } = {}) => (houseDecks.has(house) ? 1 : 0)
            },
            settingsService: { getSectionWithDefaults: () => config },
            db
        });
        service.policyService.champion = async () => null;

        lobby = makeLobby();
    });

    const showcaseGames = () => Object.values(lobby.games).filter((game) => game.showcaseGame);

    it('is a method the lobby actually defines', function () {
        expect(typeof Lobby.prototype.runShowcaseSweep).toBe('function');
    });

    it('does nothing while the showcase is off', async function () {
        config.showcaseEnabled = false;

        await lobby.runShowcaseSweep();

        expect(showcaseGames().length).toBe(0);
    });

    it('opens a showcase table with two distinct bots, both seated and started', async function () {
        await lobby.runShowcaseSweep();

        const games = showcaseGames();

        expect(games.length).toBe(1);

        const [game] = games;
        const seats = Object.values(game.getPlayers());

        expect(game.botGame).toBe(true);
        expect(seats.length).toBe(2);
        expect(seats.every((seat) => seat.isBot)).toBe(true);
        expect(seats.every((seat) => seat.id === 'TBA')).toBe(true);
        expect(seats[0].name).not.toBe(seats[1].name);
        // Both decks were dealt before the table was published/started.
        expect(seats.every((seat) => !!seat.deck)).toBe(true);
        expect(game.started).toBe(true);
        expect(lobby.broadcasts.some((entry) => entry.message === 'newgame')).toBe(true);
    });

    it('never seats the same bot against itself, even under a tight roster', async function () {
        // Only two houses can actually play, so pickShowcasePair has to reach
        // for both of them rather than looping back to the first.
        houseDecks = new Map([
            ['dis', 42],
            ['logos', 43]
        ]);

        await lobby.runShowcaseSweep();

        const [game] = showcaseGames();
        const seats = Object.values(game.getPlayers());

        expect(new Set(seats.map((seat) => seat.name)).size).toBe(2);
    });

    it('opens nothing when fewer than two bots can play', async function () {
        houseDecks = new Map([['dis', 42]]);

        await lobby.runShowcaseSweep();

        expect(showcaseGames().length).toBe(0);
    });

    it('never reuses a bot that is already hosting a practice table', async function () {
        houseDecks = new Map([
            ['dis', 42],
            ['logos', 43]
        ]);

        // Dis is already busy elsewhere in the lobby.
        const busyGame = { getPlayers: () => ({ Snudge: { name: 'Snudge' } }) };
        lobby.games['busy-table'] = busyGame;

        await lobby.runShowcaseSweep();

        // With only Logos free, a pair cannot be formed.
        expect(showcaseGames().length).toBe(0);
    });

    it('opens more tables to reach the configured count', async function () {
        config.showcaseTableCount = 2;

        await lobby.runShowcaseSweep();

        expect(showcaseGames().length).toBe(2);

        const [a, b] = showcaseGames();
        const namesOf = (game) => Object.values(game.getPlayers()).map((seat) => seat.name);

        // No bot is double-booked across the two tables.
        expect(new Set([...namesOf(a), ...namesOf(b)]).size).toBe(4);
    });

    it('retires the extra tables when the count is lowered', async function () {
        config.showcaseTableCount = 2;
        await lobby.runShowcaseSweep();
        expect(showcaseGames().length).toBe(2);

        config.showcaseTableCount = 1;
        await lobby.runShowcaseSweep();

        expect(showcaseGames().length).toBe(1);
    });

    it('closes every table, started or not, when the admin turns the showcase off', async function () {
        await lobby.runShowcaseSweep();

        const [game] = showcaseGames();

        expect(game.started).toBe(true);

        config.showcaseEnabled = false;
        await lobby.runShowcaseSweep();

        expect(showcaseGames().length).toBe(0);
        expect(lobby.games[game.id]).toBeUndefined();
        expect(lobby.closedGameIds).toEqual([game.id]);
        expect(lobby.broadcasts.some((entry) => entry.message === 'removegame')).toBe(true);
    });

    it('retries starting a table that never got a game node', async function () {
        lobby.router.startGame = () => undefined;

        await lobby.runShowcaseSweep();

        const [game] = showcaseGames();

        expect(game.started).toBe(false);

        lobby.router.startGame = () => ({ identity: 'node-1', port: 1234, protocol: 'http' });
        await lobby.runShowcaseSweep();

        expect(showcaseGames().length).toBe(1);
        expect(showcaseGames()[0].started).toBe(true);
        // Healed the existing table rather than opening a second one.
        expect(showcaseGames()[0].id).toBe(game.id);
    });

    describe('onShowcaseGameWin', function () {
        it('retires the finished table so the sweep can replace it', async function () {
            await lobby.runShowcaseSweep();

            const [game] = showcaseGames();

            lobby.onShowcaseGameWin({ gameId: game.id, winner: 'someone' });

            expect(lobby.games[game.id]).toBeUndefined();
            expect(lobby.closedGameIds).toEqual([game.id]);

            await lobby.runShowcaseSweep();

            expect(showcaseGames().length).toBe(1);
            expect(showcaseGames()[0].id).not.toBe(game.id);
        });

        it('ignores a finished game that is not a showcase table', function () {
            const ordinary = { id: 'ordinary', showcaseGame: false };

            lobby.games[ordinary.id] = ordinary;

            lobby.onShowcaseGameWin({ gameId: 'ordinary' });

            expect(lobby.games[ordinary.id]).toBe(ordinary);
            expect(lobby.closedGameIds).toEqual([]);
        });

        it('ignores an event for a game the lobby does not have', function () {
            expect(() => lobby.onShowcaseGameWin({ gameId: 'unknown' })).not.toThrow();
        });
    });
});
