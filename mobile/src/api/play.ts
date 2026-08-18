import { apiFetch, rawApiFetch } from './client';
import type { ApiResponse } from './types';

/**
 * ARCHON (N13/N9): playing across a table rather than over a socket.
 *
 * The website records paper games — both players report the result, the two
 * reports have to agree, and a confirmed game counts toward Amber the same way
 * an online one does. It also lists the stores where people play, and takes a
 * check-in code off a poster at an event.
 *
 * All of it was browser-only, which is exactly backwards: the phone is the
 * device you have at the table.
 */

// ---- In-person games ----

export interface InPersonPlayer {
    id: number;
    username: string;
}

export interface InPersonReport {
    reporterId: number;
    winnerId: number;
    player1Keys: number;
    player2Keys: number;
}

export interface InPersonGame {
    id: number;
    player1: InPersonPlayer;
    player2: InPersonPlayer;
    clubId?: number | null;
    clubName?: string | null;
    gameFormat?: string;
    /** 'pending' until both reports agree, then 'confirmed'. Or disputed. */
    status: string;
    rated?: boolean;
    unratedReason?: string | null;
    /** Set once a dispute has gone to the moderators, so escalate is offered once. */
    reportId?: number | null;
    playedAt?: string;
    confirmedAt?: string | null;
    /** Computed server-side — the only thing this player can act on. */
    awaitingMyReport?: boolean;
    reports?: InPersonReport[];
}

export interface InPersonListResult extends ApiResponse {
    games?: InPersonGame[];
    /**
     * Whether reporting will move Amber, sent WITH the list so a player knows
     * before they report rather than finding out afterwards.
     */
    rated?: boolean;
}

export async function fetchInPersonGames(limit = 25) {
    return apiFetch<InPersonListResult>(`/api/in-person-games?limit=${limit}`);
}

export async function createInPersonGame(body: {
    opponentUsername: string;
    gameFormat?: string;
    clubId?: number;
    playedAt?: string;
}) {
    return apiFetch<ApiResponse & { game?: InPersonGame }>('/api/in-person-games', {
        method: 'POST',
        body
    });
}

/**
 * File this player's half of the result. The game confirms only when both
 * reports agree; a mismatch marks it disputed rather than trusting either.
 */
export async function reportInPersonGame(
    id: number,
    body: { winnerId: number; player1Keys: number; player2Keys: number; deckId?: number }
) {
    return apiFetch<ApiResponse & { game?: InPersonGame }>(`/api/in-person-games/${id}/report`, {
        method: 'POST',
        body
    });
}

export async function withdrawInPersonReport(id: number) {
    return apiFetch<ApiResponse>(`/api/in-person-games/${id}/withdraw`, { method: 'POST' });
}

/** Send a disputed game to the moderators. Offered once — the server tracks it. */
export async function escalateInPersonGame(id: number) {
    return apiFetch<ApiResponse>(`/api/in-person-games/${id}/escalate`, { method: 'POST' });
}

export async function cancelInPersonGame(id: number) {
    return apiFetch<ApiResponse>(`/api/in-person-games/${id}/cancel`, { method: 'POST' });
}

// ---- Stores ----

export interface Store {
    id: number;
    name: string;
    country?: string;
    state?: string;
    city?: string;
    address?: string;
    website?: string;
    description?: string;
    addedByUserId?: number;
}

export async function fetchStores(
    options: { query?: string; country?: string; state?: string } = {}
) {
    const params = new URLSearchParams();
    if (options.query) {
        params.set('query', options.query);
    }
    if (options.country) {
        params.set('country', options.country);
    }
    if (options.state) {
        params.set('state', options.state);
    }
    const suffix = params.toString();

    return rawApiFetch<ApiResponse & { stores?: Store[] }>(
        `/api/stores${suffix ? `?${suffix}` : ''}`
    );
}

export async function addStore(body: {
    name: string;
    country?: string;
    state?: string;
    city?: string;
    address?: string;
    website?: string;
    description?: string;
}) {
    return apiFetch<ApiResponse & { store?: Store }>('/api/stores', { method: 'POST', body });
}

// ---- Onboarding ----

/** Mark the welcome flow done, so it never opens again for this account. */
export async function markOnboarded() {
    return apiFetch<ApiResponse>('/api/account/onboarded', { method: 'POST' });
}
