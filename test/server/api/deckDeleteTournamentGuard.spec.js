const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'server', 'api', 'decks.js'),
    'utf8'
);

/**
 * ARCHON: deleting a deck must not unpin a tournament seat.
 *
 * TournamentPlayers."DeckId" is ON DELETE SET NULL, so deleting a registered
 * deck never failed - it silently emptied the pin. And a null pin does not
 * read as "locked, deck missing"; Lobby.tournamentDeckFor reads it as "this
 * event pins nothing", so the table's deck picker goes live again and none of
 * the event's legality rules are applied to whatever is chosen instead. That
 * made the Delete button on a deck page a way straight through the deck lock,
 * and the player could not even undo it - registerDeck refuses a change once a
 * locked event is running.
 *
 * The rule itself is proved against a real PostgreSQL in
 * test/server/services/tournament/tournamentEndToEnd.spec.js, including that
 * the foreign key really does behave this way. What is checked here is the
 * wiring: that BOTH delete routes consult the guard, and consult it before
 * deleting anything. Two of the defects found in this area were a check that
 * existed and was not attached to the path users take, so that is the failure
 * mode worth a test of its own.
 */
describe('deck deletion is refused for a live event', function () {
    const handlerFor = (marker) => {
        const start = source.indexOf(marker);

        expect(start, `${marker} is no longer in server/api/decks.js`).toBeGreaterThan(-1);

        // Up to the end of that route registration.
        const end = source.indexOf('\n    );', start);

        return source.slice(start, end);
    };

    it('checks before deleting a single deck', function () {
        // Anchored on server.delete, because '/api/decks/:id' is also a GET.
        const handler = handlerFor("server.delete(\n        '/api/decks/:id'");

        expect(handler).toContain('findLiveEventDeckCommitments');
        expect(handler.indexOf('findLiveEventDeckCommitments')).toBeLessThan(
            handler.indexOf('deckService.delete(')
        );
    });

    it('checks before a bulk delete, which is the same button over a selection', function () {
        const handler = handlerFor("'/api/decks/bulk-delete'");

        expect(handler).toContain('findLiveEventDeckCommitments');
        expect(handler.indexOf('findLiveEventDeckCommitments')).toBeLessThan(
            handler.indexOf('deckService.deleteMany(')
        );
    });

    // The refusal has to name the event, or the player is left staring at a
    // button that does nothing for no stated reason.
    it('tells the player which event is holding the deck', function () {
        expect(source).toMatch(/tournamentName/);
        expect(source).toMatch(/Drop from the event first/);
    });
});
