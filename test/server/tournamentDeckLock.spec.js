const Lobby = require('../../server/lobby');
const PendingGame = require('../../server/pendinggame');

/**
 * ARCHON: the tournament deck lock.
 *
 * An event either locks a player to one deck for the whole run or lets them
 * bring a different one between rounds. That toggle lives on the event, but
 * the place it has to hold is the table - and the table shows the ordinary
 * pre-game deck picker, listing the player's whole collection. Registering a
 * deck used only to pre-SELECT it there: the picker was still live, so a
 * player could register the deck the organizer would see in the standings and
 * pilot a different one, in a locked event, with nothing recorded.
 *
 * These hold the REAL Lobby.prototype methods against a REAL PendingGame, in
 * the seam style of lobby.deckRules.spec.js. A fully stubbed test cannot see
 * the failure this guards against, because the failure is that the guard is
 * not wired to the path players actually use.
 */
describe('tournament deck lock', function () {
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

    const dbDeck = (id) => ({
        id,
        uuid: `uuid-${id}`,
        name: `Deck ${id}`,
        cards: [],
        usageCount: 0,
        verified: true
    });

    // A tournament table as ensureTournamentGame builds one: both seats
    // pinned to the deck the event recorded for this pairing.
    const makeTable = (overrides = {}) => {
        const game = new PendingGame(alice, {
            gameFormat: 'normal',
            name: 'Test Cup R1: alice vs bob',
            tournament: {
                tournamentId: 1,
                matchId: 5,
                gameNumber: 1,
                bestOf: 1,
                round: 1,
                players: ['alice', 'bob'],
                deckSwapPolicy: 'locked',
                decks: { alice: 101, bob: 201 },
                ...overrides
            }
        });

        game.newGame('socket-alice', alice, undefined, true);
        game.join('socket-bob', bob);
        lobby.games[game.id] = game;

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
            getById: vi.fn().mockImplementation(async (id) => dbDeck(id)),
            getStandaloneDeckById: vi.fn().mockImplementation(async (id) => dbDeck(id))
        };

        lobby = {
            games: {},
            sockets: {
                'socket-alice': socketFor(alice),
                'socket-bob': socketFor(bob)
            },
            configService: { getValueForSection: () => 1000 },
            cardService: { getAllCards: vi.fn().mockResolvedValue({}) },
            deckService,
            dokService: { attachStats: vi.fn().mockResolvedValue([]) },
            router: { startGame: vi.fn().mockReturnValue({ identity: 'node1' }) },
            sendGameState: vi.fn(),
            broadcastGameMessage: vi.fn(),
            sendHandoff: vi.fn(),
            applyDeckSelection: Lobby.prototype.applyDeckSelection,
            checkSasBound: Lobby.prototype.checkSasBound,
            tournamentDeckFor: Lobby.prototype.tournamentDeckFor,
            pinnedDeckMessage: Lobby.prototype.pinnedDeckMessage,
            onSelectDeck: Lobby.prototype.onSelectDeck,
            startTournamentGameIfReady: Lobby.prototype.startTournamentGameIfReady,
            onTournamentDeckRegistered: Lobby.prototype.onTournamentDeckRegistered
        };
    });

    const errors = () =>
        sent.filter(([event]) => event === 'gameerror').map(([, message]) => message);

    describe('the picker at a tournament table', function () {
        it('accepts the deck the event registered', async function () {
            const game = makeTable();

            await lobby.onSelectDeck(socketFor(alice), game.id, 101, false);

            expect(game.getPlayerByName('alice').deck.id).toBe(101);
            expect(errors()).toEqual([]);
        });

        // The whole point.
        it('refuses any other deck, and says why', async function () {
            const game = makeTable();

            await lobby.onSelectDeck(socketFor(alice), game.id, 999, false);

            expect(game.getPlayerByName('alice').deck).toBeUndefined();
            expect(errors()[0]).toMatch(/locks you to the deck you registered/i);
            // And never went near the deck it refused.
            expect(deckService.getById).not.toHaveBeenCalled();
        });

        // Standalone (theme) decks come down a different service call with
        // their own id space, so "same number" is not the same deck.
        it('refuses a standalone deck even when the id happens to match', async function () {
            const game = makeTable();

            await lobby.onSelectDeck(socketFor(alice), game.id, 101, true);

            expect(game.getPlayerByName('alice').deck).toBeUndefined();
            expect(errors()).toHaveLength(1);
            expect(deckService.getStandaloneDeckById).not.toHaveBeenCalled();
        });

        it('tells a between-rounds player where they CAN change it', async function () {
            const game = makeTable({ deckSwapPolicy: 'between-rounds' });

            await lobby.onSelectDeck(socketFor(alice), game.id, 999, false);

            expect(errors()[0]).toMatch(/event page/i);
        });

        // Events may leave deck registration optional, and sealed events build
        // their decks at the table. Nothing pinned, nothing to enforce.
        it('leaves an unpinned seat free to choose', async function () {
            const game = makeTable({ decks: { alice: null, bob: null } });

            await lobby.onSelectDeck(socketFor(alice), game.id, 999, false);

            expect(game.getPlayerByName('alice').deck.id).toBe(999);
            expect(errors()).toEqual([]);
        });

        it('does not touch ordinary lobby games', async function () {
            const game = new PendingGame(alice, { gameFormat: 'normal' });

            game.newGame('socket-alice', alice, undefined, true);
            lobby.games[game.id] = game;

            await lobby.onSelectDeck(socketFor(alice), game.id, 999, false);

            expect(game.getPlayerByName('alice').deck.id).toBe(999);
            expect(errors()).toEqual([]);
        });
    });

    describe('the table itself', function () {
        it('starts once both seats hold their registered decks', async function () {
            const game = makeTable();

            await lobby.onSelectDeck(socketFor(alice), game.id, 101, false);
            await lobby.onSelectDeck(socketFor(bob), game.id, 201, false);

            expect(game.started).toBe(true);
            expect(lobby.router.startGame).toHaveBeenCalled();
        });

        /**
         * Defence in depth. The picker is not the only way a deck can end up
         * on a player - and this is the single place a tournament game starts,
         * so a wrong deck that got there any other way still cannot be played.
         */
        it('refuses to launch on a deck the event did not register', async function () {
            const game = makeTable();

            game.selectDeck('alice', dbDeck(999));
            game.selectDeck('bob', dbDeck(201));

            lobby.startTournamentGameIfReady(game);

            expect(game.started).toBeFalsy();
            expect(lobby.router.startGame).not.toHaveBeenCalled();
            // And both players are told, rather than left staring at a table
            // that has quietly decided not to start.
            expect(errors()).toHaveLength(2);
        });
    });

    /**
     * A 'between-rounds' event permits a swap; the table has to follow it.
     * The table for a round can already be open when the swap happens - async
     * events open theirs on demand, sometimes days early - and it was built
     * with the deck the player had then. Without this the event would allow a
     * swap that its own table then refuses.
     */
    describe('a swap the event allowed', function () {
        it('re-pins an open table and puts the new deck in the seat', async function () {
            const game = makeTable({ deckSwapPolicy: 'between-rounds' });

            await lobby.onSelectDeck(socketFor(alice), game.id, 101, false);

            await lobby.onTournamentDeckRegistered({
                tournamentId: 1,
                userId: 11,
                username: 'alice',
                deckId: 102
            });

            expect(game.tournament.decks.alice).toBe(102);
            expect(game.getPlayerByName('alice').deck.id).toBe(102);

            // And the picker now enforces the new pin, not the old one.
            sent = [];
            await lobby.onSelectDeck(socketFor(alice), game.id, 101, false);
            expect(errors()).toHaveLength(1);
        });

        it('leaves a table that has already started alone', async function () {
            const game = makeTable({ deckSwapPolicy: 'between-rounds' });

            await lobby.onSelectDeck(socketFor(alice), game.id, 101, false);
            await lobby.onSelectDeck(socketFor(bob), game.id, 201, false);
            expect(game.started).toBe(true);

            await lobby.onTournamentDeckRegistered({
                tournamentId: 1,
                userId: 11,
                username: 'alice',
                deckId: 102
            });

            expect(game.tournament.decks.alice).toBe(101);
            expect(game.getPlayerByName('alice').deck.id).toBe(101);
        });

        it('ignores tables belonging to another event', async function () {
            const game = makeTable({ tournamentId: 2, deckSwapPolicy: 'between-rounds' });

            await lobby.onTournamentDeckRegistered({
                tournamentId: 1,
                userId: 11,
                username: 'alice',
                deckId: 102
            });

            expect(game.tournament.decks.alice).toBe(101);
        });
    });
});
