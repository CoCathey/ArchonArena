const Lobby = require('../../server/lobby');
const BotService = require('../../server/services/botgames/BotService');
const { BOT_ROSTER } = require('../../server/services/botgames/roster');
const User = require('../../server/models/User');

/**
 * ARCHON (F9): the showcase - a bot-vs-bot table with nothing to join, kept
 * running so an empty lobby still has something live to watch.
 *
 * The invariant under test: while the showcase is on and under its
 * configured table count, that many tables are running, each between two
 * DISTINCT bots, already decked and started with no human ever seated. A
 * finished table (GAMEWIN) is closed and replaced; disabling the showcase,
 * or turning its count down, never force-closes a table that is still being
 * played - it only stops replacing one once it finishes. The same seam the
 * practice table spec pins: the real Lobby.prototype methods run against a
 * real BotService with stubbed user/deck services.
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
            enabled: true,
            maxConcurrentGames: 3,
            pendingRecycleMinutes: 10,
            allowSpectators: true,
            maxTurns: 80,
            showcaseEnabled: true,
            showcaseTableCount: 1,
            showcaseMaxTurns: 80
        };
        db = makeDb();
        // Every bot owns exactly one deck of its house by default.
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
                getRandomDeckIdForUser: async (userId, { house } = {}) =>
                    houseDecks.get(house) || null,
                getStandaloneDecks: async () => [],
                countDecksForUserWithHouse: async (userId, house) => (houseDecks.has(house) ? 1 : 0)
            },
            settingsService: { getSectionWithDefaults: () => config },
            db
        });
        lobby = makeLobby();
    });

    const showcaseGames = () => Object.values(lobby.games).filter((game) => game.showcaseGame);

    it('is a method the lobby actually defines', function () {
        expect(typeof Lobby.prototype.runShowcaseSweep).toBe('function');
        expect(typeof Lobby.prototype.createShowcaseTable).toBe('function');
        expect(typeof Lobby.prototype.onShowcaseGameWin).toBe('function');
    });

    it('starts a showcase table between two distinct bots, already decked and running', async function () {
        await lobby.runShowcaseSweep();

        const games = showcaseGames();

        expect(games.length).toBe(1);

        const [game] = games;
        const seats = Object.values(game.getPlayers());

        expect(seats.length).toBe(2);
        expect(seats.every((seat) => seat.isBot)).toBe(true);
        expect(seats.every((seat) => !!seat.deck)).toBe(true);
        expect(seats[0].name).not.toBe(seats[1].name);
        expect(game.botGame).toBe(true);
        expect(game.started).toBe(true);
        expect(game.node).toBeDefined();
        expect(lobby.broadcasts.some((entry) => entry.message === 'newgame')).toBe(true);
    });

    it('tops up to the configured table count', async function () {
        config.showcaseTableCount = 3;

        await lobby.runShowcaseSweep();

        expect(showcaseGames().length).toBe(3);

        const hosts = showcaseGames().map((game) =>
            Object.values(game.getPlayers())
                .map((seat) => seat.name)
                .sort()
        );

        // Six distinct seats across three tables - no bot double-booked.
        expect(new Set(hosts.flat()).size).toBe(6);
    });

    it('does not open more once the configured count is already running', async function () {
        await lobby.runShowcaseSweep();
        const [first] = showcaseGames();

        await lobby.runShowcaseSweep();

        expect(showcaseGames().length).toBe(1);
        expect(showcaseGames()[0]).toBe(first);
    });

    it('does nothing when the showcase is switched off', async function () {
        config.showcaseEnabled = false;

        await lobby.runShowcaseSweep();

        expect(showcaseGames().length).toBe(0);
    });

    it('never force-closes a running table just because it was switched off', async function () {
        await lobby.runShowcaseSweep();
        const [game] = showcaseGames();

        config.showcaseEnabled = false;
        await lobby.runShowcaseSweep();

        expect(lobby.games[game.id]).toBe(game);
        expect(lobby.closedGameIds).toEqual([]);
    });

    it('never force-closes a running table just because the count was turned down', async function () {
        config.showcaseTableCount = 2;
        await lobby.runShowcaseSweep();
        expect(showcaseGames().length).toBe(2);

        config.showcaseTableCount = 0;
        await lobby.runShowcaseSweep();

        expect(showcaseGames().length).toBe(2);
        expect(lobby.closedGameIds).toEqual([]);
    });

    it('closes and replaces a table once it finishes', async function () {
        await lobby.runShowcaseSweep();
        const [game] = showcaseGames();

        lobby.onShowcaseGameWin({ gameId: game.id, showcaseGame: true, winner: 'someone' });

        expect(lobby.games[game.id]).toBeUndefined();
        expect(lobby.closedGameIds).toEqual([game.id]);
        expect(lobby.broadcasts.some((entry) => entry.message === 'removegame')).toBe(true);

        await lobby.runShowcaseSweep();

        expect(showcaseGames().length).toBe(1);
        expect(showcaseGames()[0].id).not.toBe(game.id);
    });

    it('does not replace a finished table once the showcase is switched off', async function () {
        await lobby.runShowcaseSweep();
        const [game] = showcaseGames();

        lobby.onShowcaseGameWin({ gameId: game.id, showcaseGame: true, winner: 'someone' });

        config.showcaseEnabled = false;
        await lobby.runShowcaseSweep();

        expect(showcaseGames().length).toBe(0);
    });

    it('ignores a GAMEWIN for a game that is not a showcase table', function () {
        lobby.games['some-id'] = { showcaseGame: false };

        lobby.onShowcaseGameWin({ gameId: 'some-id', winner: 'someone' });

        expect(lobby.games['some-id']).toBeDefined();
        expect(lobby.closedGameIds).toEqual([]);
    });

    it('starts nothing when fewer than two bots can host', async function () {
        houseDecks = new Map([['dis', 42]]);

        await lobby.runShowcaseSweep();

        expect(showcaseGames().length).toBe(0);
    });

    it('never seats a bot already playing a practice table', async function () {
        houseDecks = new Map([
            ['dis', 42],
            ['logos', 43]
        ]);

        await lobby.runBotTableSweep();
        const [practiceGame] = Object.values(lobby.games).filter(
            (game) => game.botGame && !game.showcaseGame
        );
        const practiceHost = Object.values(practiceGame.getPlayers())[0].name;

        await lobby.runShowcaseSweep();

        // Only two bots have decks at all; the practice table already holds
        // one of them, so the showcase cannot seat two distinct bots.
        expect(showcaseGames().length).toBe(0);

        const [game] = Object.values(lobby.games).filter((g) => g.botGame && !g.showcaseGame);
        expect(Object.values(game.getPlayers())[0].name).toBe(practiceHost);
    });

    it('is excluded from the practice table concurrency cap', async function () {
        config.maxConcurrentGames = 1;
        config.showcaseTableCount = 1;

        await lobby.runBotTableSweep();
        await lobby.runShowcaseSweep();

        const practiceGames = Object.values(lobby.games).filter(
            (game) => game.botGame && !game.showcaseGame
        );

        expect(practiceGames.length).toBe(1);
        expect(showcaseGames().length).toBe(1);
    });
});
