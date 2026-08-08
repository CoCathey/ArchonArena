const Lobby = require('../../server/lobby');
const PendingGame = require('../../server/pendinggame');

/**
 * ARCHON: the lobby half of the deck rules - SAS-bound selection, the Lucky
 * Dice random pick, and the roll-at-start for Lucky Dice games.
 *
 * These hold REAL Lobby.prototype methods against a REAL PendingGame, in the
 * same seam style as the crawl/sweep specs: the bugs these rules could grow
 * (validating but not refusing, rolling but not starting, a method wired to a
 * name that does not exist) live between the halves, where a fully stubbed
 * test cannot see them.
 */
describe('Lobby deck rules', function () {
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
    let deckService;
    let dokService;

    // A deck as deckService.getById returns it; sasRating is attached later
    // by dokService.attachStats, which is how production behaves.
    const dbDeck = (id, uuid = `uuid-${id}`) => ({
        id,
        uuid,
        name: `Deck ${id}`,
        cards: [],
        usageCount: 0,
        verified: true
    });

    const makeGame = (details = {}, ownerUser = alice) => {
        const game = new PendingGame(ownerUser, { gameFormat: 'normal', ...details });
        game.newGame('socket-a', ownerUser, undefined, true);

        return game;
    };

    const socketFor = (user) => ({
        user,
        id: `socket-${user.username}`,
        send: (...args) => sent.push(args),
        joinChannel: () => {}
    });

    beforeEach(function () {
        sent = [];
        deckService = {
            getById: vi.fn(),
            getStandaloneDeckById: vi.fn(),
            getRandomDeckIdForUser: vi.fn()
        };
        dokService = {
            // By default decks come back rated 70, like a healthy cache.
            attachStats: vi.fn().mockImplementation(async (decks) => {
                for (const deck of decks) {
                    deck.sasRating = 70;
                }

                return decks;
            })
        };

        lobby = {
            games: {},
            sockets: {},
            configService: { getValueForSection: () => 1000 },
            cardService: { getAllCards: vi.fn().mockResolvedValue({}) },
            deckService,
            dokService,
            router: { startGame: vi.fn().mockReturnValue({ identity: 'node1' }) },
            sendGameState: vi.fn(),
            broadcastGameMessage: vi.fn(),
            sendHandoff: vi.fn(),
            applyDeckSelection: Lobby.prototype.applyDeckSelection,
            checkSasBound: Lobby.prototype.checkSasBound,
            deckConstraintsFor: Lobby.prototype.deckConstraintsFor,
            onSelectDeck: Lobby.prototype.onSelectDeck,
            onSelectRandomDeck: Lobby.prototype.onSelectRandomDeck,
            onStartGame: Lobby.prototype.onStartGame,
            rollLuckyDiceDecks: Lobby.prototype.rollLuckyDiceDecks,
            launchGame: Lobby.prototype.launchGame
        };
    });

    describe('selecting a deck in a SAS-bound game', function () {
        let game;

        beforeEach(function () {
            game = makeGame({ sasBound: { min: 60, max: 80 } });
            lobby.games[game.id] = game;
        });

        it('accepts a deck inside the range', async function () {
            deckService.getById.mockResolvedValue(dbDeck(1));

            await lobby.onSelectDeck(socketFor(alice), game.id, 1, false);

            expect(game.getPlayerByName('alice').deck).toBeTruthy();
            expect(game.getPlayerByName('alice').deck.selected).toBe(true);
        });

        it('refuses a deck outside the range and says which deck and which range', async function () {
            deckService.getById.mockResolvedValue(dbDeck(1));
            dokService.attachStats.mockImplementation(async (decks) => {
                for (const deck of decks) {
                    deck.sasRating = 93;
                }

                return decks;
            });

            await lobby.onSelectDeck(socketFor(alice), game.id, 1, false);

            expect(game.getPlayerByName('alice').deck).toBeUndefined();
            expect(sent).toContainEqual([
                'gameerror',
                "Deck 1 is SAS 93, outside this game's SAS 60-80 bound"
            ]);
        });

        // A deck DoK has not rated is refused, not guessed at: an unrated deck
        // in a bounded game would otherwise be a hole in the bound.
        it('refuses a deck with no SAS rating yet', async function () {
            deckService.getById.mockResolvedValue(dbDeck(1));
            dokService.attachStats.mockImplementation(async (decks) => decks);

            await lobby.onSelectDeck(socketFor(alice), game.id, 1, false);

            expect(game.getPlayerByName('alice').deck).toBeUndefined();
            expect(
                sent.some(
                    ([event, message]) => event === 'gameerror' && /no SAS rating yet/.test(message)
                )
            ).toBe(true);
        });

        it('refuses standalone decks, which have no SAS at all', async function () {
            deckService.getStandaloneDeckById.mockResolvedValue(dbDeck(3));

            await lobby.onSelectDeck(socketFor(alice), game.id, 3, true);

            expect(game.getPlayerByName('alice').deck).toBeUndefined();
            expect(
                sent.some(
                    ([event, message]) => event === 'gameerror' && /Standalone decks/.test(message)
                )
            ).toBe(true);
        });

        it('leaves unbounded games exactly as they were', async function () {
            const plain = makeGame();
            lobby.games[plain.id] = plain;
            deckService.getById.mockResolvedValue(dbDeck(1));
            dokService.attachStats.mockImplementation(async (decks) => decks);

            await lobby.onSelectDeck(socketFor(alice), plain.id, 1, false);

            expect(plain.getPlayerByName('alice').deck).toBeTruthy();
            expect(sent).toEqual([]);
        });
    });

    describe('the Lucky Dice pick', function () {
        it('selects the deck the dice landed on, through the same path as a click', async function () {
            const game = makeGame();
            lobby.games[game.id] = game;
            deckService.getRandomDeckIdForUser.mockResolvedValue(42);
            deckService.getById.mockResolvedValue(dbDeck(42));

            await lobby.onSelectRandomDeck(socketFor(alice), game.id);

            expect(deckService.getRandomDeckIdForUser).toHaveBeenCalledWith(11, {
                unchainedOnly: false,
                isAlliance: false
            });
            expect(deckService.getById).toHaveBeenCalledWith(42);
            expect(game.getPlayerByName('alice').deck).toBeTruthy();
        });

        it('applies the SAS bound to the roll', async function () {
            const game = makeGame({ sasBound: { min: 60, max: 80 } });
            lobby.games[game.id] = game;
            deckService.getRandomDeckIdForUser.mockResolvedValue(42);
            deckService.getById.mockResolvedValue(dbDeck(42));

            await lobby.onSelectRandomDeck(socketFor(alice), game.id);

            expect(deckService.getRandomDeckIdForUser).toHaveBeenCalledWith(11, {
                unchainedOnly: false,
                isAlliance: false,
                sasMin: 60,
                sasMax: 80
            });
        });

        it('tells the player when nothing is eligible, naming the bound when there is one', async function () {
            const game = makeGame({ sasBound: { min: 100, max: 110 } });
            lobby.games[game.id] = game;
            deckService.getRandomDeckIdForUser.mockResolvedValue(null);

            await lobby.onSelectRandomDeck(socketFor(alice), game.id);

            expect(sent).toContainEqual([
                'gameerror',
                'You have no decks with a SAS rating between 100 and 110'
            ]);
            expect(deckService.getById).not.toHaveBeenCalled();
        });

        it('does nothing for spectators, sealed games, or tournament tables', async function () {
            const sealed = makeGame({ gameFormat: 'sealed' });
            lobby.games[sealed.id] = sealed;

            await lobby.onSelectRandomDeck(socketFor(alice), sealed.id);

            const plain = makeGame();
            lobby.games[plain.id] = plain;

            // bob never joined the game
            await lobby.onSelectRandomDeck(socketFor(bob), plain.id);

            expect(deckService.getRandomDeckIdForUser).not.toHaveBeenCalled();
        });

        it('maps alliance and unchained formats onto the pick', function () {
            expect(lobby.deckConstraintsFor(makeGame({ gameFormat: 'alliance' }))).toEqual({
                unchainedOnly: false
            });
            expect(lobby.deckConstraintsFor(makeGame({ gameFormat: 'unchained' }))).toEqual({
                unchainedOnly: true,
                isAlliance: false
            });
        });
    });

    describe('starting a Lucky Dice game', function () {
        let game;

        beforeEach(function () {
            game = makeGame({ luckyDice: true });
            game.join('socket-b', bob);
            lobby.games[game.id] = game;
            lobby.sockets = { 'socket-a': socketFor(alice), 'socket-b': socketFor(bob) };
        });

        it('rolls a deck for every player and then launches', async function () {
            deckService.getRandomDeckIdForUser.mockResolvedValueOnce(21).mockResolvedValueOnce(22);
            deckService.getById.mockImplementation(async (id) => dbDeck(id));

            await lobby.onStartGame(socketFor(alice), game.id);

            expect(deckService.getRandomDeckIdForUser).toHaveBeenCalledTimes(2);
            expect(game.getPlayerByName('alice').deck).toBeTruthy();
            expect(game.getPlayerByName('bob').deck).toBeTruthy();
            expect(game.started).toBe(true);
            expect(lobby.router.startGame).toHaveBeenCalled();
        });

        // "Rematch: Same Decks" of a Lucky Dice game pre-selects both decks;
        // the roll must respect that, not re-roll over it.
        it('only rolls for players who have no deck yet', async function () {
            game.selectDeck('alice', { ...dbDeck(5), status: {} });
            deckService.getRandomDeckIdForUser.mockResolvedValue(22);
            deckService.getById.mockImplementation(async (id) => dbDeck(id));

            await lobby.onStartGame(socketFor(alice), game.id);

            expect(deckService.getRandomDeckIdForUser).toHaveBeenCalledTimes(1);
            expect(deckService.getRandomDeckIdForUser).toHaveBeenCalledWith(12, expect.anything());
            expect(game.getPlayerByName('alice').deck.id).toBe(5);
            expect(game.started).toBe(true);
        });

        it('refuses to start when a player has nothing to roll, and names them', async function () {
            deckService.getRandomDeckIdForUser.mockResolvedValue(null);

            await lobby.onStartGame(socketFor(alice), game.id);

            expect(game.started).toBe(false);
            expect(lobby.router.startGame).not.toHaveBeenCalled();
            expect(
                sent.some(
                    ([event, message]) =>
                        event === 'gameerror' && message.includes('alice has no decks')
                )
            ).toBe(true);
        });

        it('rolls once when start is clicked twice while the dice are in the air', async function () {
            deckService.getRandomDeckIdForUser.mockImplementation(async () => {
                await new Promise((resolve) => setImmediate(resolve));

                return 21;
            });
            deckService.getById.mockImplementation(async (id) => dbDeck(id));

            const first = lobby.onStartGame(socketFor(alice), game.id);
            // The second click lands while the first is still rolling; the
            // in-flight guard is set synchronously, so it returns at once.
            expect(lobby.onStartGame(socketFor(alice), game.id)).toBeUndefined();

            await first;

            // Two players, one roll each - not two rolls for the first player.
            expect(deckService.getRandomDeckIdForUser).toHaveBeenCalledTimes(2);
            expect(lobby.router.startGame).toHaveBeenCalledTimes(1);
            expect(game.started).toBe(true);
        });

        it('starts a plain game exactly as before, without touching the dice', async function () {
            const plain = makeGame();
            plain.join('socket-b', bob);
            plain.selectDeck('alice', { ...dbDeck(1), status: {} });
            plain.selectDeck('bob', { ...dbDeck(2), status: {} });
            lobby.games[plain.id] = plain;

            await lobby.onStartGame(socketFor(alice), plain.id);

            expect(deckService.getRandomDeckIdForUser).not.toHaveBeenCalled();
            expect(plain.started).toBe(true);
        });
    });

    describe('quick join', function () {
        // Quick join promises a plain game: deck-rule games are opted into
        // from the game list, never matched into.
        it('creates a fresh game rather than seating someone in a deck-rule game', function () {
            const bound = makeGame({ sasBound: { min: 60, max: 80 } });
            const dice = makeGame({ luckyDice: true });
            const lobbyWithGames = {
                games: { [bound.id]: bound, [dice.id]: dice },
                matchmaking: undefined,
                findGameForUser: Lobby.prototype.findGameForUser,
                sendGameState: vi.fn(),
                broadcastGameMessage: vi.fn(),
                onNewGame: Lobby.prototype.onNewGame
            };

            const socket = socketFor(bob);
            lobbyWithGames.onNewGame(socket, {
                quickJoin: true,
                gameFormat: 'normal',
                name: "bob's game"
            });

            // Neither special game gained a second player...
            expect(Object.keys(bound.players)).toEqual(['alice']);
            expect(Object.keys(dice.players)).toEqual(['alice']);
            // ...a new plain game exists with bob in it.
            const created = Object.values(lobbyWithGames.games).find(
                (candidate) => candidate.players['bob']
            );
            expect(created).toBeTruthy();
            expect(created.luckyDice).toBe(false);
            expect(created.sasBound).toBeUndefined();
        });
    });
});
