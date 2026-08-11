/**
 * ARCHON: the tournament endpoints a participant can call are bounded.
 *
 * Creating an event was the only tournament route with a ceiling on it. The
 * others are mostly organizer tools behind an authorization check, which is a
 * fair reason to leave them - but three are open to any participant in the
 * event and each of them costs something outside the request: opening a table
 * builds a lobby game and broadcasts it to everyone in the lobby, and
 * reporting, confirming, disputing or proposing a time all notify the other
 * player in-app and by email.
 *
 * None of the ceilings is tight enough for a real player to meet. They exist
 * so one account cannot fill the lobby list or use the notification path to
 * bother somebody.
 *
 * This reads the routes the shipped module actually registers, because the
 * failure worth catching is a limiter that was written and not attached.
 */
describe('tournament rate limits', function () {
    const registered = [];

    beforeAll(function () {
        const record =
            (method) =>
            (path, ...handlers) =>
                registered.push({ method, path, handlers });

        require('../../../server/api/tournaments.js').init({
            get: record('get'),
            post: record('post'),
            put: record('put'),
            patch: record('patch'),
            delete: record('delete'),
            use: () => {}
        });
    });

    // By method as well as path: /api/tournaments is a GET listing and a POST
    // that creates, and only one of them is supposed to have a ceiling.
    const isLimited = (path) => {
        const found = registered.find((entry) => entry.method === 'post' && entry.path === path);

        expect(found, `${path} is not registered as a POST at all`).toBeDefined();

        // A limiter sits between passport and the wrapped body: three handlers
        // rather than the two an unlimited action registers.
        return found.handlers.length > 2;
    };

    it('bounds opening a table, which builds a lobby game', function () {
        expect(isLimited('/api/tournaments/:id/matches/:matchId/open-game')).toBe(true);
    });

    it('bounds the match traffic that notifies the other player', function () {
        for (const path of [
            '/api/tournaments/:id/matches/:matchId/result',
            '/api/tournaments/:id/matches/:matchId/confirm',
            '/api/tournaments/:id/matches/:matchId/dispute',
            '/api/tournaments/:id/matches/:matchId/propose-time'
        ]) {
            expect(isLimited(path), `${path} is unbounded`).toBe(true);
        }
    });

    it('still bounds creating an event', function () {
        expect(isLimited('/api/tournaments')).toBe(true);
    });

    // The point of leaving the rest alone: they are organizer tools, and a
    // limiter on them would be a limiter on running the event. If one of these
    // ever becomes participant-callable it needs a ceiling, and this is the
    // line that will say so.
    it('leaves the organizer tools unbounded, where authorization is the gate', function () {
        for (const path of [
            '/api/tournaments/:id/next-round',
            '/api/tournaments/:id/cut',
            '/api/tournaments/:id/resolve-unfinished',
            '/api/tournaments/:id/matches/:matchId/award'
        ]) {
            expect(isLimited(path), `${path} unexpectedly limited`).toBe(false);
        }
    });
});
