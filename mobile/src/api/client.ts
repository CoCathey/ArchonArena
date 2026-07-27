import { useAuthStore } from '../stores/authStore';
import { useSettingsStore } from '../stores/settingsStore';
import type {
    ApiResponse,
    Deck,
    GameRatingResult,
    LeaderboardResult,
    LoginResponse,
    MatchHistoryResult,
    PlayerRatingsResult,
    PlayerStatsResult,
    RefreshToken,
    ShortCard,
    UserDetails
} from './types';

/** Abort REST calls that hang (common on flaky mobile networks). */
const REQUEST_TIMEOUT_MS = 15000;

export class ApiError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
        super(message);
        this.status = status;
    }
}

function serverUrl(): string {
    return useSettingsStore.getState().serverUrl;
}

async function rawFetch<T>(
    path: string,
    options: { method?: string; body?: unknown; token?: string } = {}
): Promise<T> {
    const headers: Record<string, string> = {
        Accept: 'application/json'
    };
    if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
    }
    if (options.token) {
        headers.Authorization = `Bearer ${options.token}`;
    }

    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        response = await fetch(`${serverUrl()}${path}`, {
            method: options.method ?? 'GET',
            headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: controller.signal
        });
    } catch (err) {
        const timedOut = err instanceof Error && err.name === 'AbortError';
        throw new ApiError(
            timedOut
                ? `The server at ${serverUrl()} took too long to respond. Check your connection and try again.`
                : `Could not reach the server at ${serverUrl()}. Check your connection and the server URL.`
        );
    } finally {
        clearTimeout(timeout);
    }

    if (response.status === 401) {
        throw new ApiError('Unauthorized', 401);
    }

    let data: unknown;
    try {
        data = await response.json();
    } catch {
        throw new ApiError(`Unexpected response from server (HTTP ${response.status})`);
    }

    if (!response.ok) {
        const message =
            (data as { message?: string })?.message ?? `Request failed (HTTP ${response.status})`;
        throw new ApiError(message, response.status);
    }

    return data as T;
}

/**
 * Exchange the stored refresh token for a fresh 5-minute JWT.
 * Returns the new token, or undefined if the refresh token is missing/invalid.
 */
export async function refreshAuthToken(): Promise<string | undefined> {
    const { refreshToken, setAuth, clear } = useAuthStore.getState();
    if (!refreshToken) {
        return undefined;
    }

    try {
        const result = await rawFetch<LoginResponse>('/api/account/token', {
            method: 'POST',
            body: { token: refreshToken }
        });

        if (!result.success || !result.token) {
            await clear();
            return undefined;
        }

        await setAuth({ token: result.token, user: result.user });
        return result.token;
    } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
            await clear();
        }
        return undefined;
    }
}

/**
 * Authenticated request wrapper: attaches the current JWT and transparently
 * refreshes it once on a 401 before failing.
 */
export async function apiFetch<T extends ApiResponse>(
    path: string,
    options: { method?: string; body?: unknown } = {}
): Promise<T> {
    let token = useAuthStore.getState().token;
    if (!token) {
        token = await refreshAuthToken();
    }

    try {
        return await rawFetch<T>(path, { ...options, token });
    } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
            const newToken = await refreshAuthToken();
            if (newToken) {
                return await rawFetch<T>(path, { ...options, token: newToken });
            }
        }
        throw err;
    }
}

// ---- Account ----

export async function login(username: string, password: string): Promise<LoginResponse> {
    const result = await rawFetch<LoginResponse>('/api/account/login', {
        method: 'POST',
        body: { username, password }
    });

    if (result.success && result.token) {
        await useAuthStore.getState().setAuth({
            token: result.token,
            refreshToken: result.refreshToken as RefreshToken,
            user: result.user
        });
    }

    return result;
}

export async function register(
    username: string,
    email: string,
    password: string
): Promise<ApiResponse> {
    return rawFetch<ApiResponse>('/api/account/register', {
        method: 'POST',
        body: { username, email, password }
    });
}

export async function checkAuth(): Promise<UserDetails | undefined> {
    try {
        const result = await apiFetch<ApiResponse & { user?: UserDetails }>(
            '/api/account/checkauth',
            { method: 'POST' }
        );
        if (result.success && result.user) {
            await useAuthStore.getState().setAuth({ user: result.user });
            return result.user;
        }
    } catch {
        // fall through
    }
    return undefined;
}

export async function logout(): Promise<void> {
    const { refreshToken } = useAuthStore.getState();
    try {
        if (refreshToken?.id) {
            await apiFetch<ApiResponse>('/api/account/logout', {
                method: 'POST',
                body: { tokenId: refreshToken.id }
            });
        }
    } catch {
        // best effort — clear locally regardless
    }
    await useAuthStore.getState().clear();
}

// ---- Decks ----

export interface DeckListResult extends ApiResponse {
    decks: Deck[];
    numDecks: number;
}

export async function fetchDecks(options: { pageSize?: number; page?: number } = {}) {
    const params = new URLSearchParams();
    params.set('pageSize', String(options.pageSize ?? 50));
    params.set('page', String(options.page ?? 1));
    params.set('sort', 'lastUpdated');
    params.set('sortDir', 'desc');
    return apiFetch<DeckListResult>(`/api/decks?${params.toString()}`);
}

export async function importDeck(uuid: string) {
    return apiFetch<ApiResponse & { deck?: Deck }>('/api/decks', {
        method: 'POST',
        body: { uuid }
    });
}

export async function deleteDeck(id: Deck['id']) {
    return apiFetch<ApiResponse>(`/api/decks/${id}`, { method: 'DELETE' });
}

export interface StandaloneDecksResult extends ApiResponse {
    decks: Deck[];
}

export async function fetchStandaloneDecks() {
    return apiFetch<StandaloneDecksResult>('/api/standalone-decks');
}

/** Extract a Master Vault deck uuid from a pasted link or raw uuid. */
export function parseDeckUuid(input: string): string | undefined {
    const trimmed = (input || '').trim();
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const match = trimmed.match(uuidPattern);
    return match ? match[0].toLowerCase() : undefined;
}

export interface DeckDetailResult extends ApiResponse {
    deck?: Deck;
    aerc?: unknown;
}

/** Full deck (with card list) — only works for the caller's own decks. */
export async function fetchDeck(id: Deck['id']) {
    return apiFetch<DeckDetailResult>(`/api/decks/${id}`);
}

// ---- Cards ----

export interface CardsResult extends ApiResponse {
    cards?: Record<string, ShortCard>;
}

/**
 * The full card dictionary (short form), used to resolve deck-card ids to
 * names/types. Public endpoint; the payload is sizeable so callers cache it
 * (see stores/cardsStore).
 */
export async function fetchAllCards() {
    return rawFetch<CardsResult>('/api/cards');
}

// ---- Rankings / stats / match history ----

export async function fetchLeaderboard(
    options: { pool?: string; scope?: string; limit?: number; offset?: number } = {}
) {
    const params = new URLSearchParams();
    params.set('pool', options.pool ?? 'archon');
    params.set('scope', options.scope ?? 'world');
    params.set('limit', String(options.limit ?? 50));
    params.set('offset', String(options.offset ?? 0));
    return rawFetch<LeaderboardResult>(`/api/ratings/leaderboard?${params.toString()}`);
}

export async function fetchPlayerRatings(username: string) {
    return rawFetch<PlayerRatingsResult>(`/api/ratings/${encodeURIComponent(username)}`);
}

export async function fetchPlayerStats(username: string) {
    return rawFetch<PlayerStatsResult>(`/api/stats/player/${encodeURIComponent(username)}`);
}

/** The caller's own finished games (server caps this at the latest 30). */
export async function fetchMatchHistory() {
    return apiFetch<MatchHistoryResult>('/api/games');
}

export async function fetchGameRating(gameId: string) {
    return apiFetch<GameRatingResult>(`/api/games/${encodeURIComponent(gameId)}/rating`);
}
