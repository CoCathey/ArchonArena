const Lobby = require('../../server/lobby');
const BotService = require('../../server/services/botgames/BotService');
const { BOT_ROSTER } = require('../../server/services/botgames/roster');
const User = require('../../server/models/User');

/**
 * ARCHON (F9): the practice table the bots keep open.
 *
 * The invariant under test: while the bots are on and under the cap, exactly
 * one unstarted bot game with a free seat is waiting in the lobby, hosted by
 * a bot from the roster playing a deck of its own house - and it starts
 * itself the moment its human holds a deck. The real Lobby.prototype methods
 * run against a REAL BotService with stubbed user/deck services - the same
 * seam the Champion's Challenge sweep pins, for the same reason: an interval
 * wired to a method the service does not define is green in both halves'
 * unit tests and a TypeError every tick in production.
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

const humanUser = (username) =>
    new User({
        id: 500,
        username,
        email: `${username}@example.com`,
        settings: {},
        permissions: {},
        blockList: []
    });

describe('the practice bot table', function () {
    let config;
    let lobby;
    let service;
    let db;
    let accounts;
    let houseDecks;

    /**
     * A database with every bot already bound to an account, so a sweep is
     * one query and the roster is deterministic.
     */
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
        made.lastBotDeckWarnMs = 0;
        made.broadcasts = [];
        made.broadcastGameMessage = (message, game) =>
            made.broadcasts.push({ message, gameId: game.id });
        made.sendGameState = () => {};
        made.handoffs = [];
        made.sendHandoff = (socket, node, gameId) =>
            made.handoffs.push({ user: socket.user.username, gameId });
        made.router = {
            startGame: () => ({ identity: 'node-1', port: 1234, protocol: 'http' })
        };
        // The deck-selection plumbing itself is pinned by the tournament and
        // Lucky Dice specs; here it only needs to put a deck in the seat.
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
            maxTurns: 80
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

    const botGames = () => Object.values(lobby.games).filter((game) => game.botGame);
    const openTables = () =>
        botGames().filter(
            (game) => !game.started && !Object.values(game.getPlayers()).some((seat) => !seat.isBot)
        );
    const hostOf = (game) => Object.values(game.getPlayers()).find((seat) => seat.isBot);

    // The regression guard the Champion's Challenge sweep also carries.
    it('is a method the lobby actually defines', function () {
        expect(typeof Lobby.prototype.runBotTableSweep).toBe('function');
    });

    it('hosts one open table, seated by a roster bot with a deck of its house', async function () {
        await lobby.runBotTableSweep();
        await lobby.runBotTableSweep();

        const games = botGames();

        expect(games.length).toBe(1);

        const [game] = games;
        const seat = hostOf(game);
        const entry = BOT_ROSTER.find((candidate) => candidate.defaultName === seat.name);

        expect(entry).toBeDefined();
        expect(game.botGame).toBe(true);
        expect(game.botHouse).toBe(entry.house);
        expect(game.owner.username).toBe(seat.name);
        expect(seat.id).toBe('TBA');
        // The deck it is holding is the one its house rolled.
        expect(seat.deck.id).toBe(houseDecks.get(entry.house));
        expect(game.name).toContain(seat.name);
    });

    it('replaces a joined table with one hosted by a different bot', async function () {
        await lobby.runBotTableSweep();

        const [first] = botGames();
        const firstHost = hostOf(first).name;

        // Somebody sits down at it, so it is no longer the open table.
        first.join('socket-ana', humanUser('Ana'));

        await lobby.runBotTableSweep();

        const open = openTables();

        expect(open.length).toBe(1);
        // A different character, because the first one is busy.
        expect(hostOf(open[0]).name).not.toBe(firstHost);
    });

    it('never seats one bot at two tables at once', async function () {
        config.maxConcurrentGames = 20;

        const hosts = [];

        for (let round = 0; round < 6; round++) {
            await lobby.runBotTableSweep();

            const open = openTables();

            expect(open.length).toBe(1);
            hosts.push(hostOf(open[0]).name);

            // Occupy it so the next sweep opens another.
            open[0].join(`socket-${round}`, humanUser(`Player${round}`));
        }

        expect(new Set(hosts).size).toBe(hosts.length);
    });

    it('only offers bots that have a deck of their house', async function () {
        // Only Dis can play: every other bot has nothing of its house, and a
        // bot with nothing to play must never be given a table.
        houseDecks = new Map([['dis', 42]]);

        await lobby.runBotTableSweep();

        const [game] = botGames();

        expect(game.botHouse).toBe('dis');
        expect(hostOf(game).deck.id).toBe(42);
    });

    it('hosts nothing at all when no bot has a deck', async function () {
        houseDecks = new Map();

        await lobby.runBotTableSweep();

        expect(botGames().length).toBe(0);
    });

    it('skips a bot an admin has disabled', async function () {
        houseDecks = new Map([
            ['dis', 42],
            ['logos', 43]
        ]);
        db.bindings.get('dis').enabled = false;

        await lobby.runBotTableSweep();

        const [game] = botGames();

        expect(game.botHouse).toBe('logos');
    });

    it('takes the tables down when the bots are switched off', async function () {
        await lobby.runBotTableSweep();
        expect(botGames().length).toBe(1);

        config.enabled = false;
        await lobby.runBotTableSweep();

        expect(botGames().length).toBe(0);
        expect(lobby.broadcasts.some((entry) => entry.message === 'removegame')).toBe(true);
    });

    it('stops opening tables at the concurrency cap', async function () {
        config.maxConcurrentGames = 1;

        await lobby.runBotTableSweep();

        const [game] = botGames();

        game.started = true;

        await lobby.runBotTableSweep();

        expect(botGames().length).toBe(1);
        expect(openTables().length).toBe(0);
    });

    it('recycles a table whose joiner never picked a deck', async function () {
        await lobby.runBotTableSweep();

        const [game] = botGames();

        game.join('socket-ana', humanUser('Ana'));
        game.botTableHumanSince = Date.now() - 11 * 60 * 1000;

        await lobby.runBotTableSweep();

        expect(lobby.games[game.id]).toBeUndefined();
        expect(openTables().length).toBe(1);
    });

    it('leaves a table alone while its joiner is inside the grace period', async function () {
        await lobby.runBotTableSweep();

        const [game] = botGames();

        game.join('socket-ana', humanUser('Ana'));
        game.botTableHumanSince = Date.now() - 60 * 1000;

        await lobby.runBotTableSweep();

        expect(lobby.games[game.id]).toBe(game);
    });

    it('is exempt from the stale pending game cleanup', async function () {
        await lobby.runBotTableSweep();

        const [game] = botGames();

        game.createdAt = new Date(Date.now() - 20 * 60 * 1000);

        await lobby.clearStalePendingGames();

        expect(lobby.games[game.id]).toBe(game);
    });

    it('never quick-joins somebody into a bot table', async function () {
        await lobby.runBotTableSweep();

        const [botGame] = botGames();
        const socket = {
            id: 'socket-ana',
            user: humanUser('Ana'),
            joinChannel: () => {},
            send: () => {}
        };

        lobby.matchmaking = { dequeue: () => {} };
        lobby.onNewGame(socket, { quickJoin: true, gameFormat: 'normal', name: "Ana's game" });

        expect(Object.values(botGame.getPlayers()).length).toBe(1);
        expect(Object.values(lobby.games).length).toBe(2);
    });

    /**
     * The bug this section exists to prevent: a table sitting ready and
     * unstarted with somebody at it. The bot owns the table, so before this
     * the Start button belonged to a player with no hands, and any tick that
     * cost us the deck-selection hook stranded the joiner permanently.
     */

    /**
     * ARCHON (N31): the practice opponent's style.
     *
     * The three styles are the Champion's Challenge's own sparring pilots, and
     * the pending screen is the only place the choice can be made - a bot table
     * starts the instant its joiner picks a deck, so a picker anywhere later
     * would arrive after the game had begun.
     */
    describe("the opponent's style", function () {
        const champion = { version: 5, weights: { 'a:act:reap': 0.2 }, cardWeights: {} };

        beforeEach(function () {
            // A site that has crowned a champion. Without one there is nothing
            // for a style to bias, which is its own test below.
            service.policyService.champion = async () => champion;
        });

        const socketFor = (name) => {
            const socket = {
                id: `socket-${name}`,
                user: humanUser(name),
                joinChannel: () => {},
                sent: [],
                send: (...args) => socket.sent.push(args)
            };

            lobby.sockets[socket.id] = socket;

            return socket;
        };

        it('opens the table in a style, and offers the rest', async function () {
            await lobby.runBotTableSweep();

            const [game] = botGames();

            expect(game.botStyle).toBeTruthy();
            expect(game.botStyles.map((style) => style.key).length).toBe(3);
            // The brain that travels to the node is wearing it.
            expect(game.botPolicy.persona).toBe(game.botStyle);
        });

        it('is changed by the player sitting at the table', async function () {
            await lobby.runBotTableSweep();

            const [game] = botGames();
            const socket = socketFor('Ana');

            game.join(socket.id, socket.user);

            await lobby.onSelectBotStyle(socket, game.id, 'schemer');

            expect(game.botStyle).toBe('schemer');
            expect(game.botPolicy.persona).toBe('schemer');
        });

        it('takes an empty choice as the champion playing its own game', async function () {
            await lobby.runBotTableSweep();

            const [game] = botGames();
            const socket = socketFor('Ana');

            game.join(socket.id, socket.user);

            await lobby.onSelectBotStyle(socket, game.id, '');

            expect(game.botStyle).toBeUndefined();
            expect(game.botPolicy && game.botPolicy.persona).toBeUndefined();
        });

        it("is not somebody else's to set", async function () {
            await lobby.runBotTableSweep();

            const [game] = botGames();
            const seated = socketFor('Ana');

            game.join(seated.id, seated.user);
            await lobby.onSelectBotStyle(seated, game.id, 'racer');

            await lobby.onSelectBotStyle(socketFor('Bob'), game.id, 'schemer');

            expect(game.botStyle).toBe('racer');
        });

        // The load-bearing refusal: a style is a bias ON the champion's weights,
        // so with no champion a picker would visibly do nothing at all.
        it('is not offered at all before the lab has crowned a champion', async function () {
            service.policyService.champion = async () => null;

            await lobby.runBotTableSweep();

            const [game] = botGames();

            expect(game.botStyles).toEqual([]);
            expect(game.botPolicy).toBeNull();
        });

        it('cannot be changed once the game is under way', async function () {
            await lobby.runBotTableSweep();

            const [game] = botGames();
            const socket = socketFor('Ana');

            game.join(socket.id, socket.user);
            await lobby.onSelectBotStyle(socket, game.id, 'racer');
            game.started = true;

            await lobby.onSelectBotStyle(socket, game.id, 'bruiser');

            expect(game.botStyle).toBe('racer');
        });
    });

    describe('a ready table always starts', function () {
        const seatHumanWithDeck = async (game, name = 'Ana') => {
            const person = humanUser(name);
            const socket = {
                id: `socket-${name}`,
                user: person,
                joinChannel: () => {},
                sent: [],
                send: (...args) => socket.sent.push(args)
            };

            lobby.sockets[socket.id] = socket;
            lobby.socketsByName[name] = socket;
            game.join(socket.id, person);
            await lobby.applyDeckSelection(game, name, 7, false);

            return socket;
        };

        it('is healed by the sweep when the deck-selection hook never fired', async function () {
            await lobby.runBotTableSweep();

            const [game] = botGames();

            await seatHumanWithDeck(game);
            expect(game.started).toBe(false);

            await lobby.runBotTableSweep();

            expect(game.started).toBe(true);
            expect(lobby.handoffs).toEqual([{ user: 'Ana', gameId: game.id }]);
        });

        it('is started by the joiner pressing Start, though the bot owns the table', async function () {
            await lobby.runBotTableSweep();

            const [game] = botGames();
            const socket = await seatHumanWithDeck(game);

            expect(game.isOwner('Ana')).toBe(false);

            lobby.onStartGame(socket, game.id);

            expect(game.started).toBe(true);
            expect(lobby.handoffs).toEqual([{ user: 'Ana', gameId: game.id }]);
        });

        it('tells a joiner with no deck to pick one rather than doing nothing', async function () {
            await lobby.runBotTableSweep();

            const [game] = botGames();
            const person = humanUser('Ana');
            const socket = {
                id: 'socket-Ana',
                user: person,
                joinChannel: () => {},
                sent: [],
                send: (...args) => socket.sent.push(args)
            };

            lobby.sockets[socket.id] = socket;
            game.join(socket.id, person);

            lobby.onStartGame(socket, game.id);

            expect(game.started).toBe(false);
            expect(socket.sent).toEqual([['gameerror', 'Select a deck before starting the game']]);
        });

        it('cannot be started by somebody who is not sitting at it', async function () {
            await lobby.runBotTableSweep();

            const [game] = botGames();

            await seatHumanWithDeck(game);
            game.started = false;

            const socket = {
                id: 'socket-Bob',
                user: humanUser('Bob'),
                sent: [],
                send: (...args) => socket.sent.push(args)
            };

            lobby.onStartGame(socket, game.id);

            expect(game.started).toBe(false);
        });
    });
});
