import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

import { checkAuth, linkPatreon, startPatreonLink } from '../api/client';
import { isPatreonCallback, outcomeOf, parseCallbackUrl, RETURN_URL } from './patreonCallback';

/**
 * ARCHON (N12): connecting a Patreon account from the phone.
 *
 * This is a sign-in, not a purchase, which is what makes it acceptable on iOS:
 * the player already has a membership and is proving it. It buys nothing and
 * links to no checkout — see membership/storefront.ts.
 *
 * ## Why the system browser
 *
 * `openAuthSessionAsync` is ASWebAuthenticationSession on iOS and a Custom Tab
 * on Android. Both are required rather than merely tidy:
 *
 *  - The app never sees the player's Patreon password. Collecting a third
 *    party's credentials in your own UI is a rejection under Guideline 4.0, and
 *    a genuinely bad idea besides.
 *  - The player sees the real patreon.com address bar and certificate, which is
 *    the only way they can tell the consent screen is not ours.
 *  - It hands control back the moment the browser navigates to our scheme, so
 *    there is no polling and no "tap here when you're done" step.
 *
 * ## Why the code comes back through the website
 *
 * Patreon redirects to one registered URI and it is the website. The app marks
 * its OAuth `state`, the site's /patreon page recognises the marker and
 * forwards to `archonarena://patreon?code=…&state=…`, and the auth session
 * catches that navigation. Nothing sensitive rides on the redirect: the code is
 * single use, and redeeming it needs both this device's bearer token and the
 * signed state token the app was handed when it started.
 */

/**
 * How long to keep listening after the browser closes.
 *
 * The auth session is not the only way the callback can arrive: on some
 * platforms the deep link foregrounds the app first, and the browser promise
 * then resolves as a plain dismissal with no URL on it. Treating that as a
 * cancellation would abandon a link the player actually completed, so a
 * dismissal waits briefly to see whether the URL is right behind it.
 */
const CALLBACK_GRACE_MS = 800;

export type LinkOutcome =
    | { status: 'linked'; tier?: string }
    | { status: 'cancelled' }
    | { status: 'declined' }
    /** The server predates the app's link flow — see connectPatreon. */
    | { status: 'unsupported'; message: string }
    | { status: 'failed'; message: string };

/**
 * Open the consent screen and wait for the callback URL, from whichever route
 * it arrives by.
 *
 * @returns the callback URL, or undefined if the player backed out
 */
async function awaitCallback(authorizeUrl: string): Promise<string | undefined> {
    let resolveDeepLink: (url: string | undefined) => void = () => {};
    const viaDeepLink = new Promise<string | undefined>((resolve) => {
        resolveDeepLink = resolve;
    });

    const subscription = Linking.addEventListener('url', (event) => {
        if (isPatreonCallback(event?.url)) {
            resolveDeepLink(event.url);
        }
    });

    try {
        const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, RETURN_URL);

        if (result && result.type === 'success' && 'url' in result && result.url) {
            return result.url;
        }

        // No URL on the result. Either the player closed the sheet, or the deep
        // link beat the promise — wait a moment to tell those apart.
        const late = await Promise.race([
            viaDeepLink,
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), CALLBACK_GRACE_MS))
        ]);

        if (late) {
            // The listener won, so the browser may still be sitting on top.
            try {
                WebBrowser.dismissAuthSession();
            } catch {
                // Already closed on this platform; nothing to do.
            }
        }

        return late;
    } finally {
        subscription.remove();
    }
}

/**
 * Run the whole flow: ask the server for an authorization URL, open it, and
 * redeem whatever comes back.
 *
 * Resolves rather than throws for every outcome the player can cause, because
 * each of them is a normal thing to do — closing the sheet is not an error, and
 * refusing on Patreon's consent screen is not either.
 */
export async function connectPatreon(): Promise<LinkOutcome> {
    let start;

    try {
        start = await startPatreonLink();
    } catch (err) {
        return { status: 'failed', message: messageFor(err, 'Could not start Patreon linking.') };
    }

    if (!start.success || !start.url) {
        return {
            status: 'failed',
            message: start.message ?? 'Patreon linking is not available right now.'
        };
    }

    // ARCHON (N12): stop here rather than opening a browser that cannot finish.
    //
    // `mobile: true` asks the server for a state token the app can carry, since
    // it has no cookie jar. A server that predates the mobile flow ignores the
    // flag and answers with a URL alone - and if it does, its /patreon page is
    // the old one too, which will try to complete the link in a browser that
    // carries none of the player's session instead of forwarding to the app.
    //
    // Without this check that failure is invisible: the sheet opens, Patreon
    // redirects, nothing comes back, and the grace period reports it as the
    // player having changed their mind. Telling them plainly is worth more than
    // a consent screen that leads nowhere.
    if (!start.stateToken) {
        return {
            status: 'unsupported',
            message:
                'Connecting Patreon from the app is not available yet — Archon Arena needs an ' +
                'update on our side. Nothing on your account has changed.'
        };
    }

    let callbackUrl: string | undefined;

    try {
        callbackUrl = await awaitCallback(start.url);
    } catch (err) {
        return { status: 'failed', message: messageFor(err, 'Could not open Patreon.') };
    }

    if (!callbackUrl) {
        return { status: 'cancelled' };
    }

    const callback = parseCallbackUrl(callbackUrl);

    if (outcomeOf(callback) === 'declined') {
        return { status: 'declined' };
    }

    const { code, state } = callback;

    try {
        const linked = await linkPatreon({
            code: code as string,
            state: state as string,
            stateToken: start.stateToken
        });

        if (!linked.success) {
            return {
                status: 'failed',
                message: linked.message ?? 'Could not link your Patreon account.'
            };
        }

        // The tier the account now resolves to lives on the user object, and
        // every gated screen reads it from there. Without this refresh the
        // player links successfully and everything stays locked until the next
        // launch, which looks exactly like the link having failed.
        const user = await checkAuth();
        const membership = user?.membership as { tierName?: string } | undefined;

        return { status: 'linked', tier: membership?.tierName };
    } catch (err) {
        return {
            status: 'failed',
            message: messageFor(err, 'Could not link your Patreon account.')
        };
    }
}

function messageFor(err: unknown, fallback: string): string {
    return err instanceof Error && err.message ? err.message : fallback;
}

export { RETURN_URL, parseCallbackUrl };
