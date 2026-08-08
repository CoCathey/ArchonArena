const tournamentNotifications = require('../../../../server/services/notifications/tournamentNotifications');
const tournamentEvents = require('../../../../server/services/tournament/tournamentEvents');
const { isKnownCategory } = require('../../../../server/services/notifications/taxonomy');

/**
 * ARCHON (N14): the notifications that make an asynchronous event work.
 *
 * A proposal nobody is told about is the exact failure the scheduling feature
 * exists to prevent, so these are as load-bearing as the pairing ping: who
 * hears it, that the actor does not hear their own action back, and that a
 * deadline is announced once rather than on every sweep tick.
 */
describe('asynchronous tournament notifications', function () {
    let tournamentService;
    let notificationService;
    let handlers;

    const EVENTS = [
        'roundPaired',
        'tournamentStarted',
        'matchTimeProposed',
        'matchTimeAccepted',
        'matchScheduleCleared',
        'roundDeadlinePassed'
    ];

    beforeEach(function () {
        tournamentService = {
            getCurrentRoundPairings: vi.fn(),
            getActiveParticipants: vi.fn().mockResolvedValue([])
        };
        notificationService = {
            notify: vi.fn().mockResolvedValue(null),
            notifyMany: vi.fn().mockResolvedValue([])
        };
        handlers = tournamentNotifications.install({ tournamentService, notificationService });
    });

    afterEach(function () {
        for (const event of EVENTS) {
            tournamentEvents.removeAllListeners(event);
        }
    });

    const proposal = {
        tournamentId: 3,
        tournamentName: 'Async League',
        matchId: 11,
        round: 2,
        player1Id: 1,
        player2Id: 2,
        byUserId: 1,
        byUsername: 'alice',
        time: '2026-08-20T19:00:00.000Z',
        note: 'after work?'
    };

    describe('every category it sends is one a player can switch off', function () {
        it('uses declared categories only', function () {
            expect(isKnownCategory('tournament.schedule')).toBe(true);
            expect(isKnownCategory('tournament.deadline')).toBe(true);
        });
    });

    describe('a proposed time', function () {
        it('tells the opponent, not the proposer', async function () {
            await handlers.onMatchTimeProposed(proposal);

            const [event] = notificationService.notify.mock.calls[0];
            expect(event.userId).toBe(2);
            expect(event.category).toBe('tournament.schedule');
            expect(event.title).toContain('alice proposed a match time');
        });

        // The reader's timezone is unknowable here, so the body names the
        // zone it is quoting rather than implying a local time.
        it('states the time in UTC and includes the note', async function () {
            await handlers.onMatchTimeProposed(proposal);

            const [event] = notificationService.notify.mock.calls[0];
            expect(event.body).toContain('2026-08-20 19:00 UTC');
            expect(event.body).toContain('after work?');
        });

        it('works the other way round when the second player proposes', async function () {
            await handlers.onMatchTimeProposed({
                ...proposal,
                byUserId: 2,
                byUsername: 'bob'
            });

            expect(notificationService.notify.mock.calls[0][0].userId).toBe(1);
        });

        // Only the newest offer is live, so an unread ping for an offer that
        // has been superseded should be replaced rather than stacked.
        it('replaces the previous unread proposal for the same match', async function () {
            await handlers.onMatchTimeProposed(proposal);

            expect(notificationService.notify.mock.calls[0][0].dedupeKey).toBe(
                'tournament.schedule:11:proposed'
            );
        });
    });

    describe('an accepted time', function () {
        it('tells the player who made the offer', async function () {
            await handlers.onMatchTimeAccepted({
                ...proposal,
                byUserId: 2,
                byUsername: 'bob'
            });

            const [event] = notificationService.notify.mock.calls[0];
            expect(event.userId).toBe(1);
            expect(event.body).toContain('bob accepted');
        });
    });

    describe('a cleared time', function () {
        it('distinguishes a declined offer from a cancelled booking', async function () {
            await handlers.onMatchScheduleCleared({ ...proposal, hadAgreedTime: false });
            expect(notificationService.notify.mock.calls[0][0].body).toContain('declined');

            notificationService.notify.mockClear();

            await handlers.onMatchScheduleCleared({ ...proposal, hadAgreedTime: true });
            expect(notificationService.notify.mock.calls[0][0].body).toContain(
                'cleared your agreed time'
            );
        });
    });

    describe('a passed deadline', function () {
        const deadline = {
            tournamentId: 3,
            tournamentName: 'Async League',
            organizerId: 9,
            round: 2,
            roundEndsAt: '2026-08-20T19:00:00.000Z',
            openMatches: [
                { matchId: 11, player1Id: 1, player2Id: 2, player1: 'alice', player2: 'bob' }
            ]
        };

        it('tells the organizer and both players of every open match', async function () {
            await handlers.onRoundDeadlinePassed(deadline);

            const events = notificationService.notifyMany.mock.calls[0][0];
            expect(events.map((event) => event.userId).sort()).toEqual([1, 2, 9]);
            expect(events.every((event) => event.category === 'tournament.deadline')).toBe(true);
        });

        it('names the opponent each player is waiting on', async function () {
            await handlers.onRoundDeadlinePassed(deadline);

            const events = notificationService.notifyMany.mock.calls[0][0];
            expect(events.find((event) => event.userId === 1).body).toContain('against bob');
            expect(events.find((event) => event.userId === 2).body).toContain('against alice');
        });

        it('points the organizer at what they can do about it', async function () {
            await handlers.onRoundDeadlinePassed(deadline);

            const toOrganizer = notificationService.notifyMany.mock.calls[0][0].find(
                (event) => event.userId === 9
            );
            expect(toOrganizer.body).toContain('1 match is still unplayed');
            expect(toOrganizer.body).toContain('Time in the round');
        });

        it('congratulates rather than nags when nothing is outstanding', async function () {
            await handlers.onRoundDeadlinePassed({ ...deadline, openMatches: [] });

            const events = notificationService.notifyMany.mock.calls[0][0];
            expect(events).toHaveLength(1);
            expect(events[0].body).toContain('Every match is in');
        });

        // The sweep marks the event, but an extension re-arms it - so the key
        // includes the deadline, letting the NEXT deadline speak again while
        // the same one stays quiet.
        it('keys the dedupe on the deadline itself', async function () {
            await handlers.onRoundDeadlinePassed(deadline);

            const events = notificationService.notifyMany.mock.calls[0][0];
            const stamp = new Date(deadline.roundEndsAt).getTime();
            expect(events[0].dedupeKey).toBe(`tournament.deadline:3:2:${stamp}:to`);

            notificationService.notifyMany.mockClear();
            await handlers.onRoundDeadlinePassed({
                ...deadline,
                roundEndsAt: '2026-08-21T19:00:00.000Z'
            });

            expect(notificationService.notifyMany.mock.calls[0][0][0].dedupeKey).not.toBe(
                events[0].dedupeKey
            );
        });
    });

    describe('failure never escapes', function () {
        it('swallows a notification failure rather than breaking the emitter', async function () {
            notificationService.notify.mockRejectedValue(new Error('smtp down'));
            notificationService.notifyMany.mockRejectedValue(new Error('db down'));

            await expect(handlers.onMatchTimeProposed(proposal)).resolves.toBeUndefined();
            await expect(
                handlers.onRoundDeadlinePassed({
                    tournamentId: 3,
                    organizerId: 9,
                    round: 1,
                    openMatches: []
                })
            ).resolves.toBeUndefined();
        });
    });

    describe('wiring', function () {
        // The service emits; nothing calls these handlers directly. A handler
        // that exists but is not subscribed is the failure this catches.
        it('is subscribed to every scheduling event the service emits', async function () {
            tournamentEvents.emit('matchTimeProposed', proposal);
            tournamentEvents.emit('matchTimeAccepted', proposal);
            tournamentEvents.emit('matchScheduleCleared', proposal);
            tournamentEvents.emit('roundDeadlinePassed', {
                tournamentId: 3,
                organizerId: 9,
                round: 1,
                openMatches: []
            });

            await new Promise((resolve) => setImmediate(resolve));

            expect(notificationService.notify).toHaveBeenCalledTimes(3);
            expect(notificationService.notifyMany).toHaveBeenCalledTimes(1);
        });
    });
});
