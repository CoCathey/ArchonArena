const EventEmitter = require('events');

/**
 * In-process bridge between the tournament service (REST layer) and the
 * lobby (socket layer). Both run in the lobby process; the service emits
 * high-level events ('roundPaired', 'ensureMatchGame') and the lobby
 * reacts by creating games — so neither module imports the other.
 */
class TournamentEvents extends EventEmitter {
    /**
     * ARCHON: emit, and wait for what the listeners actually did.
     *
     * `emit` calls async listeners and throws their promises away, which is
     * right for the events that are announcements - a round was paired, a deck
     * changed. It is wrong for the one event that is a REQUEST: a player
     * pressing "open my table" is waiting on the answer, and returning success
     * before the table exists is what made that button feel broken.
     *
     * The API replied instantly, the table appeared some time later over the
     * socket, and in between the button still read "Open my table" - so people
     * pressed it again, and again, and each press built another table. The fix
     * for the duplicates is in the lobby; this is the fix for the reason anyone
     * pressed twice.
     *
     * Returns the first listener result that is not null or undefined, so a
     * caller can hand back what was created rather than just that it was.
     */
    async request(event, payload) {
        const results = await Promise.all(
            this.listeners(event).map(async (listener) => {
                try {
                    return await listener(payload);
                } catch (err) {
                    // One misbehaving listener must not fail the request for
                    // the others - the emit path has always been forgiving and
                    // this keeps that.
                    return { error: err };
                }
            })
        );

        return results.find((result) => result !== null && result !== undefined);
    }
}

module.exports = new TournamentEvents();
