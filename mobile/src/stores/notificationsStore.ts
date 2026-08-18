import { create } from 'zustand';
import {
    fetchNotifications,
    fetchUnreadNotificationCount,
    markNotificationsRead,
    type NotificationRow
} from '../api/client';

/**
 * ARCHON: the in-app notification centre.
 *
 * The app has had push since N2, but push is a tap-it-now-or-lose-it channel:
 * dismiss the banner and the thing it told you about is gone. The website has
 * always kept the history behind the bell (`NotificationBell.jsx`) and the app
 * shipped the API calls for it without ever rendering them — `fetchNotifications`
 * and `markNotificationsRead` were in the client with no caller.
 *
 * Read state is the server's, not this store's: the same account reading a
 * notification in a browser has to clear the badge here too.
 */
interface NotificationsState {
    rows: NotificationRow[];
    unread: number;
    loading: boolean;
    error?: string;
    /** Pull the list (and the count that comes with it). */
    load: (options?: { quiet?: boolean }) => Promise<void>;
    /** Pull just the badge number — what the poll calls. */
    refreshCount: () => Promise<void>;
    /** Mark some (or, with no ids, all) as read. Optimistic. */
    markRead: (ids?: number[]) => Promise<void>;
    reset: () => void;
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
    rows: [],
    unread: 0,
    loading: false,
    error: undefined,
    load: async (options = {}) => {
        if (!options.quiet) {
            set({ loading: true, error: undefined });
        }
        try {
            const result = await fetchNotifications(50);
            set({
                rows: result.notifications ?? [],
                unread: result.unread ?? 0,
                loading: false,
                error: undefined
            });
        } catch (err) {
            set({
                loading: false,
                error: err instanceof Error ? err.message : 'Could not load notifications'
            });
        }
    },
    refreshCount: async () => {
        try {
            const result = await fetchUnreadNotificationCount();
            set({ unread: result.unread ?? 0 });
        } catch {
            // A failed poll leaves the last known count; it is a badge, not a
            // fact anything depends on.
        }
    },
    markRead: async (ids) => {
        const before = get().rows;
        const target = ids ? new Set(ids) : undefined;
        const after = before.map((row) =>
            !target || target.has(row.id) ? { ...row, read: true } : row
        );
        set({ rows: after, unread: after.filter((row) => !row.read).length });

        try {
            await markNotificationsRead(ids);
        } catch {
            // Put the badge back rather than showing a lie.
            set({ rows: before, unread: before.filter((row) => !row.read).length });
        }
    },
    reset: () => set({ rows: [], unread: 0, loading: false, error: undefined })
}));
