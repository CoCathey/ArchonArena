const PendingGame = require('../../server/pendinggame');

/**
 * ARCHON: the deck rules a game can be created with - Lucky Dice (decks are
 * rolled at start) and SAS Bound (only decks inside a SAS range are playable).
 *
 * Both arrive from the client, so what matters here is that the constructor
 * rebuilds them from scratch: a hostile or buggy client must not be able to
 * store anything in the game the server did not decide to keep.
 */
describe('PendingGame deck rules', function () {
    const owner = {
        username: 'owner',
        blockList: [],
        getDetails: () => ({ username: 'owner' })
    };

    const game = (details = {}) => new PendingGame(owner, { gameFormat: 'normal', ...details });

    describe('SAS bound normalization', function () {
        it('keeps a sane range as integers', function () {
            expect(game({ sasBound: { min: 60, max: 80 } }).sasBound).toEqual({
                min: 60,
                max: 80
            });
            expect(game({ sasBound: { min: 60.9, max: 80.2 } }).sasBound).toEqual({
                min: 60,
                max: 80
            });
        });

        it('swaps a backwards range rather than storing one nothing satisfies', function () {
            expect(game({ sasBound: { min: 90, max: 70 } }).sasBound).toEqual({
                min: 70,
                max: 90
            });
        });

        it('clamps the range into 1..500', function () {
            expect(game({ sasBound: { min: -5, max: 9999 } }).sasBound).toEqual({
                min: 1,
                max: 500
            });
        });

        it('drops anything that is not a numeric range', function () {
            expect(game({ sasBound: { min: 'sixty', max: 80 } }).sasBound).toBeUndefined();
            expect(game({ sasBound: { min: 60 } }).sasBound).toBeUndefined();
            expect(game({ sasBound: 'all of them' }).sasBound).toBeUndefined();
            expect(game({ sasBound: true }).sasBound).toBeUndefined();
            expect(game({}).sasBound).toBeUndefined();
        });
    });

    describe('where the rules cannot apply', function () {
        // Sealed deals the decks and tournament tables auto-select registered
        // ones; a rule about choosing your own deck has no meaning in either.
        it('forces both rules off for sealed games', function () {
            const sealed = game({
                gameFormat: 'sealed',
                luckyDice: true,
                sasBound: { min: 60, max: 80 }
            });

            expect(sealed.luckyDice).toBe(false);
            expect(sealed.sasBound).toBeUndefined();
        });

        it('forces both rules off for tournament tables', function () {
            const tournament = game({
                tournament: { tournamentId: 1 },
                luckyDice: true,
                sasBound: { min: 60, max: 80 }
            });

            expect(tournament.luckyDice).toBe(false);
            expect(tournament.sasBound).toBeUndefined();
        });
    });

    describe('what other players can see', function () {
        // The game list and the pending screen both read getSummary, and a
        // joiner decides whether to sit down based on what it says.
        it('exposes both rules in the summary', function () {
            const summary = game({ luckyDice: true, sasBound: { min: 60, max: 80 } }).getSummary();

            expect(summary.luckyDice).toBe(true);
            expect(summary.sasBound).toEqual({ min: 60, max: 80 });
        });

        it('exposes both rules in the start details handed to the game node', function () {
            const g = game({ luckyDice: true, sasBound: { min: 60, max: 80 } });
            const details = g.getStartGameDetails();

            expect(details.luckyDice).toBe(true);
            expect(details.sasBound).toEqual({ min: 60, max: 80 });
        });
    });
});
