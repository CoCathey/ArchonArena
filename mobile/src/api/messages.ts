import { apiFetch } from './client';
import type { ApiResponse } from './types';

/**
 * ARCHON: direct messages (server/api/messages.js).
 *
 * A tournament pairs two people who then have to agree on when to play, and
 * the platform gave them a scheduler and no way to talk. The website grew an
 * inbox for that; the phone got the push notification about it and nowhere to
 * land, which is worse than not sending it.
 *
 * Every route is scoped to the calling account inside the service, so there is
 * nothing to authorise here — a thread is addressed by the other player's
 * username, exactly as it is on the site.
 */

/**
 * One message. The wire shape differs slightly by source: the REST thread
 * stamps `fromMe` and omits `senderUsername` for your own lines, while the
 * lobby socket sends both usernames and no `fromMe` (it does not know who is
 * reading). Callers that need the flag derive it — see the messages store.
 */
export interface DirectMessage {
    id: number;
    senderId: number;
    senderUsername?: string;
    recipientId: number;
    recipientUsername?: string;
    text: string;
    matchId?: number | null;
    /** Postgres timestamps come back without a zone; they are UTC. */
    sentAt: string;
    readAt?: string | null;
    fromMe?: boolean;
}

export interface DirectConversation {
    userId: number;
    username: string;
    avatar?: string | null;
    lastMessage: { id: number; text: string; sentAt: string; fromMe: boolean };
    /** Messages from this person still unread by us. */
    unread: number;
}

export interface ConversationsResult extends ApiResponse {
    conversations?: DirectConversation[];
}

export interface UnreadCountResult extends ApiResponse {
    unread?: number;
    senders?: number;
}

export interface ThreadResult extends ApiResponse {
    other?: { userId: number; username: string; avatar?: string | null };
    /** False when a block (either way) or a deleted account closes the thread. */
    canMessage?: boolean;
    hasMore?: boolean;
    messages?: DirectMessage[];
}

export async function fetchConversations() {
    return apiFetch<ConversationsResult>('/api/messages/conversations');
}

export async function fetchUnreadMessageCount() {
    return apiFetch<UnreadCountResult>('/api/messages/unread-count');
}

/** A page of one thread, oldest first. `before` scrolls back. */
export async function fetchMessageThread(
    username: string,
    options: { before?: number; limit?: number } = {}
) {
    const query = new URLSearchParams();
    if (options.before) {
        query.set('before', String(options.before));
    }
    if (options.limit) {
        query.set('limit', String(options.limit));
    }
    const suffix = query.toString() ? `?${query}` : '';

    return apiFetch<ThreadResult>(
        `/api/messages/with/${encodeURIComponent(username)}${suffix}`
    );
}

/**
 * Send one message.
 *
 * The endpoint overloads its `message` field — the stored message object on
 * success, the reason as a string on refusal (a mute, a block, an empty body)
 * — so this normalises it rather than making every caller remember that.
 */
export async function sendDirectMessage(
    username: string,
    text: string,
    options: { matchId?: number } = {}
): Promise<{ success: boolean; message?: DirectMessage; error?: string }> {
    const result = (await apiFetch<ApiResponse>(
        `/api/messages/with/${encodeURIComponent(username)}`,
        { method: 'POST', body: { text, matchId: options.matchId } }
    )) as ApiResponse & { message?: string | DirectMessage };

    if (result.success && result.message && typeof result.message !== 'string') {
        return { success: true, message: result.message };
    }

    return {
        success: false,
        error:
            typeof result.message === 'string' ? result.message : 'Could not send your message'
    };
}

/** Reading a thread is what marks it read; scoped to us as the recipient. */
export async function markThreadRead(username: string) {
    return apiFetch<ApiResponse & { updated?: number }>(
        `/api/messages/with/${encodeURIComponent(username)}/read`,
        { method: 'POST' }
    );
}
