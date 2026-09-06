import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandoffMessage } from '../src/api/types';

// The store persists through the keychain; none of that is under test here.
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => undefined),
    deleteItemAsync: vi.fn(async () => undefined)
}));

// The API client reaches react-native for Platform (which storefront policy
// keys off). Its Flow-typed entry point cannot be parsed under vitest, and
// none of it is under test here.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

const mocks = vi.hoisted(() => {
    /** Every socket io() has been asked for, with the options it was given. */
    const created: { options: { auth: (cb: (payload: unknown) => void) => void } }[] = [];

    return {
        created,
        io: vi.fn((_url: string, options: unknown) => {
            const socket = {
                connected: false,
                on: () => socket,
                io: { on: () => undefined },
                emit: () => undefined,
                connect: () => undefined,
                disconnect: () => undefined,
                removeAllListeners: () => undefined,
                close: () => undefined
            };

            created.push({ options: options as (typeof created)[number]['options'] });

            return socket;
        })
    };
});

vi.mock('socket.io-client', () => ({ io: mocks.io }));

const { connectToGame, closeGameSocket } = await import('../src/net/gameSocket');

function handoff(gameId: string): HandoffMessage {
    return {
        authToken: `token-for-${gameId}`,
        gameId,
        name: 'node-0',
        user: { id: '1', username: 'player' }
    };
}

/** Run the handshake the way socket.io does and return what it was told. */
function handshake(index: number): Record<string, unknown> {
    let payload: Record<string, unknown> = {};
    mocks.created[index].options.auth((value) => {
        payload = value as Record<string, unknown>;
    });

    return payload;
}

describe('game socket handshake', () => {
    beforeEach(() => {
        closeGameSocket();
        mocks.created.length = 0;
        mocks.io.mockClear();
    });

    // The node routes an incoming connection by this id, falling back to
    // finding the game by username. That fallback is the broken routing: an
    // account can be known to two games at once — a finished tournament table
    // whose seats are still held, and the next game of the same series.
    it('names the game it was handed off to', () => {
        connectToGame(handoff('game-1'));

        expect(handshake(0)).toMatchObject({ gameId: 'game-1' });
        expect(handshake(0).token).toBe('token-for-game-1');
    });

    // The id must come from the handoff each socket was built for. Read from a
    // module-level "current game" instead, the first socket's next reconnect
    // would authenticate as the second game and be routed to a table its
    // player is not at.
    it('keeps each socket on its own game after a later handoff', () => {
        connectToGame(handoff('game-1'));
        connectToGame(handoff('game-2'));

        expect(mocks.created).toHaveLength(2);
        expect(handshake(0)).toMatchObject({ gameId: 'game-1' });
        expect(handshake(1)).toMatchObject({ gameId: 'game-2' });
    });

    // The lobby re-sends the handoff on every reconnect while a game runs, and
    // that must keep reusing the socket rather than building a second one.
    it('does not rebuild the socket for the game it is already on', () => {
        connectToGame(handoff('game-1'));
        connectToGame(handoff('game-1'));

        expect(mocks.created).toHaveLength(1);
    });
});
