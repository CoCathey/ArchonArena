import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    ConversationsResult,
    DirectMessage,
    ThreadResult,
    UnreadCountResult
} from '../src/api/messages';

const api = vi.hoisted(() => ({
    fetchConversations: vi.fn(),
    fetchUnreadMessageCount: vi.fn(),
    fetchMessageThread: vi.fn(),
    markThreadRead: vi.fn(),
    sendDirectMessage: vi.fn()
}));

vi.mock('../src/api/messages', () => api);

const { useMessagesStore } = await import('../src/stores/messagesStore');

const line = (id: number, from: string, to: string, text = 'hi'): DirectMessage => ({
    id,
    senderId: from === 'me' ? 2 : 1,
    senderUsername: from,
    recipientId: to === 'me' ? 2 : 1,
    recipientUsername: to,
    text,
    sentAt: '2026-09-05 12:00:00'
});

const thread = (messages: DirectMessage[]): ThreadResult => ({
    success: true,
    other: { userId: 1, username: 'ana' },
    canMessage: true,
    hasMore: false,
    messages
});

/** A promise plus the handle to settle it, so loads can be overlapped. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

describe('messagesStore', () => {
    beforeEach(() => {
        for (const call of Object.values(api)) {
            call.mockReset();
        }
        api.fetchConversations.mockResolvedValue({
            success: true,
            conversations: []
        } as ConversationsResult);
        api.fetchUnreadMessageCount.mockResolvedValue({
            success: true,
            unread: 0
        } as UnreadCountResult);
        api.fetchMessageThread.mockResolvedValue(thread([]));
        api.markThreadRead.mockResolvedValue({ success: true });
        useMessagesStore.getState().reset();
    });

    it('counts the badge from the inbox it already loaded', async () => {
        api.fetchConversations.mockResolvedValue({
            success: true,
            conversations: [
                {
                    userId: 1,
                    username: 'ana',
                    lastMessage: { id: 3, text: 'hi', sentAt: 'x', fromMe: false },
                    unread: 2
                },
                {
                    userId: 4,
                    username: 'bo',
                    lastMessage: { id: 5, text: 'yo', sentAt: 'x', fromMe: true },
                    unread: 1
                }
            ]
        } as ConversationsResult);

        await useMessagesStore.getState().loadConversations();

        expect(useMessagesStore.getState().unread).toBe(3);
        expect(api.fetchUnreadMessageCount).not.toHaveBeenCalled();
    });

    // A message arriving in the thread on screen re-reads it rather than being
    // appended: the socket copy has neither `fromMe` nor a read stamp, and two
    // lobby processes can deliver the same line twice.
    it('re-reads the open thread when a message for it arrives', async () => {
        await useMessagesStore.getState().loadThread('ana');
        api.fetchMessageThread.mockClear();

        useMessagesStore.getState().receive(line(9, 'ana', 'me'), 'me');

        expect(api.fetchMessageThread).toHaveBeenCalledWith('ana');
    });

    it('leaves the open thread alone for a message in another conversation', async () => {
        await useMessagesStore.getState().loadThread('ana');
        api.fetchMessageThread.mockClear();

        useMessagesStore.getState().receive(line(9, 'bo', 'me'), 'me');

        expect(api.fetchMessageThread).not.toHaveBeenCalled();
    });

    // Reading a thread is what marks it read, and the message that lands while
    // you are looking at it has been read too.
    it('marks a message read when it arrives in the thread on screen', async () => {
        await useMessagesStore.getState().loadThread('ana');
        useMessagesStore.getState().setViewing('ana');

        useMessagesStore.getState().receive(line(9, 'ana', 'me'), 'me');

        expect(api.markThreadRead).toHaveBeenCalledWith('ana');
    });

    it('does not mark our own message read', async () => {
        await useMessagesStore.getState().loadThread('ana');
        useMessagesStore.getState().setViewing('ana');

        useMessagesStore.getState().receive(line(9, 'me', 'ana'), 'me');

        expect(api.markThreadRead).not.toHaveBeenCalled();
    });

    // The badge has to fall as the thread opens, not a round trip later, or it
    // reads as unread mail you are looking at.
    it('clears the badge for a thread as it is opened', async () => {
        api.fetchConversations.mockResolvedValue({
            success: true,
            conversations: [
                {
                    userId: 1,
                    username: 'ana',
                    lastMessage: { id: 3, text: 'hi', sentAt: 'x', fromMe: false },
                    unread: 2
                }
            ]
        } as ConversationsResult);
        await useMessagesStore.getState().loadConversations();

        const marking = useMessagesStore.getState().markRead('ana');

        expect(useMessagesStore.getState().unread).toBe(0);
        expect(useMessagesStore.getState().conversations[0].unread).toBe(0);
        await marking;
    });

    // Opening a second conversation before the first has answered must not
    // repaint it with the wrong person's messages.
    it('lets the newest thread win when two loads overlap', async () => {
        const slow = deferred<ThreadResult>();
        api.fetchMessageThread.mockReturnValueOnce(slow.promise);
        api.fetchMessageThread.mockResolvedValueOnce({
            ...thread([line(2, 'bo', 'me', 'from bo')]),
            other: { userId: 4, username: 'bo' }
        });

        const first = useMessagesStore.getState().loadThread('ana');
        await useMessagesStore.getState().loadThread('bo');

        slow.resolve(thread([line(1, 'ana', 'me', 'from ana')]));
        await first;

        const open = useMessagesStore.getState().thread;
        expect(open?.username).toBe('bo');
        expect(open?.messages.map((entry) => entry.text)).toEqual(['from bo']);
    });

    // The endpoint answers a refusal (a mute, a block) with the reason in the
    // same field it uses for the stored message on success. The composer has
    // to show it, not swallow it.
    it('surfaces the server’s reason for refusing a message', async () => {
        api.sendDirectMessage.mockResolvedValue({
            success: false,
            error: 'You cannot message this player'
        });
        await useMessagesStore.getState().loadThread('ana');

        const sent = await useMessagesStore.getState().send('ana', 'hello');

        expect(sent).toBe(false);
        expect(useMessagesStore.getState().thread?.error).toBe(
            'You cannot message this player'
        );
    });

    // The socket echo only arrives while it is up; a message sent over a
    // dropped one still has to appear where it was typed.
    it('re-reads the thread after a message is sent', async () => {
        api.sendDirectMessage.mockResolvedValue({ success: true, message: line(9, 'me', 'ana') });
        await useMessagesStore.getState().loadThread('ana');
        api.fetchMessageThread.mockClear();

        await useMessagesStore.getState().send('ana', 'hello');

        expect(api.fetchMessageThread).toHaveBeenCalledWith('ana');
    });

    // The server substitutes 'Deleted user' for a disabled account's name. The
    // thread has to stay keyed on the name it was opened with, or the screen
    // (which matches the two) shows an empty conversation with a live composer
    // for the one player a message certainly cannot be sent to.
    it('keeps the thread keyed on the name it was opened with', async () => {
        api.fetchMessageThread.mockResolvedValue({
            success: true,
            other: { userId: 1, username: 'Deleted user' },
            canMessage: false,
            hasMore: false,
            messages: [line(3, 'ana', 'me')]
        } as ThreadResult);

        await useMessagesStore.getState().loadThread('ana');

        const open = useMessagesStore.getState().thread;
        expect(open?.username).toBe('ana');
        expect(open?.canMessage).toBe(false);
    });

    it('refuses to send an empty message without asking the server', async () => {
        const sent = await useMessagesStore.getState().send('ana', '   ');

        expect(sent).toBe(false);
        expect(api.sendDirectMessage).not.toHaveBeenCalled();
    });
});
