const Lobby = require('../../server/lobby');
const HelperBotService = require('../../server/services/botgames/HelperBotService');
const User = require('../../server/models/User');

/**
 * ARCHON (F9): the Helper Bot's open table.
 *
 * The invariant under test: while the bot is enabled and under its cap,
 * exactly one unstarted bot game with a free seat is waiting in the lobby -
 * and it starts itself the moment its human holds a deck. The real
 * Lobby.prototype methods run against a REAL HelperBotService with stubbed
 * user/deck services - the same seam the Champion’s Challenge sweep pins, for the
 * same reason: an interval wired to a method the service does not define is
 * green in both halves' unit tests and a TypeError every tick in production.
 */

const BOT_EMAIL = 'bot+helperbot@helper-bot.invalid';

const botUserRow = () =>
    new User({
        id: 99,
        username: 'HelperBot',
        email: BOT_EMAIL,
        settings: {},
        permissions: {},
        blockList: []
    });

const humanUser = (username) =>
    new User({
        id: 7,
        username,
        email: `${username}@example.com`,
        settings: {},
        permissions: {},
        blockList: []
    });

describe('the Helper Bot table', function () {
    let config;
    let lobby;
    let service;
    let userCalls;

    const makeLobby = () => {
        const made = Object.create(Lobby.prototype);

        made.games = {};
        made.sockets = {};
        made.socketsByName = {};
        made.helperBotService = service;
        made.lastHelperBotDeckWarnMs = 0;
        made.broadcasts = [];
        made.broadcastGameMessage = (message, game) =>
            made.broadcasts.push({ message, gameId: game.id });
        made.sendGameState = () => {};
        made.handoffs = [];
        made.sendHandoff = (socket, node, gameId) =>
            made.handoffs.push({ user: socket.user.username, gameId });
        made.startedOnRouter = [];
        made.router = {
            startGame: (game) => {
                made.startedOnRouter.push(game);

                return { identity: 'node-1', port: 1234, protocol: 'http' };
            }
        };
        // The deck-selection plumbing itself is pinned by the tournament and
        // Lucky Dice specs; here it only needs to put a deck in the seat.
        made.applyDeckSelection = async (game, username, deckId, isStandalone) => {
            game.selectDeck(username, {
                id: deckId,
                name: `Deck ${deckId}`,
                isStandalone
            });
        };

        return made;
    };

    beforeEach(function () {
        config = {
            enabled: true,
            botUsername: 'HelperBot',
            maxConcurrentGames: 3,
            pendingRecycleMinutes: 10,
            allowSpectators: true,
            maxTurns: 80
        };
        userCalls = { added: [] };
        service = new HelperBotService({
            userService: {
                getUserByUsername: async () => botUserRow(),
                addUser: async (user) => {
                    userCalls.added.push(user);

                    return user;
                }
            },
            deckService: {
                getRandomDeckIdForUser: async () => 42,
                getStandaloneDecks: async () => []
            },
            settingsService: { getSectionWithDefaults: () => config }
        });
        lobby = makeLobby();
    });

    const botGames = () => Object.values(lobby.games).filter((game) => game.botGame);
    const openTables = () =>
        botGames().filter(
            (game) => !game.started && !Object.values(game.getPlayers()).some((seat) => !seat.isBot)
        );

    // The regression guard the Champion’s Challenge sweep also carries.
    it('is a method the lobby actually defines', function () {
        expect(typeof Lobby.prototype.runHelperBotSweep).toBe('function');
    });

    it('hosts exactly one open table, with the bot seated, decked and marked', async function () {
        await lobby.runHelperBotSweep();
        await lobby.runHelperBotSweep();

        const games = botGames();

        expect(games.length).toBe(1);

        const [game] = games;
        const seat = game.getPlayerByName('HelperBot');

        expect(game.owner.username).toBe('HelperBot');
        expect(game.botGame).toBe(true);
        expect(game.botMaxTurns).toBe(80);
        expect(seat.isBot).toBe(true);
        expect(seat.id).toBe('TBA');
        expect(seat.deck).toBeDefined();
        expect(lobby.broadcasts.filter((entry) => entry.message === 'newgame').length).toBe(1);
    });

    it('takes the table down when the bot is disabled', async function () {
        await lobby.runHelperBotSweep();
        expect(botGames().length).toBe(1);

        config.enabled = false;
        await lobby.runHelperBotSweep();

        expect(botGames().length).toBe(0);
        expect(lobby.broadcasts.some((entry) => entry.message === 'removegame')).toBe(true);
    });

    it('starts the game the moment the joiner holds a deck, handing off the human only', async function () {
        await lobby.runHelperBotSweep();

        const [game] = botGames();
        const ana = humanUser('Ana');

        lobby.sockets['socket-ana'] = { user: ana };
        expect(game.join('socket-ana', ana)).toBeUndefined();

        // No deck yet: not started.
        lobby.startHelperBotGameIfReady(game);
        expect(game.started).toBe(false);

        await lobby.applyDeckSelection(game, 'Ana', 7, false);
        lobby.startHelperBotGameIfReady(game);

        expect(game.started).toBe(true);
        expect(lobby.startedOnRouter).toEqual([game]);
        expect(lobby.handoffs).toEqual([{ user: 'Ana', gameId: game.id }]);

        // The promise renews: with the first table now playing, the next
        // sweep opens a fresh one for the next person.
        await lobby.runHelperBotSweep();

        expect(botGames().length).toBe(2);
        expect(openTables().length).toBe(1);
    });

    it('stops opening tables at the concurrency cap', async function () {
        config.maxConcurrentGames = 1;

        await lobby.runHelperBotSweep();

        const [game] = botGames();

        game.started = true;

        await lobby.runHelperBotSweep();

        expect(botGames().length).toBe(1);
        expect(openTables().length).toBe(0);
    });

    it('recycles a table whose joiner never picked a deck', async function () {
        await lobby.runHelperBotSweep();

        const [game] = botGames();
        const ana = humanUser('Ana');

        game.join('socket-ana', ana);
        game.helperBotHumanSince = Date.now() - 11 * 60 * 1000;

        await lobby.runHelperBotSweep();

        // The squatted table is gone and a fresh open one replaced it.
        expect(lobby.games[game.id]).toBeUndefined();
        expect(botGames().length).toBe(1);
        expect(openTables().length).toBe(1);
    });

    it('leaves a table alone while its joiner is inside the grace period', async function () {
        await lobby.runHelperBotSweep();

        const [game] = botGames();

        game.join('socket-ana', humanUser('Ana'));
        game.helperBotHumanSince = Date.now() - 60 * 1000;

        await lobby.runHelperBotSweep();

        expect(lobby.games[game.id]).toBe(game);
    });

    it('is exempt from the stale pending game cleanup', async function () {
        await lobby.runHelperBotSweep();

        const [game] = botGames();

        game.createdAt = new Date(Date.now() - 20 * 60 * 1000);

        await lobby.clearStalePendingGames();

        expect(lobby.games[game.id]).toBe(game);
    });

    it('never quick-joins somebody into the bot table', async function () {
        await lobby.runHelperBotSweep();

        const [botGame] = botGames();
        const ana = humanUser('Ana');
        const socket = {
            id: 'socket-ana',
            user: ana,
            joinChannel: () => {},
            send: () => {}
        };

        lobby.matchmaking = { dequeue: () => {} };
        lobby.onNewGame(socket, { quickJoin: true, gameFormat: 'normal', name: "Ana's game" });

        // Ana was not seated at the bot's table; she got a fresh game of her
        // own instead.
        expect(Object.values(botGame.getPlayers()).length).toBe(1);
        expect(Object.values(lobby.games).length).toBe(2);
    });

    it('hosts nothing when the bot has no decks at all', async function () {
        service.deckService = {
            getRandomDeckIdForUser: async () => null,
            getStandaloneDecks: async () => []
        };

        await lobby.runHelperBotSweep();

        expect(botGames().length).toBe(0);
    });

    /**
     * The bug this section exists to prevent: a table sitting ready and
     * unstarted with somebody at it. The bot owns the table, so before this
     * the Start button belonged to a player with no hands, and any tick that
     * cost us the deck-selection hook stranded the joiner permanently.
     */
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
            await lobby.runHelperBotSweep();

            const [game] = botGames();

            // Both seats decked, nobody started it - whatever went wrong on
            // the selection path (a node briefly gone, a late rejection).
            await seatHumanWithDeck(game);
            expect(game.started).toBe(false);

            await lobby.runHelperBotSweep();

            expect(game.started).toBe(true);
            expect(lobby.handoffs).toEqual([{ user: 'Ana', gameId: game.id }]);
        });

        it('is started by the joiner pressing Start, though the bot owns the table', async function () {
            await lobby.runHelperBotSweep();

            const [game] = botGames();
            const socket = await seatHumanWithDeck(game);

            // The bot is the owner, so the ordinary owner gate would refuse.
            expect(game.isOwner('Ana')).toBe(false);

            lobby.onStartGame(socket, game.id);

            expect(game.started).toBe(true);
            expect(lobby.handoffs).toEqual([{ user: 'Ana', gameId: game.id }]);
        });

        it('tells a joiner with no deck to pick one rather than doing nothing', async function () {
            await lobby.runHelperBotSweep();

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
            await lobby.runHelperBotSweep();

            const [game] = botGames();

            await seatHumanWithDeck(game);
            game.started = false;

            const stranger = humanUser('Bob');
            const socket = {
                id: 'socket-Bob',
                user: stranger,
                sent: [],
                send: (...args) => socket.sent.push(args)
            };

            lobby.onStartGame(socket, game.id);

            expect(game.started).toBe(false);
        });

        it('is never deleted out from under a seated player', async function () {
            await lobby.runHelperBotSweep();

            const [game] = botGames();
            const person = humanUser('Ana');

            game.join('socket-ana', person);
            game.helperBotHumanSince = Date.now();

            // The admin renamed the bot: the table is hosted under a name
            // that is no longer the bot's, but somebody is sitting at it.
            config.botUsername = 'ArenaBot';
            service.cachedUser = null;
            service.userService.getUserByUsername = async () =>
                new User({
                    id: 100,
                    username: 'ArenaBot',
                    email: 'bot+arenabot@helper-bot.invalid',
                    settings: {},
                    permissions: {},
                    blockList: []
                });

            await lobby.runHelperBotSweep();

            expect(lobby.games[game.id]).toBe(game);
        });
    });

    it('falls back to a standalone deck when the bot owns none', async function () {
        service.deckService = {
            getRandomDeckIdForUser: async () => null,
            getStandaloneDecks: async () => [{ id: 3 }]
        };

        await lobby.runHelperBotSweep();

        const [game] = botGames();
        const seat = game.getPlayerByName('HelperBot');

        expect(seat.deck.id).toBe(3);
        expect(seat.deck.isStandalone).toBe(true);
    });
});

describe('the Helper Bot account', function () {
    const makeService = ({ existing, config } = {}) => {
        const calls = { added: [] };
        let user = existing;
        const service = new HelperBotService({
            userService: {
                getUserByUsername: async () => user,
                addUser: async (added) => {
                    calls.added.push(added);
                    user = new User({
                        id: 100,
                        username: added.username,
                        email: added.email,
                        settings: {},
                        permissions: {},
                        blockList: []
                    });

                    return added;
                }
            },
            deckService: {},
            settingsService: {
                getSectionWithDefaults: () => config || { botUsername: 'HelperBot' }
            }
        });

        return { service, calls };
    };

    it('creates the account once, with the sentinel email and no usable password', async function () {
        const { service, calls } = makeService();

        const user = await service.ensureBotUser();

        expect(user).not.toBeNull();
        expect(user.username).toBe('HelperBot');
        expect(calls.added.length).toBe(1);
        expect(calls.added[0].email).toBe(BOT_EMAIL);
        expect(calls.added[0].verified).toBe(true);
        // Deliberately not a bcrypt hash: every login comparison fails.
        expect(calls.added[0].password.startsWith('$2')).toBe(false);

        // Cached: a second ensure is free.
        await service.ensureBotUser();
        expect(calls.added.length).toBe(1);
    });

    it("refuses to play as an existing account that is not the bot's", async function () {
        const { service, calls } = makeService({
            existing: new User({
                id: 5,
                username: 'HelperBot',
                email: 'a-real-person@example.com',
                settings: {},
                permissions: {},
                blockList: []
            })
        });

        expect(await service.ensureBotUser()).toBeNull();
        expect(calls.added).toEqual([]);
    });

    it('refuses a username the site itself would not allow', async function () {
        const { service, calls } = makeService({
            config: { botUsername: 'Helper Bot!' }
        });

        expect(await service.ensureBotUser()).toBeNull();
        expect(calls.added).toEqual([]);
    });
});
