const logger = require('../../log');
const tournamentEvents = require('../tournament/tournamentEvents');

/**
 * ARCHON: turn tournament engine events into player notifications (N2).
 *
 * Subscribes to the same in-process bridge the lobby uses to auto-create table
 * games, so the tournament service still knows nothing about notifications and
 * nothing about the lobby.
 *
 * Every handler is fire-and-forget and swallows its own errors: pairing a round
 * must never fail, or slow down, because a notification could not be written or
 * an email could not be sent. `emitRoundPaired` is a synchronous emit inside the
 * pairing path, so a listener that threw would surface right there - hence the
 * try/catch around every one.
 */
function install({ tournamentService, notificationService }) {
    const onRoundPaired = async ({ tournamentId }) => {
        try {
            const pairings = await tournamentService.getCurrentRoundPairings(tournamentId);

            if (!pairings) {
                return;
            }

            const events = [];

            for (const match of pairings.matches) {
                // A bye has one player and no opponent to name; it is still
                // worth saying, because it tells them not to look for a table.
                for (const player of match.players) {
                    const opponent = match.players.find((other) => other.userId !== player.userId);
                    const table = match.table ? ` at table ${match.table}` : '';

                    events.push({
                        userId: player.userId,
                        category: 'tournament.pairing',
                        title: `Round ${pairings.round} pairing - ${pairings.name}`,
                        body: opponent
                            ? `You are playing ${opponent.username}${table}.`
                            : 'You have a bye this round.',
                        url: `/tournaments/${pairings.tournamentId}`,
                        data: {
                            tournamentId: pairings.tournamentId,
                            round: pairings.round,
                            matchId: match.matchId,
                            table: match.table || null,
                            opponent: opponent ? opponent.username : null
                        },
                        // One notification per player per round, however many
                        // times the pairing hook fires (it also fires when a
                        // series spins up its next game).
                        dedupeKey: `tournament.pairing:${pairings.tournamentId}:${pairings.round}`
                    });
                }
            }

            await notificationService.notifyMany(events);
        } catch (err) {
            logger.error(`Failed to notify pairings for tournament ${tournamentId}`, err);
        }
    };

    const onTournamentStarted = async ({ tournamentId }) => {
        try {
            const [participants, pairings] = await Promise.all([
                tournamentService.getActiveParticipants(tournamentId),
                tournamentService.getCurrentRoundPairings(tournamentId)
            ]);

            const name = pairings ? pairings.name : 'Your event';

            await notificationService.notifyMany(
                participants.map((player) => ({
                    userId: player.userId,
                    category: 'tournament.start',
                    title: `${name} has started`,
                    body: 'Round 1 pairings are up.',
                    url: `/tournaments/${tournamentId}`,
                    data: { tournamentId },
                    dedupeKey: `tournament.start:${tournamentId}`
                }))
            );
        } catch (err) {
            logger.error(`Failed to notify start of tournament ${tournamentId}`, err);
        }
    };

    // Listeners are async; the emitter does not await them, which is exactly
    // the decoupling we want - but it also means a rejection would be unhandled,
    // so each handler resolves rather than throws.
    tournamentEvents.on('roundPaired', (payload) => {
        onRoundPaired(payload);
    });
    tournamentEvents.on('tournamentStarted', (payload) => {
        onTournamentStarted(payload);
    });

    return { onRoundPaired, onTournamentStarted };
}

module.exports = { install };
