import { apiFetch, rawApiFetch } from './client';
import { useAuthStore } from '../stores/authStore';
import type { ApiResponse, UserDetails } from './types';

/**
 * ARCHON: the account-management half of the website, which the app only ever
 * had one piece of (deletion, because App Store review requires it).
 *
 * Signed-in sessions, the password, the profile a player writes about
 * themselves and the cosmetics a member has paid for were all browser-only —
 * so a Supporter could buy profile cosmetics on their phone and then have to
 * find a computer to use them.
 */

// ---- Sessions ----

export interface AccountSession {
    id: string;
    ip?: string;
    lastUsed?: string;
}

function me(): string {
    return useAuthStore.getState().user?.username ?? '';
}

export async function fetchSessions() {
    return apiFetch<ApiResponse & { tokens?: AccountSession[] }>(
        `/api/account/${encodeURIComponent(me())}/sessions`
    );
}

/**
 * Sign one device out. The server refuses to remove a session that does not
 * belong to the caller, so there is nothing to guard here beyond the id.
 */
export async function revokeSession(id: string) {
    return apiFetch<ApiResponse>(
        `/api/account/${encodeURIComponent(me())}/sessions/${encodeURIComponent(id)}`,
        { method: 'DELETE' }
    );
}

// ---- Profile details (email, password, game options) ----

export interface AccountUpdate {
    email?: string;
    password?: string;
    settings?: Record<string, unknown>;
}

/**
 * Save account details.
 *
 * The server replaces `user.settings` wholesale with what it is sent (keeping
 * the avatar and custom background, which have their own upload paths), so
 * every caller must send the settings it wants to KEEP as well as the ones it
 * is changing. Sending only the changed key would silently clear the rest.
 */
export async function updateAccount(update: AccountUpdate) {
    const result = await apiFetch<ApiResponse & { user?: UserDetails }>(
        `/api/account/${encodeURIComponent(me())}`,
        { method: 'PUT', body: { data: update } }
    );

    if (result.success && result.user) {
        await useAuthStore.getState().setAuth({ user: result.user });
    }

    return result;
}

/** Ask for a reset mail. Never says whether the address exists. */
export async function requestPasswordReset(username: string, captchaResponse?: string) {
    return rawApiFetch<ApiResponse>('/api/account/password-reset', {
        method: 'POST',
        body: { username, captchaResponse }
    });
}

// ---- Public profile: bio and location ----

export async function fetchBio() {
    return apiFetch<ApiResponse & { bio?: string | null; maxLength?: number }>(
        '/api/account/bio'
    );
}

export async function saveBio(bio: string) {
    return apiFetch<ApiResponse & { maxLength?: number }>('/api/account/bio', {
        method: 'PUT',
        body: { bio }
    });
}

export async function fetchLocation() {
    return apiFetch<ApiResponse & { country?: string; state?: string }>(
        '/api/account/location'
    );
}

export async function saveLocation(location: { country?: string; state?: string }) {
    return apiFetch<ApiResponse>('/api/account/location', {
        method: 'PUT',
        body: location
    });
}

// ---- Cosmetics (N12) ----

export interface CosmeticOption {
    id: string;
    label: string;
    hex?: string | null;
    capability?: string | null;
    /** True when this account's tier does not include it — shown, not hidden. */
    locked: boolean;
}

export interface CosmeticSlot {
    id: string;
    label: string;
    description?: string;
    default?: string;
    custom?: { capability: string; locked: boolean } | null;
    options: CosmeticOption[];
}

export interface CosmeticsResult extends ApiResponse {
    cosmetics?: Record<string, string | undefined>;
    catalog?: CosmeticSlot[];
}

/**
 * The whole catalogue, with the locked options marked rather than removed.
 * That is the server's deliberate choice and the screen must keep it: a picker
 * that silently has fewer swatches teaches a free player nothing about what
 * membership would give them.
 */
export async function fetchCosmetics() {
    return apiFetch<CosmeticsResult>('/api/account/cosmetics');
}

export async function saveCosmetics(cosmetics: Record<string, string | undefined>) {
    return apiFetch<CosmeticsResult>('/api/account/cosmetics', {
        method: 'PUT',
        body: { cosmetics }
    });
}

// ---- Preview programme (N12) ----

export interface PreviewFeature {
    id: string;
    label: string;
    summary?: string;
    stage?: string;
    stageLabel?: string;
    caution?: string;
    where?: string;
    /** False until the priority window opens for this account's tier. */
    available?: boolean;
    availableFrom?: string;
    /** True when early access is the reason it is available at all. */
    viaPriority?: boolean;
    priorityDays?: number;
    enabled?: boolean;
    defaultOn?: boolean;
}

export async function fetchPreviews() {
    return apiFetch<ApiResponse & { previews?: PreviewFeature[] }>('/api/membership/previews');
}

export async function setPreview(preview: string, enabled: boolean) {
    return apiFetch<ApiResponse>('/api/membership/previews', {
        method: 'POST',
        body: { preview, enabled }
    });
}
