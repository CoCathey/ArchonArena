const tournamentNotifications = require('../../../../server/services/notifications/tournamentNotifications');
const tournamentEvents = require('../../../../server/services/tournament/tournamentEvents');

describe('tournament notifications', function () {
    let tournamentService;
    let notificationService;
    let handlers;

    beforeEach(function () {
        tournamentService = {
            getCurrentRoundPairings: vi.fn(),
            getActiveParticipants: vi.fn().mockResolvedValue([])
        };
        notificationService = { notifyMany: vi.fn().mockResolvedValue([]) };
        handlers = tournamentNotifications.install({ tournamentService, notificationService });
    });

    afterEach(function () {
        // install() subscribes to a process-wide emitter; leaving listeners
        // behind would make every later case fire the previous ones too.
        tournamentEvents.removeAllListeners('roundPaired');
        tournamentEvents.removeAllListeners('tournamentStarted');
    });

    const pairings = {
        tournamentId: 3,
        name: 'Friday Night Archon',
        round: 2,
        matches: [
            {
                matchId: 11,
                table: 4,
                players: [
                    { userId: 1, username: 'alice' },
                    { userId: 2, username: 'bob' }
                ]
            }
        ]
    };

    it('tells both players who they are playing and where', async function () {
        tournamentService.getCurrentRoundPairings.mockResolvedValue(pairings);

        await handlers.onRoundPaired({ tournamentId: 3 });

        const events = notificationService.notifyMany.mock.calls[0][0];
        expect(events.map((event) => event.userId).sort()).toEqual([1, 2]);

        const toAlice = events.find((event) => event.userId === 1);
        expect(toAlice.body).toBe('You are playing bob at table 4.');
        expect(toAlice.category).toBe('tournament.pairing');
        expect(toAlice.url).toBe('/tournaments/3');

        const toBob = events.find((event) => event.userId === 2);
        expect(toBob.body).toBe('You are playing alice at table 4.');
    });

    it('names a bye rather than sending a pairing with no opponent', async function () {
        tournamentService.getCurrentRoundPairings.mockResolvedValue({
            ...pairings,
            matches: [{ matchId: 12, table: null, players: [{ userId: 5, username: 'carol' }] }]
        });

        await handlers.onRoundPaired({ tournamentId: 3 });

        const [event] = notificationService.notifyMany.mock.calls[0][0];
        expect(event.body).toBe('You have a bye this round.');
        expect(event.data.opponent).toBeNull();
    });

    it('keys the dedupe on the round, so a re-fire is one notification', async function () {
        // emitRoundPaired also fires when a best-of series spins up its next
        // game; the player should not be told again that they are paired.
        tournamentService.getCurrentRoundPairings.mockResolvedValue(pairings);

        await handlers.onRoundPaired({ tournamentId: 3 });

        const events = notificationService.notifyMany.mock.calls[0][0];
        expect(events[0].dedupeKey).toBe('tournament.pairing:3:2');
        expect(events[1].dedupeKey).toBe('tournament.pairing:3:2');
    });

    it('does nothing for an event that is not running', async function () {
        tournamentService.getCurrentRoundPairings.mockResolvedValue(null);

        await handlers.onRoundPaired({ tournamentId: 3 });

        expect(notificationService.notifyMany).not.toHaveBeenCalled();
    });

    it('never throws when the tournament service fails', async function () {
        // roundPaired is emitted synchronously inside the pairing path: a
        // listener that threw would surface as a failed round pairing.
        tournamentService.getCurrentRoundPairings.mockRejectedValue(new Error('db down'));

        await expect(handlers.onRoundPaired({ tournamentId: 3 })).resolves.toBeUndefined();
    });

    it('announces the start to every playing participant, once', async function () {
        tournamentService.getActiveParticipants.mockResolvedValue([
            { userId: 1, username: 'alice' },
            { userId: 2, username: 'bob' }
        ]);
        tournamentService.getCurrentRoundPairings.mockResolvedValue(pairings);

        await handlers.onTournamentStarted({ tournamentId: 3 });

        const events = notificationService.notifyMany.mock.calls[0][0];
        expect(events).toHaveLength(2);
        expect(events[0].category).toBe('tournament.start');
        expect(events[0].title).toBe('Friday Night Archon has started');
        expect(events[0].dedupeKey).toBe('tournament.start:3');
    });

    it('is wired to the event bridge, not called directly', async function () {
        tournamentService.getCurrentRoundPairings.mockResolvedValue(pairings);

        tournamentEvents.emit('roundPaired', { tournamentId: 3 });
        await new Promise((resolve) => setImmediate(resolve));

        expect(notificationService.notifyMany).toHaveBeenCalled();
    });
});
