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

    // ARCHON (N14): scheduling in async events. Each of these tells exactly
    // one player - the one who did NOT act - because the actor was there.
    const scheduleUrl = (payload) => `/tournaments/${payload.tournamentId}`;
    const otherPlayerOf = (payload) =>
        payload.byUserId === payload.player1Id ? payload.player2Id : payload.player1Id;

    // "Aug 14, 20:00 UTC" - the email/in-app body cannot know the reader's
    // timezone, so it says the zone instead of guessing one.
    const utcLabel = (value) => {
        const time = new Date(
            typeof value === 'string' && !value.endsWith('Z') ? `${value}Z` : value
        );

        if (Number.isNaN(time.getTime())) {
            return 'an unknown time';
        }

        return `${time.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    };

    const onMatchTimeProposed = async (payload) => {
        try {
            await notificationService.notify({
                userId: otherPlayerOf(payload),
                category: 'tournament.schedule',
                title: `${payload.byUsername} proposed a match time - ${payload.tournamentName}`,
                body:
                    `Round ${payload.round}: ${payload.byUsername} suggests ${utcLabel(
                        payload.time
                    )}.` + (payload.note ? ` "${payload.note}"` : ''),
                url: scheduleUrl(payload),
                data: { tournamentId: payload.tournamentId, matchId: payload.matchId },
                // The latest offer is the only live one, so newer proposals for
                // the same match replace the unread ping rather than piling up.
                dedupeKey: `tournament.schedule:${payload.matchId}:proposed`
            });
        } catch (err) {
            logger.error(`Failed to notify proposal for match ${payload.matchId}`, err);
        }
    };

    const onMatchTimeAccepted = async (payload) => {
        try {
            await notificationService.notify({
                userId: otherPlayerOf(payload),
                category: 'tournament.schedule',
                title: `Match time agreed - ${payload.tournamentName}`,
                body: `Round ${payload.round}: ${payload.byUsername} accepted ${utcLabel(
                    payload.time
                )}. See you at the table.`,
                url: scheduleUrl(payload),
                data: { tournamentId: payload.tournamentId, matchId: payload.matchId },
                dedupeKey: `tournament.schedule:${payload.matchId}:accepted:${payload.time}`
            });
        } catch (err) {
            logger.error(`Failed to notify acceptance for match ${payload.matchId}`, err);
        }
    };

    /**
     * ARCHON: the two reminders that fire BEFORE something happens, rather
     * than after it. Everything else this event sends is a report of the past.
     */
    const onRoundDeadlineApproaching = async (payload) => {
        for (const match of payload.openMatches || []) {
            for (const userId of [match.player1Id, match.player2Id]) {
                if (!userId) {
                    continue;
                }

                try {
                    await notificationService.notify({
                        userId,
                        category: 'tournament.schedule',
                        title: `Round ends tomorrow - ${payload.tournamentName}`,
                        body: `Round ${payload.round} closes ${utcLabel(
                            payload.roundEndsAt
                        )}. Your match is still unplayed - arrange a time or it may be decided without you.`,
                        url: scheduleUrl(payload),
                        data: { tournamentId: payload.tournamentId, matchId: match.matchId },
                        dedupeKey: `tournament.schedule:${match.matchId}:deadline-warning`
                    });
                } catch (err) {
                    logger.error(
                        `Failed to warn player ${userId} about round ${payload.round}`,
                        err
                    );
                }
            }
        }
    };

    const onMatchTimeApproaching = async (payload) => {
        for (const userId of [payload.player1Id, payload.player2Id]) {
            if (!userId) {
                continue;
            }

            try {
                await notificationService.notify({
                    userId,
                    category: 'tournament.schedule',
                    title: `Your match starts soon - ${payload.tournamentName}`,
                    body: `Round ${payload.round}: you agreed to play at ${utcLabel(
                        payload.time
                    )}.`,
                    url: scheduleUrl(payload),
                    data: { tournamentId: payload.tournamentId, matchId: payload.matchId },
                    dedupeKey: `tournament.schedule:${payload.matchId}:starting`
                });
            } catch (err) {
                logger.error(`Failed to remind player ${userId} of match ${payload.matchId}`, err);
            }
        }
    };

    const onMatchScheduleCleared = async (payload) => {
        try {
            await notificationService.notify({
                userId: otherPlayerOf(payload),
                category: 'tournament.schedule',
                title: `Match time cleared - ${payload.tournamentName}`,
                body: payload.hadAgreedTime
                    ? `Round ${payload.round}: ${payload.byUsername} cleared your agreed time. Propose a new one.`
                    : `Round ${payload.round}: ${payload.byUsername} declined the proposed time. Propose another.`,
                url: scheduleUrl(payload),
                data: { tournamentId: payload.tournamentId, matchId: payload.matchId },
                dedupeKey: `tournament.schedule:${payload.matchId}:cleared`
            });
        } catch (err) {
            logger.error(`Failed to notify schedule clear for match ${payload.matchId}`, err);
        }
    };

    // ARCHON (N14): the deadline sweep found an async round past its date.
    // The organizer hears it always; the players of still-open matches hear
    // it too, because they are the ones who can still fix it fastest.
    const onRoundDeadlinePassed = async (payload) => {
        try {
            const open = payload.openMatches || [];
            const deadlineStamp = new Date(payload.roundEndsAt || 0).getTime();
            const events = [
                {
                    userId: payload.organizerId,
                    category: 'tournament.deadline',
                    title: `Round ${payload.round} deadline passed - ${payload.tournamentName}`,
                    body:
                        open.length === 0
                            ? 'Every match is in - pair the next round when ready.'
                            : `${open.length} match${
                                  open.length === 1 ? ' is' : 'es are'
                              } still unplayed. Extend the deadline or use "Time in the round".`,
                    url: scheduleUrl(payload),
                    data: { tournamentId: payload.tournamentId, round: payload.round },
                    dedupeKey: `tournament.deadline:${payload.tournamentId}:${payload.round}:${deadlineStamp}:to`
                }
            ];

            for (const match of open) {
                for (const userId of [match.player1Id, match.player2Id]) {
                    const opponent = userId === match.player1Id ? match.player2 : match.player1;

                    events.push({
                        userId,
                        category: 'tournament.deadline',
                        title: `Round ${payload.round} deadline passed - ${payload.tournamentName}`,
                        body: `Your match against ${
                            opponent || 'your opponent'
                        } was not played in time. Play it or talk to the organizer before the round is resolved.`,
                        url: scheduleUrl(payload),
                        data: { tournamentId: payload.tournamentId, matchId: match.matchId },
                        dedupeKey: `tournament.deadline:${payload.tournamentId}:${payload.round}:${deadlineStamp}:${userId}`
                    });
                }
            }

            await notificationService.notifyMany(events);
        } catch (err) {
            logger.error(`Failed to notify deadline for tournament ${payload.tournamentId}`, err);
        }
    };

    // ARCHON: the adaptive bid sweep found a game-3 negotiation nobody
    // answered in time. The silent player is told what happened to them;
    // the other player is told they won the deck by default - both facts
    // are useful, and neither is obvious from the panel going quiet.
    const onAdaptiveBidTimedOut = async (payload) => {
        try {
            const timedOutId = payload.timedOutUserId;
            const winnerId = payload.winnerOfBid;
            const url = scheduleUrl(payload);

            await notificationService.notifyMany([
                {
                    userId: timedOutId,
                    category: 'tournament.adaptiveBid',
                    title: `Bid timed out - ${payload.tournamentName}`,
                    body: 'You did not respond to the game 3 chain bid in time. Your opponent takes the nominated deck by default.',
                    url,
                    data: { tournamentId: payload.tournamentId, matchId: payload.matchId },
                    dedupeKey: `tournament.adaptiveBid:${payload.matchId}:${timedOutId}`
                },
                {
                    userId: winnerId,
                    category: 'tournament.adaptiveBid',
                    title: `Bid resolved - ${payload.tournamentName}`,
                    body: `Your opponent did not respond to the game 3 chain bid in time. You pilot the nominated deck${
                        payload.chains ? ` carrying ${payload.chains} chain(s)` : ' at no chains'
                    }.`,
                    url,
                    data: { tournamentId: payload.tournamentId, matchId: payload.matchId },
                    dedupeKey: `tournament.adaptiveBid:${payload.matchId}:${winnerId}`
                }
            ]);
        } catch (err) {
            logger.error(`Failed to notify adaptive bid timeout for match ${payload.matchId}`, err);
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
    tournamentEvents.on('matchTimeProposed', (payload) => {
        onMatchTimeProposed(payload);
    });
    tournamentEvents.on('matchTimeAccepted', (payload) => {
        onMatchTimeAccepted(payload);
    });
    tournamentEvents.on('matchScheduleCleared', (payload) => {
        onMatchScheduleCleared(payload);
    });
    tournamentEvents.on('roundDeadlinePassed', (payload) => {
        onRoundDeadlinePassed(payload);
    });
    tournamentEvents.on('roundDeadlineApproaching', (payload) => {
        onRoundDeadlineApproaching(payload);
    });
    tournamentEvents.on('matchTimeApproaching', (payload) => {
        onMatchTimeApproaching(payload);
    });
    tournamentEvents.on('adaptiveBidTimedOut', (payload) => {
        onAdaptiveBidTimedOut(payload);
    });

    return {
        onRoundPaired,
        onTournamentStarted,
        onMatchTimeProposed,
        onMatchTimeAccepted,
        onMatchScheduleCleared,
        onRoundDeadlinePassed,
        onRoundDeadlineApproaching,
        onMatchTimeApproaching,
        onAdaptiveBidTimedOut
    };
}

module.exports = { install };
