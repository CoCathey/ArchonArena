const EventEmitter = require('events');

/**
 * In-process bridge between the tournament service (REST layer) and the
 * lobby (socket layer). Both run in the lobby process; the service emits
 * high-level events ('roundPaired', 'ensureMatchGame') and the lobby
 * reacts by creating games — so neither module imports the other.
 */
class TournamentEvents extends EventEmitter {}

module.exports = new TournamentEvents();
