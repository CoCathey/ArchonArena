import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectMessage } from '../src/api/messages';

vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => undefined),
    deleteItemAsync: vi.fn(async () => undefined)
}));

// The API client reaches react-native for Platform (which storefront policy
// keys off). Its Flow-typed entry point cannot be parsed under vitest.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

// A live message makes the store re-read from the server; those reads are
// somebody else's test.
vi.mock('../src/api/messages', () => ({
    fetchConversations: vi.fn(async () => ({ success: true, conversations: [] })),
    fetchUnreadMessageCount: vi.fn(async () => ({ success: true, unread: 0 })),
    fetchMessageThread: vi.fn(async () => ({ success: true, messages: [] })),
    markThreadRead: vi.fn(async () => ({ success: true })),
    sendDirectMessage: vi.fn(async () => ({ success: true }))
}));

const mocks = vi.hoisted(() => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const socket: Record<string, unknown> = {
        connected: false,
        on: (event: string, handler: (...args: unknown[]) => void) => {
            handlers.set(event, handler);
            return socket;
        },
        io: { on: () => undefined },
        emit: () => undefined,
        connect: () => undefined,
        disconnect: () => undefined,
        removeAllListeners: () => handlers.clear()
    };

    return { handlers, io: vi.fn(() => socket) };
});

vi.mock('socket.io-client', () => ({ io: mocks.io }));

const { useAuthStore } = await import('../src/stores/authStore');
const { useLobbyStore } = await import('../src/stores/lobbyStore');
const { useMessagesStore } = await import('../src/stores/messagesStore');
const { connectLobby, disconnectLobby } = await import('../src/net/lobbySocket');

/** Deliver a server message to the handler the app registered for it. */
function receive(event: string, payload: unknown): void {
    const handler = mocks.handlers.get(event);
    expect(handler, `no listener registered for '${event}'`).toBeTypeOf('function');
    handler?.(payload);
}

const message = (from: string, to: string, text: string): DirectMessage => ({
    id: 7,
    senderId: 1,
    senderUsername: from,
    recipientId: 2,
    recipientUsername: to,
    text,
    sentAt: '2026-09-05 12:00:00'
});

describe('lobby socket notices', () => {
    beforeEach(async () => {
        disconnectLobby();
        useMessagesStore.getState().reset();
        await useAuthStore.getState().setAuth({
            token: 'jwt',
            user: { id: '2', username: 'me' }
        });
        await connectLobby();
    });

    // The lobby's only channel for a sentence addressed to one player. Every
    // one of these was dropped on mobile: "your last result is still being
    // recorded", "leave the game you are in before joining another table".
    it('holds a lobbynotice for the app to say', () => {
        receive('lobbynotice', {
            tone: 'warning',
            message: 'Leave the game you are in before joining another table.'
        });

        expect(useLobbyStore.getState().notice).toMatchObject({
            tone: 'warning',
            message: 'Leave the game you are in before joining another table.'
        });
    });

    // Two identical refusals are two presses of a button that did nothing; the
    // second has to be said as well, so the notice carries a serial.
    it('renumbers a repeated notice so it is said again', () => {
        receive('lobbynotice', { message: 'Leave the game you are in.' });
        const first = useLobbyStore.getState().notice?.id;

        receive('lobbynotice', { message: 'Leave the game you are in.' });

        expect(useLobbyStore.getState().notice?.id).toBe((first ?? 0) + 1);
    });

    it('ignores a notice with nothing to say', () => {
        receive('lobbynotice', { tone: 'info' });

        expect(useLobbyStore.getState().notice).toBeUndefined();
    });
});

describe('lobby socket direct messages', () => {
    beforeEach(async () => {
        disconnectLobby();
        useMessagesStore.getState().reset();
        useLobbyStore.getState().clearNotice();
        await useAuthStore.getState().setAuth({
            token: 'jwt',
            user: { id: '2', username: 'me' }
        });
        await connectLobby();
    });

    // A DM notification used to reach the phone and land nowhere. The notice
    // carries the thread's own route, so acting on it is one press.
    it('turns an incoming message into a notice pointing at the thread', () => {
        receive('directmessage', message('ana', 'me', 'Can we play at 8 instead?'));

        expect(useLobbyStore.getState().notice).toMatchObject({
            tone: 'info',
            message: 'ana: Can we play at 8 instead?',
            url: '/messages/ana'
        });
    });

    // The lobby sends the message to both ends so a second device shows what
    // the first one sent. Announcing our own message back at us is noise.
    it('says nothing about a message this player sent', () => {
        receive('directmessage', message('me', 'ana', 'Eight works.'));

        expect(useLobbyStore.getState().notice).toBeUndefined();
    });

    // The thread on screen already shows it; interrupting somebody reading a
    // conversation to tell them about that conversation is the worst kind of
    // alert.
    it('says nothing when the thread it belongs to is open', () => {
        useMessagesStore.getState().setViewing('ana');

        receive('directmessage', message('ana', 'me', 'Still there?'));

        expect(useLobbyStore.getState().notice).toBeUndefined();
    });

    it('trims a long message down to an excerpt', () => {
        receive('directmessage', message('ana', 'me', 'x'.repeat(200)));

        const notice = useLobbyStore.getState().notice;
        expect(notice?.message.startsWith('ana: ')).toBe(true);
        expect(notice?.message.endsWith('...')).toBe(true);
        expect(notice?.message.length).toBeLessThan(140);
    });
});
