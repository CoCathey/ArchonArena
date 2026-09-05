import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store persists through the keychain; none of that is under test here.
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => undefined),
    deleteItemAsync: vi.fn(async () => undefined)
}));

const { useAuthStore } = await import('../src/stores/authStore');

const account = (onboarded: boolean | undefined, id = '1') => ({
    id,
    username: `player${id}`,
    ...(onboarded === undefined ? {} : { onboarded })
});

describe('authStore.setAuth', () => {
    beforeEach(async () => {
        await useAuthStore.getState().clear();
    });

    // The lobby hands a copy of the user to the app with every game handoff,
    // taken from the socket's own user object — which was loaded when the
    // socket connected. Finish the welcome flow after that and the copy still
    // says onboarded: false; adopting it as-is sent the player back to step
    // one the moment they joined or watched a game.
    it('keeps a completed welcome flow when a stale copy of the same account arrives', async () => {
        await useAuthStore.getState().setAuth({ user: account(true) });
        await useAuthStore.getState().setAuth({ user: account(false) });

        expect(useAuthStore.getState().user?.onboarded).toBe(true);
    });

    it('takes the incoming value for a different account', async () => {
        await useAuthStore.getState().setAuth({ user: account(true, '1') });
        await useAuthStore.getState().setAuth({ user: account(false, '2') });

        expect(useAuthStore.getState().user?.onboarded).toBe(false);
    });

    it('does not invent the flag when the app never knew it', async () => {
        await useAuthStore.getState().setAuth({ user: account(undefined) });
        await useAuthStore.getState().setAuth({ user: account(false) });

        expect(useAuthStore.getState().user?.onboarded).toBe(false);
    });

    it('still learns completion from the server', async () => {
        await useAuthStore.getState().setAuth({ user: account(false) });
        await useAuthStore.getState().setAuth({ user: account(true) });

        expect(useAuthStore.getState().user?.onboarded).toBe(true);
    });

    it('keeps the other fields of the incoming copy', async () => {
        await useAuthStore.getState().setAuth({ user: { ...account(true), avatar: 'old' } });
        await useAuthStore.getState().setAuth({ user: { ...account(false), avatar: 'new' } });

        expect(useAuthStore.getState().user?.avatar).toBe('new');
    });
});
