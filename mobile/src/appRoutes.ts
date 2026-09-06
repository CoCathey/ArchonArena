/**
 * ARCHON: a site path the server handed us, as a route this app actually has.
 *
 * The server speaks one vocabulary of URLs to every client — the website's.
 * A notification carries `/tournaments/12`, a lobby notice carries the same,
 * a direct message carries `/messages/someone`. The app's route names are
 * close but not identical, and expo-router answers a route it does not have
 * with its unmatched-route error page: a tap that lands there is worse than a
 * tap that does nothing, because it looks like the app broke.
 *
 * So this maps only what the app can genuinely render and returns undefined
 * for the rest, which every caller reads as "nothing to open".
 */

/** Site paths this app has a screen for, in the order they are tried. */
const ROUTES: { pattern: RegExp; route: (match: RegExpMatchArray) => string }[] = [
    // The site pluralises the collection; the app names the screen after the
    // thing it shows (app/tournament/[id].tsx).
    { pattern: /^\/tournaments\/(\d+)/, route: (match) => `/tournament/${match[1]}` },
    // Direct messages keep the site's shape — a thread is addressed by the
    // other player's username, which is the id the API takes too. The segment
    // is passed through exactly as it arrived: the server percent-encodes the
    // username on its way out, and re-encoding it here would turn a name
    // containing a space into one containing a literal '%20'.
    { pattern: /^\/messages\/([^/]+)/, route: (match) => `/messages/${match[1]}` },
    { pattern: /^\/messages\/?$/, route: () => '/messages' }
];

export function routeForSiteUrl(url: unknown): string | undefined {
    if (typeof url !== 'string') {
        return undefined;
    }

    // Query and fragment are the website's business (a tab to open, an anchor
    // to scroll to); the app has neither, and leaving them on would stop every
    // pattern below from matching.
    const path = url.trim().split(/[?#]/)[0];

    for (const entry of ROUTES) {
        const match = path.match(entry.pattern);

        if (match) {
            return entry.route(match);
        }
    }

    return undefined;
}
