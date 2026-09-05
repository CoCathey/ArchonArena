const tournamentNotifications = require('../../../../server/services/notifications/tournamentNotifications');
const tournamentEvents = require('../../../../server/services/tournament/tournamentEvents');

/**
 * ARCHON: scheduling notifications speak the recipient's time.
 *
 * "alice suggests 2026-08-20 19:00 UTC" left a sum to the reader, and the
 * reader most likely to get it wrong is the one several zones from their
 * opponent. With the account's zone known the body says "Thu, Aug 20, 2:00 PM
 * CDT"; without it, the honest UTC label as before. Each recipient gets their
 * OWN zone - the two players of a match are, by construction, often in
 * different ones.
 */
describe('tournament notification time zones', function () {
    let notificationService;
    let zones;
    let handlers;

    // Everything install() subscribes to, so no test leaves a listener behind.
    const EVENTS = [
        'roundPaired',
        'tournamentStarted',
        'matchTimeProposed',
        'matchTimeAccepted',
        'matchScheduleCleared',
        'roundDeadlinePassed',
        'roundDeadlineApproaching',
        'matchTimeApproaching'
    ];

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
        note: null
    };

    const install = (zoneFor) => {
        notificationService = {
            notify: vi.fn().mockResolvedValue(null),
            notifyMany: vi.fn().mockResolvedValue([])
        };
        handlers = tournamentNotifications.install({
            tournamentService: {},
            notificationService,
            zoneFor
        });
    };

    beforeEach(function () {
        // Alice in Chicago, Bob in Berlin.
        zones = { 1: 'America/Chicago', 2: 'Europe/Berlin' };
        install(async (userId) => zones[userId] || null);
    });

    afterEach(function () {
        for (const event of EVENTS) {
            tournamentEvents.removeAllListeners(event);
        }
    });

    const bodyOf = (index = 0) => notificationService.notify.mock.calls[index][0].body;
    const toUser = (userId) =>
        notificationService.notify.mock.calls
            .map((call) => call[0])
            .find((e) => e.userId === userId);

    it('says a proposed time in the recipient’s zone', async function () {
        await handlers.onMatchTimeProposed(proposal);

        // Bob (Berlin) is told; 19:00Z is 9pm there.
        expect(notificationService.notify.mock.calls[0][0].userId).toBe(2);
        expect(bodyOf()).toContain('alice suggests Thu, Aug 20, 9:00 PM GMT+2');
        expect(bodyOf()).not.toContain('UTC');
    });

    it('describes a window as a window', async function () {
        await handlers.onMatchTimeProposed({
            ...proposal,
            endTime: '2026-08-20T21:00:00.000Z'
        });

        expect(bodyOf()).toContain('alice is free Thu, Aug 20, 9:00 PM - 11:00 PM GMT+2');
        expect(bodyOf()).toContain('any time in that window');
    });

    it('says an accepted time in the proposer’s zone', async function () {
        await handlers.onMatchTimeAccepted({ ...proposal, byUserId: 2, byUsername: 'bob' });

        // Alice (Chicago) made the offer and hears it was accepted.
        expect(notificationService.notify.mock.calls[0][0].userId).toBe(1);
        expect(bodyOf()).toContain('bob accepted Thu, Aug 20, 2:00 PM CDT');
    });

    it('gives each player of a closing round their own zone', async function () {
        await handlers.onRoundDeadlineApproaching({
            tournamentId: 3,
            tournamentName: 'Async League',
            round: 2,
            roundEndsAt: '2026-08-23T23:00:00.000Z',
            openMatches: [{ matchId: 11, player1Id: 1, player2Id: 2 }]
        });

        expect(toUser(1).body).toContain('closes Sun, Aug 23, 6:00 PM CDT');
        expect(toUser(2).body).toContain('closes Mon, Aug 24, 1:00 AM GMT+2');
    });

    it('reminds each player of a scheduled match in their own zone', async function () {
        await handlers.onMatchTimeApproaching({
            tournamentId: 3,
            tournamentName: 'Async League',
            matchId: 11,
            round: 2,
            player1Id: 1,
            player2Id: 2,
            time: '2026-08-20T19:00:00.000Z'
        });

        expect(toUser(1).body).toContain('at Thu, Aug 20, 2:00 PM CDT');
        expect(toUser(2).body).toContain('at Thu, Aug 20, 9:00 PM GMT+2');
    });

    it('falls back to UTC for a player whose zone is unknown', async function () {
        zones = { 1: 'America/Chicago' };

        await handlers.onMatchTimeProposed(proposal);

        expect(bodyOf()).toContain('alice suggests 2026-08-20 19:00 UTC');
    });

    it('falls back to UTC when the lookup fails, and still notifies', async function () {
        install(async () => {
            throw new Error('db down');
        });

        await handlers.onMatchTimeProposed(proposal);

        expect(notificationService.notify).toHaveBeenCalledTimes(1);
        expect(bodyOf()).toContain('2026-08-20 19:00 UTC');
    });

    it('behaves exactly as before when no lookup is installed', async function () {
        install(undefined);

        await handlers.onMatchTimeProposed(proposal);

        expect(bodyOf()).toContain('alice suggests 2026-08-20 19:00 UTC');
    });
});
