const Lobby = require('../../server/lobby');

/**
 * ARCHON: how a direct message reaches the person it is for.
 *
 * The service writes the row; the lobby holds the sockets. Somebody connected
 * hears it live; somebody who is not gets a notification through the same
 * centre as a pairing, once an hour per sender at most. These hold the real
 * Lobby.prototype handler against stub sockets.
 */
describe('Lobby direct message delivery', function () {
    let lobby;
    let sent;

    const socketFor = (username) => ({
        send: (...args) => sent.push([username, ...args])
    });

    const message = {
        id: 7,
        senderId: 1,
        senderUsername: 'alice',
        recipientId: 2,
        recipientUsername: 'bob',
        text: 'Can we play at 8 instead of 7?',
        matchId: 42,
        sentAt: '2026-08-20T19:00:00.000Z',
        readAt: null
    };

    beforeEach(function () {
        sent = [];
        lobby = {
            socketsByName: {},
            notificationService: { notify: vi.fn().mockResolvedValue(null) },
            onDirectMessageSent: Lobby.prototype.onDirectMessageSent
        };
    });

    it('pushes the message live to a connected recipient and to the sender', function () {
        lobby.socketsByName = { alice: socketFor('alice'), bob: socketFor('bob') };

        lobby.onDirectMessageSent({ message });

        expect(sent).toEqual([
            ['bob', 'directmessage', message],
            ['alice', 'directmessage', message]
        ]);
        // Bob is here; nothing to email.
        expect(lobby.notificationService.notify).not.toHaveBeenCalled();
    });

    it('raises a notification for a recipient who is not connected', function () {
        lobby.socketsByName = { alice: socketFor('alice') };

        lobby.onDirectMessageSent({ message });

        expect(sent).toEqual([['alice', 'directmessage', message]]);
        expect(lobby.notificationService.notify).toHaveBeenCalledTimes(1);

        const [event] = lobby.notificationService.notify.mock.calls[0];

        expect(event).toEqual(
            expect.objectContaining({
                userId: 2,
                category: 'message.direct',
                title: 'New message from alice',
                body: 'Can we play at 8 instead of 7?',
                url: '/messages/alice'
            })
        );
        expect(event.data).toEqual(
            expect.objectContaining({ senderId: 1, senderUsername: 'alice', messageId: 7 })
        );
    });

    it('keys the notification to the hour, so a conversation is one email an hour', function () {
        lobby.onDirectMessageSent({ message });
        lobby.onDirectMessageSent({ message: { ...message, id: 8, text: 'hello?' } });

        const keys = lobby.notificationService.notify.mock.calls.map((call) => call[0].dedupeKey);

        expect(keys[0]).toMatch(/^message\.direct:2:1:\d+$/);
        expect(keys[1]).toBe(keys[0]);
    });

    it('shortens a long message for the notification body', function () {
        lobby.onDirectMessageSent({ message: { ...message, text: 'x'.repeat(300) } });

        const [event] = lobby.notificationService.notify.mock.calls[0];

        expect(event.body).toHaveLength(140);
        expect(event.body.endsWith('...')).toBe(true);
    });

    it('survives a lobby with no notification service', function () {
        lobby.notificationService = null;

        expect(() => lobby.onDirectMessageSent({ message })).not.toThrow();
    });

    it('ignores an empty announcement', function () {
        expect(() => lobby.onDirectMessageSent({})).not.toThrow();
        expect(lobby.notificationService.notify).not.toHaveBeenCalled();
    });
});
