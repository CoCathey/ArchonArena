const PendingGame = require('../../server/pendinggame');

/**
 * ARCHON: what a tournament table says about its seats before, during and
 * after the registered decks are loaded into them.
 *
 * The complaint was "the table does not show the locked deck". It did not: a
 * seat learned its deck's name only when the deck finished loading, and the
 * opponent's seat never learned it at all - so a table built for two
 * registered decks opened saying "No deck selected" and "Not selected". The
 * summary now names what each seat is locked to from the moment the table
 * exists, with the same privacy rule the SAS badge already follows.
 */
describe('PendingGame tournament seats', function () {
    const makeUser = (username) => ({
        username,
        blockList: [],
        permissions: {},
        hasUserBlocked: () => false,
        getDetails: () => ({ username })
    });

    const alice = makeUser('alice');
    const bob = makeUser('bob');

    const makeTable = (overrides = {}, details = {}) => {
        const game = new PendingGame(alice, {
            gameFormat: 'normal',
            name: 'Test Cup R1: alice vs bob (game 2)',
            tournament: {
                tournamentId: 1,
                matchId: 5,
                gameNumber: 2,
                bestOf: 3,
                round: 1,
                players: ['alice', 'bob'],
                deckSwapPolicy: 'locked',
                decks: { alice: 101, bob: 201 },
                deckNames: { alice: 'Alpha Deck', bob: 'Bravo Deck' },
                ...overrides
            },
            ...details
        });

        game.newGame('socket-alice', alice, undefined, true);
        game.join('socket-bob', bob);

        return game;
    };

    it('names the deck every seat is locked to, before any deck has loaded', function () {
        const summary = makeTable().getSummary('alice');

        expect(summary.tournament.seats).toEqual({
            alice: { locked: true, deckName: 'Alpha Deck' },
            bob: { locked: true, deckName: 'Bravo Deck' }
        });
        // And nothing has loaded yet - the seats themselves are still empty.
        expect(summary.players.alice.deck).toEqual({});
        expect(summary.players.bob.deck).toEqual({});
    });

    it('says which game of the series this table is', function () {
        const summary = makeTable().getSummary('alice');

        expect(summary.tournament.gameNumber).toBe(2);
        expect(summary.tournament.bestOf).toBe(3);
    });

    it('marks a seat the event pinned nothing to as unlocked', function () {
        const summary = makeTable({
            decks: { alice: 101, bob: null },
            deckNames: { alice: 'Alpha Deck', bob: null }
        }).getSummary('bob');

        expect(summary.tournament.seats.bob).toEqual({ locked: false, deckName: undefined });
        expect(summary.tournament.deckLocked).toBe(false);
    });

    it('keeps the other seat’s name to itself when the event hides decklists', function () {
        const summary = makeTable({}, { hideDeckLists: true }).getSummary('alice');

        expect(summary.tournament.seats.alice.deckName).toBe('Alpha Deck');
        expect(summary.tournament.seats.bob.deckName).toBeUndefined();
        expect(summary.tournament.seats.bob.locked).toBe(true);
    });

    it('names nobody’s deck in the lobby list when decklists are hidden', function () {
        // No active player: this is the summary broadcast to everyone.
        const summary = makeTable({}, { hideDeckLists: true }).getSummary();

        expect(summary.tournament.seats.alice.deckName).toBeUndefined();
        expect(summary.tournament.seats.bob.deckName).toBeUndefined();
    });

    it('survives a table built before deck names existed', function () {
        const summary = makeTable({ deckNames: undefined }).getSummary('alice');

        expect(summary.tournament.seats).toEqual({
            alice: { locked: true, deckName: undefined },
            bob: { locked: true, deckName: undefined }
        });
    });

    it('seats each player on the series score the event recorded', function () {
        const game = makeTable({ wins: { alice: 1, bob: 0 } });

        expect(game.players.alice.wins).toBe(1);
        expect(game.players.bob.wins).toBe(0);
        // And it reaches the engine with the start details.
        expect(game.getStartGameDetails().players.alice.wins).toBe(1);
    });

    it('starts a seat on zero when the event recorded no score', function () {
        expect(makeTable().players.alice.wins).toBe(0);
    });

    it('prefers the deck actually in the seat over the recorded name', function () {
        const game = makeTable();

        game.selectDeck('bob', { id: 999, name: 'Charlie Deck' });

        const summary = game.getSummary('alice');

        expect(summary.tournament.seats.bob.deckName).toBe('Charlie Deck');
        expect(summary.tournament.seats.alice.deckName).toBe('Alpha Deck');
    });

    it('has no seats block on an ordinary table', function () {
        const game = new PendingGame(alice, { gameFormat: 'normal', name: 'casual' });

        game.newGame('socket-alice', alice, undefined, true);

        expect(game.getSummary('alice').tournament).toBeUndefined();
    });
});
