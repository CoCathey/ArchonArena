/**
 * ARCHON (N12): reading the OAuth callback the browser hands back.
 *
 * Its own module, with no Expo imports, for two reasons: this is the part with
 * edge cases — Patreon returns an error instead of a code when the player
 * declines, and the callback arrives as a raw string rather than as anything
 * already parsed — and it is the part worth testing without a device.
 */

/** Where the site sends a mobile link back to. Matches `expo.scheme`. */
export const RETURN_URL = 'archonarena://patreon';

export interface PatreonCallback {
    code?: string;
    state?: string;
    error?: string;
}

/**
 * @param url e.g. archonarena://patreon?code=abc&state=m.xyz
 */
export function parseCallbackUrl(url: string): PatreonCallback {
    const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    const params = new URLSearchParams(query);

    return {
        code: params.get('code') ?? undefined,
        state: params.get('state') ?? undefined,
        error: params.get('error') ?? undefined
    };
}

/** Is this the URL we are waiting for, rather than some other deep link? */
export function isPatreonCallback(url: string | undefined | null): boolean {
    return !!url && url.startsWith(RETURN_URL);
}

/**
 * What the callback means.
 *
 * `declined` covers both Patreon's explicit `error` and a callback with no code
 * on it — from the app's point of view they are the same outcome, and treating
 * a missing code as a failure would show an error for something the player
 * chose.
 */
export function outcomeOf(callback: PatreonCallback): 'ready' | 'declined' {
    return !callback.error && callback.code && callback.state ? 'ready' : 'declined';
}
