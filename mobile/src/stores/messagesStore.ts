import { create } from 'zustand';
import {
    fetchConversations,
    fetchMessageThread,
    fetchUnreadMessageCount,
    markThreadRead,
    sendDirectMessage,
    type DirectConversation,
    type DirectMessage
} from '../api/messages';

/**
 * ARCHON: direct messages, as the app holds them.
 *
 * One thread at a time is kept — a phone shows one conversation, and holding
 * every thread a player has ever opened is memory spent on screens nobody is
 * looking at.
 *
 * Live delivery re-reads rather than merges. The lobby sends 'directmessage'
 * to both ends of a conversation, and it would be easy to append the payload
 * to whatever is on screen; the website does not, and neither does this. The
 * socket copy and the REST copy are not quite the same shape (no `fromMe`, no
 * read stamp), a message can arrive while the thread is mid-page, and two
 * lobby processes can deliver the same line twice. One refetch per message in
 * a conversation about when to play a game is cheap; a thread that quietly
 * disagrees with the server is not.
 */
interface ThreadState {
    username: string;
    userId?: number;
    avatar?: string | null;
    /** Oldest first, the order they are read in. */
    messages: DirectMessage[];
    /** False when a block either way, or a deleted account, closes the thread. */
    canMessage: boolean;
    hasMore: boolean;
    loading: boolean;
    error?: string;
}

interface MessagesState {
    conversations: DirectConversation[];
    /** Messages waiting on this player, across every thread. */
    unread: number;
    loadingConversations: boolean;
    /** True once a load has completed, so an empty inbox reads as empty. */
    conversationsLoaded: boolean;
    error?: string;
    thread?: ThreadState;
    sending: boolean;
    /**
     * The thread currently on screen. A message arriving in it is already
     * visible, so it must not also interrupt the player with a notice — the
     * same check the website makes against the browser's location.
     */
    viewing?: string;
    loadConversations: (options?: { quiet?: boolean }) => Promise<void>;
    refreshUnread: () => Promise<void>;
    loadThread: (username: string, options?: { quiet?: boolean }) => Promise<void>;
    loadEarlier: () => Promise<void>;
    send: (username: string, text: string, options?: { matchId?: number }) => Promise<boolean>;
    markRead: (username: string) => Promise<void>;
    /** A live 'directmessage' from the lobby, for either end of the thread. */
    receive: (message: DirectMessage, viewer?: string) => void;
    setViewing: (username?: string) => void;
    reset: () => void;
}

/**
 * Only the newest thread load may write, so opening a second conversation
 * before the first has answered cannot repaint it with the wrong person's
 * messages.
 */
let threadSequence = 0;

/** Which side of a message the other player is on. */
export function otherPartyOf(message: DirectMessage, viewer?: string): string | undefined {
    if (!viewer) {
        return undefined;
    }

    return message.senderUsername === viewer
        ? message.recipientUsername
        : message.senderUsername;
}

export const useMessagesStore = create<MessagesState>((set, get) => ({
    conversations: [],
    unread: 0,
    loadingConversations: false,
    conversationsLoaded: false,
    thread: undefined,
    sending: false,
    viewing: undefined,
    loadConversations: async ({ quiet } = {}) => {
        set(quiet ? {} : { loadingConversations: true, error: undefined });
        try {
            const result = await fetchConversations();
            const conversations = result.conversations ?? [];
            set({
                conversations,
                // The inbox already carries the per-thread counts, so the badge
                // comes free with it rather than costing a second request.
                unread: conversations.reduce((total, entry) => total + (entry.unread || 0), 0),
                conversationsLoaded: true,
                loadingConversations: false,
                error: undefined
            });
        } catch (err) {
            set({
                loadingConversations: false,
                ...(quiet
                    ? {}
                    : {
                          error:
                              err instanceof Error ? err.message : 'Could not load your messages'
                      })
            });
        }
    },
    refreshUnread: async () => {
        try {
            const result = await fetchUnreadMessageCount();
            set({ unread: result.unread ?? 0 });
        } catch {
            // A failed poll leaves the last known count; it is a badge, not a
            // fact anything depends on.
        }
    },
    loadThread: async (username, { quiet } = {}) => {
        const id = ++threadSequence;
        const existing = get().thread;
        set({
            thread: {
                username,
                messages: existing?.username === username ? existing.messages : [],
                canMessage: existing?.username === username ? existing.canMessage : true,
                hasMore: existing?.username === username ? existing.hasMore : false,
                userId: existing?.username === username ? existing.userId : undefined,
                avatar: existing?.username === username ? existing.avatar : undefined,
                loading: !quiet,
                error: quiet ? existing?.error : undefined
            }
        });

        try {
            const result = await fetchMessageThread(username);
            if (id !== threadSequence) {
                return;
            }

            if (!result.success) {
                set({
                    thread: {
                        username,
                        messages: [],
                        canMessage: false,
                        hasMore: false,
                        loading: false,
                        error: result.message ?? 'No such player'
                    }
                });
                return;
            }

            set({
                thread: {
                    // Keyed on the name we asked for, never the one that comes
                    // back. The server answers with 'Deleted user' in place of
                    // a disabled account's name (server/services/community/
                    // DirectMessageService.js thread), and a thread whose key
                    // stops matching the screen's own route stops being shown
                    // at all: the player got an empty conversation and a live
                    // composer for the one person it is certain no message can
                    // be sent to, instead of `canMessage`'s refusal. The
                    // failure branch above already keys it this way, and every
                    // lookup on it is case-insensitive at both ends.
                    username,
                    userId: result.other?.userId,
                    avatar: result.other?.avatar,
                    messages: result.messages ?? [],
                    canMessage: result.canMessage !== false,
                    hasMore: !!result.hasMore,
                    loading: false,
                    error: undefined
                }
            });
        } catch (err) {
            if (id !== threadSequence) {
                return;
            }
            const thread = get().thread;
            set({
                thread: thread && {
                    ...thread,
                    loading: false,
                    error: err instanceof Error ? err.message : 'Could not load this conversation'
                }
            });
        }
    },
    loadEarlier: async () => {
        const thread = get().thread;
        if (!thread || !thread.hasMore || thread.loading || thread.messages.length === 0) {
            return;
        }

        const id = ++threadSequence;
        const before = thread.messages[0].id;
        set({ thread: { ...thread, loading: true } });

        try {
            const result = await fetchMessageThread(thread.username, { before });
            if (id !== threadSequence) {
                return;
            }

            const current = get().thread;
            if (!current || current.username !== thread.username) {
                return;
            }

            // Ids the page already holds are dropped rather than trusted:
            // "before this id" and a message arriving in the meantime can
            // overlap, and a doubled line reads as the sender saying it twice.
            const held = new Set(current.messages.map((message) => message.id));
            set({
                thread: {
                    ...current,
                    messages: [
                        ...(result.messages ?? []).filter((message) => !held.has(message.id)),
                        ...current.messages
                    ],
                    hasMore: !!result.hasMore,
                    loading: false
                }
            });
        } catch {
            const current = get().thread;
            set({ thread: current && { ...current, loading: false } });
        }
    },
    send: async (username, text, options = {}) => {
        const body = text.trim();
        if (!body || get().sending) {
            return false;
        }

        set({ sending: true });
        try {
            const result = await sendDirectMessage(username, body, options);
            if (!result.success) {
                const thread = get().thread;
                set({
                    sending: false,
                    thread: thread && thread.username === username
                        ? { ...thread, error: result.error }
                        : thread
                });
                return false;
            }

            set({ sending: false });
            // The lobby echoes the sent message back to us as 'directmessage',
            // but only while the socket is up. Refresh here too so a message
            // sent over a dropped socket still appears where it was typed.
            await get().loadThread(username, { quiet: true });
            get().loadConversations({ quiet: true });

            return true;
        } catch (err) {
            const thread = get().thread;
            set({
                sending: false,
                thread: thread && thread.username === username
                    ? {
                          ...thread,
                          error: err instanceof Error ? err.message : 'Could not send your message'
                      }
                    : thread
            });
            return false;
        }
    },
    markRead: async (username) => {
        const conversation = get().conversations.find(
            (entry) => entry.username.toLowerCase() === username.toLowerCase()
        );
        const clearing = conversation?.unread ?? 0;

        // Optimistic: the badge must go down as the thread opens, not a round
        // trip later, or it reads as unread mail you are looking at.
        if (clearing > 0) {
            set({
                unread: Math.max(0, get().unread - clearing),
                conversations: get().conversations.map((entry) =>
                    entry === conversation ? { ...entry, unread: 0 } : entry
                )
            });
        }

        try {
            await markThreadRead(username);
        } catch {
            // Leave the optimistic count alone: the next load corrects it, and
            // putting the badge back would be a worse lie than clearing it.
        }
    },
    receive: (message, viewer) => {
        const other = otherPartyOf(message, viewer);
        if (!other) {
            return;
        }

        const state = get();

        if (state.thread?.username.toLowerCase() === other.toLowerCase()) {
            state.loadThread(other, { quiet: true });

            // Reading is what marks a thread read; a message landing in the
            // thread on screen has been read the moment it arrives. The socket
            // copy carries no `fromMe` — it is written for both ends at once —
            // so which side sent it is derived here.
            const fromMe = message.senderUsername === viewer;

            if (!fromMe && state.viewing?.toLowerCase() === other.toLowerCase()) {
                state.markRead(other);
            }
        }

        if (state.conversationsLoaded) {
            state.loadConversations({ quiet: true });
        } else {
            // Nothing to reconcile, but the badge is shown outside the inbox.
            state.refreshUnread();
        }
    },
    setViewing: (viewing) => set({ viewing }),
    reset: () => {
        // Retire any in-flight thread load so a response for the previous
        // account cannot land after the reset.
        threadSequence++;
        set({
            conversations: [],
            unread: 0,
            loadingConversations: false,
            conversationsLoaded: false,
            error: undefined,
            thread: undefined,
            sending: false,
            viewing: undefined
        });
    }
}));
