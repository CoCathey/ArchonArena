import { describe, expect, it, vi } from 'vitest';

// push.ts installs a foreground handler as it loads and reads the EAS project
// id; neither is under test here.
vi.mock('expo-notifications', () => ({ setNotificationHandler: () => undefined }));
vi.mock('expo-device', () => ({ isDevice: false }));
vi.mock('expo-constants', () => ({ default: { expoConfig: null, easConfig: undefined } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => undefined),
    deleteItemAsync: vi.fn(async () => undefined)
}));

const { routeForNotification } = await import('../src/push');

describe('routeForNotification', () => {
    it('opens the event a tournament notification names', () => {
        expect(routeForNotification({ tournamentId: 412, matchId: 8 })).toBe('/tournament/412');
    });

    // A direct message is the category that carries nothing but the site url.
    // Before the app had a messages screen this fell through to undefined, and
    // a push about a message the player could see on the website was a tap
    // that did nothing on the phone.
    it('opens the thread a direct-message notification came from', () => {
        expect(
            routeForNotification({
                senderUsername: 'ana',
                messageId: 12,
                url: '/messages/ana'
            })
        ).toBe('/messages/ana');
    });

    it('has nothing to open for a category the app cannot render', () => {
        expect(routeForNotification({ url: '/decks/9' })).toBeUndefined();
        expect(routeForNotification(undefined)).toBeUndefined();
    });
});
