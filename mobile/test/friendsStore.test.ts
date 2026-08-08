import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FriendsResult } from '../src/api/types';

const fetchFriends = vi.fn<() => Promise<FriendsResult>>();

vi.mock('../src/api/client', () => ({
    fetchFriends: () => fetchFriends()
}));

const { useFriendsStore } = await import('../src/stores/friendsStore');

const overview = (incoming: string[] = [], friends: string[] = []): FriendsResult => ({
    success: true,
    friends: friends.map((username, index) => ({ userId: 100 + index, username })),
    incoming: incoming.map((username, index) => ({ userId: index + 1, username })),
    outgoing: []
});

/** A promise plus the handle to settle it, so loads can be overlapped. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('friendsStore', () => {
    beforeEach(() => {
        fetchFriends.mockReset();
        useFriendsStore.getState().reset();
    });

    it('loads the three lists', async () => {
        fetchFriends.mockResolvedValue(overview(['ana'], ['bo']));

        await useFriendsStore.getState().load();

        const state = useFriendsStore.getState();
        expect(state.incoming.map((entry) => entry.username)).toEqual(['ana']);
        expect(state.friends.map((entry) => entry.username)).toEqual(['bo']);
        expect(state.loaded).toBe(true);
        expect(state.loading).toBe(false);
    });

    it('lets a refresh through while a poll is still in flight', async () => {
        // The reason the store does not guard on `loading`: accepting a request
        // refreshes the lists, and that refresh must not be swallowed just
        // because the 60s background poll happened to be running.
        const poll = deferred<FriendsResult>();
        const refresh = deferred<FriendsResult>();
        fetchFriends.mockReturnValueOnce(poll.promise).mockReturnValueOnce(refresh.promise);

        const pollPromise = useFriendsStore.getState().load({ quiet: true });
        const refreshPromise = useFriendsStore.getState().load();

        // The stale poll answers last, and must not win.
        refresh.resolve(overview([], ['ana']));
        await refreshPromise;
        poll.resolve(overview(['ana']));
        await pollPromise;

        const state = useFriendsStore.getState();
        expect(state.incoming).toEqual([]);
        expect(state.friends.map((entry) => entry.username)).toEqual(['ana']);
        expect(state.loading).toBe(false);
    });

    it('keeps a visible error out of the background poll', async () => {
        fetchFriends.mockRejectedValueOnce(new Error('offline'));

        await useFriendsStore.getState().load({ quiet: true });

        expect(useFriendsStore.getState().error).toBeUndefined();
    });

    it('reports an error from a load the user asked for', async () => {
        fetchFriends.mockRejectedValueOnce(new Error('offline'));

        await useFriendsStore.getState().load();

        expect(useFriendsStore.getState().error).toBe('offline');
    });

    it('drops a response that arrives after a reset', async () => {
        const pending = deferred<FriendsResult>();
        fetchFriends.mockReturnValueOnce(pending.promise);

        const load = useFriendsStore.getState().load();
        // Signing out mid-flight.
        useFriendsStore.getState().reset();
        pending.resolve(overview(['ana'], ['bo']));
        await load;

        const state = useFriendsStore.getState();
        expect(state.friends).toEqual([]);
        expect(state.incoming).toEqual([]);
        expect(state.loaded).toBe(false);
    });
});
