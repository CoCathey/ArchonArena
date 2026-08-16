import { useAuthStore } from '../stores/authStore';
import { canShowPurchaseLinks } from '../membership/storefront';
import { withoutPurchaseInfo } from '../membership/catalogPolicy';
import { useSettingsStore } from '../stores/settingsStore';
import type {
    AercBreakdown,
    ApiResponse,
    Deck,
    DeckStatsResult,
    FriendsResult,
    GameRatingResult,
    LeaderboardResult,
    LoginResponse,
    MatchHistoryResult,
    MetaStatsResult,
    PlayerRatingsResult,
    PlayerStatsResult,
    RefreshToken,
    ShortCard,
    UserDetails,
    DeckIntelligenceResult,
    MembershipCatalogResult,
    MetaIntelligenceResult,
    MyMembershipResult,
    PatreonLinkStartResult,
    PatreonStatusResult,
    PlayerIntelligenceResult,
    ReplayIntelligenceResult,
    TournamentLabResult
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

/**
 * Replace the signed-in user's avatar. `image` is the raw base64 body of a PNG
 * or JPEG (no data: prefix) — the server rejects anything else. Returns the
 * stored file name, which is also the path segment under /img/avatar.
 */
export async function updateAvatar(image: string): Promise<ApiResponse & { avatar?: string }> {
    const result = await apiFetch<ApiResponse & { avatar?: string }>('/api/account/avatar', {
        method: 'PUT',
        body: { avatar: image }
    });

    if (result.success && result.avatar) {
        const { user, setAuth } = useAuthStore.getState();
        if (user) {
            await setAuth({
                user: {
                    ...user,
                    avatar: result.avatar,
                    settings: { ...(user.settings ?? {}), avatar: result.avatar }
                }
            });
        }
    }

    return result;
}

/** Public URL of a user's avatar image, or undefined if they have none. */
export function avatarUrl(avatar?: unknown): string | undefined {
    if (!avatar || typeof avatar !== 'string') {
        return undefined;
    }
    return `${serverUrl()}/img/avatar/${avatar}.png`;
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
    /** Total matching the filter, not the page size — drives "load more". */
    numDecks: number;
}

/** Columns the server can order by (DeckService.mapColumn). */
export type DeckSort = 'lastUpdated' | 'name' | 'sasRating' | 'winRate' | 'expansion';

export interface DeckQuery {
    pageSize?: number;
    page?: number;
    sort?: DeckSort;
    sortDir?: 'asc' | 'desc';
    /** Substring match on the deck name. */
    search?: string;
    /** House codes; a deck matches if it contains every house listed. */
    houses?: string[];
    /**
     * Restrict to alliance decks (true) or exclude them (false). Alliance decks
     * are only legal in an alliance game, and only there — the same split the
     * web client applies.
     */
    isAlliance?: boolean;
    /**
     * SAS range, for the picker in a SAS-bound game. Compared on the DeckSas
     * join, so decks DoK has not rated drop out — the same rule the game
     * itself enforces on selection.
     */
    sasMin?: number;
    sasMax?: number;
    /**
     * Restrict to (true) or exclude (false) the Unchained set. Unchained decks
     * are legal only in an Unchained game and are the only thing legal there,
     * so every game sends one or the other; omitting it lists everything, which
     * is what the deck library outside a game wants.
     */
    unchained?: boolean;
}

export async function fetchDecks(options: DeckQuery = {}) {
    const params = new URLSearchParams();
    params.set('pageSize', String(options.pageSize ?? 50));
    params.set('page', String(options.page ?? 1));
    params.set('sort', options.sort ?? 'lastUpdated');
    params.set('sortDir', options.sortDir ?? 'desc');

    const filter: { name: string; value: unknown }[] = [];
    const search = (options.search ?? '').trim();
    if (search) {
        // The server compares against lower("Name"), so a mixed-case term would
        // otherwise never match.
        filter.push({ name: 'name', value: search.toLowerCase() });
    }
    for (const house of options.houses ?? []) {
        filter.push({ name: 'house', value: house });
    }
    if (options.isAlliance !== undefined) {
        filter.push({ name: 'isAlliance', value: options.isAlliance });
    }
    if (options.sasMin !== undefined) {
        filter.push({ name: 'sasMin', value: options.sasMin });
    }
    if (options.sasMax !== undefined) {
        filter.push({ name: 'sasMax', value: options.sasMax });
    }
    if (options.unchained !== undefined) {
        filter.push({ name: 'unchained', value: options.unchained });
    }
    if (filter.length > 0) {
        params.set('filter', JSON.stringify(filter));
    }

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
    /** AERC component breakdown behind the SAS score; null when DoK has no data. */
    aerc?: AercBreakdown | null;
}

/** Full deck (with card list) — only works for the caller's own decks. */
export async function fetchDeck(id: Deck['id']) {
    return apiFetch<DeckDetailResult>(`/api/decks/${id}`);
}

// ---- Notifications ----

export interface NotificationRow {
    id: number;
    category: string;
    title: string;
    body?: string;
    url?: string;
    data?: Record<string, unknown>;
    read: boolean;
    createdAt: string;
}

export async function fetchNotifications(limit = 30) {
    return apiFetch<ApiResponse & { notifications?: NotificationRow[]; unread?: number }>(
        `/api/notifications?limit=${limit}`
    );
}

export async function markNotificationsRead(ids?: number[]) {
    return apiFetch<ApiResponse>('/api/notifications/read', { method: 'POST', body: { ids } });
}

export interface NotificationPreference {
    category: string;
    group: string;
    label: string;
    description: string;
    inApp: boolean;
    email: boolean;
    push: boolean;
}

export async function fetchNotificationPreferences() {
    return apiFetch<ApiResponse & { preferences?: NotificationPreference[] }>(
        '/api/notifications/preferences'
    );
}

export async function setNotificationPreference(
    category: string,
    channels: { inApp?: boolean; email?: boolean; push?: boolean }
) {
    return apiFetch<ApiResponse>('/api/notifications/preferences', {
        method: 'POST',
        body: { category, ...channels }
    });
}

/** Tell the server this device can receive push. Sent on every launch. */
export async function registerPushToken(
    token: string,
    details: { platform?: string; deviceName?: string } = {}
) {
    return apiFetch<ApiResponse>('/api/notifications/push-token', {
        method: 'POST',
        body: { token, ...details }
    });
}

export async function removePushToken(token: string) {
    return apiFetch<ApiResponse>('/api/notifications/push-token/remove', {
        method: 'POST',
        body: { token }
    });
}

// ---- Friends ----

export async function fetchFriends() {
    return apiFetch<FriendsResult>('/api/friends');
}

/** Ask to be someone's friend. Accepts their pending request if they asked first. */
export async function sendFriendRequest(username: string) {
    return apiFetch<ApiResponse>('/api/friends/request', {
        method: 'POST',
        body: { username }
    });
}

/** Answer an incoming request. `userId` is the person who sent it. */
export async function respondToFriendRequest(userId: number, accept: boolean) {
    return apiFetch<ApiResponse>('/api/friends/respond', {
        method: 'POST',
        body: { userId, accept }
    });
}

/** Unfriend, or withdraw a request still waiting on them — the same call. */
export async function removeFriend(userId: number) {
    return apiFetch<ApiResponse>('/api/friends/remove', {
        method: 'POST',
        body: { userId }
    });
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

/** Platform-wide aggregates: house/set/format/SAS-band win rates. */
export async function fetchMetaStats() {
    return rawFetch<MetaStatsResult>('/api/stats/meta');
}

/** Per-deck record for a player, with each deck's SAS-vs-performance delta. */
export async function fetchDeckStats(username: string) {
    return rawFetch<DeckStatsResult>(`/api/stats/decks/${encodeURIComponent(username)}`);
}

/** The caller's own finished games (server caps this at the latest 30). */
export async function fetchMatchHistory() {
    return apiFetch<MatchHistoryResult>('/api/games');
}

export async function fetchGameRating(gameId: string) {
    return apiFetch<GameRatingResult>(`/api/games/${encodeURIComponent(gameId)}/rating`);
}

// ---- Archon+ membership (N12) ----

/**
 * The tier catalogue: what each tier includes, what it costs, and where it can
 * be bought. Public, because it is a price list.
 *
 * ## The money is stripped here, not just hidden in the UI
 *
 * On a platform where purchase links are not allowed — iOS, under App Store
 * Review Guideline 3.1.1 — the price and the checkout URL are removed from the
 * payload before any screen sees them. The screens also guard on
 * `canShowPurchaseLinks()`, but a guard is something a future edit has to
 * remember; an absent field is something it cannot get wrong. A `$` cannot be
 * rendered from a price that is not there.
 *
 * `includes`, `adds` and the capability copy all survive: describing what
 * membership gives you is not a call to action, and 3.1.3(b) is exactly the
 * provision that lets a multiplatform service do it.
 */
export async function fetchMembershipCatalog(): Promise<MembershipCatalogResult> {
    const catalog = await rawFetch<MembershipCatalogResult>('/api/membership/catalog');

    return canShowPurchaseLinks() ? catalog : withoutPurchaseInfo(catalog);
}

/** The signed-in account's own tier and capability list. */
export async function fetchMyMembership() {
    return apiFetch<MyMembershipResult>('/api/membership/me');
}

/** Whether Patreon linking is configured at all. Drives whether any of it shows. */
export async function fetchPatreonStatus() {
    return rawFetch<PatreonStatusResult>('/api/account/patreon/status');
}

/**
 * Begin an account link. `mobile: true` asks the server to mark the OAuth state
 * so the website forwards the callback to the app, and to return the signed
 * state token in the body — the app has no cookie jar to keep it in.
 */
export async function startPatreonLink() {
    return apiFetch<PatreonLinkStartResult>('/api/account/patreon/link/start', {
        method: 'POST',
        body: { mobile: true }
    });
}

export async function linkPatreon(params: { code: string; state: string; stateToken?: string }) {
    return apiFetch<ApiResponse & { status?: string }>('/api/account/linkPatreon', {
        method: 'POST',
        body: params
    });
}

export async function unlinkPatreon() {
    return apiFetch<ApiResponse>('/api/account/unlinkPatreon', { method: 'POST' });
}

// ---- Archon Intelligence ----

/**
 * The player payload. Gated per section server-side, so it is worth requesting
 * whenever the account holds ANY of its capabilities — asking only when the
 * highest one is held is what used to leave a Supporter without the Elo history
 * they had paid for. `locked` names the sections that were withheld.
 */
export async function fetchPlayerIntelligence(sets: number[] = []) {
    return apiFetch<PlayerIntelligenceResult>(`/api/intelligence/player${setsQuery(sets)}`);
}

/** One deck, from the caller's own games. Only ever their own decks. */
/**
 * A set filter as a query string. Empty means every set — and that is NOT the
 * same as sending an empty filter, which the server would read as "no sets at
 * all", so the parameter is omitted rather than sent blank.
 */
function setsQuery(sets: number[]): string {
    return sets.length ? `?sets=${sets.join(',')}` : '';
}

export async function fetchDeckIntelligence(deckId: number) {
    return apiFetch<DeckIntelligenceResult>(`/api/intelligence/deck/${deckId}`);
}

export async function fetchMetaIntelligence(days = 30, sets: number[] = []) {
    const query = sets.length ? `&sets=${sets.join(',')}` : '';

    return apiFetch<MetaIntelligenceResult>(`/api/intelligence/meta?days=${days}${query}`);
}

/**
 * ARCHON (N12): Replay Intelligence — the houses you actually call.
 *
 * Deliberately takes no set filter, unlike everything else on the Intelligence
 * screen. A recording is a game, not the deck row the set filter is built from,
 * so the server could not honour a narrowing here; and each request parses that
 * many stored JSON documents, which is not work to repeat on a phone every time
 * somebody taps a set chip.
 */
export async function fetchReplayIntelligence(limit = 25) {
    return apiFetch<ReplayIntelligenceResult>(`/api/intelligence/replays?limit=${limit}`);
}

/** Compare up to four of your own decks. No decks selected still returns candidates. */
export async function fetchTournamentLab(deckIds: number[] = []) {
    const query = deckIds.length ? `?decks=${deckIds.join(',')}` : '';

    return apiFetch<TournamentLabResult>(`/api/intelligence/tournament-lab${query}`);
}
