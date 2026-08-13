/**
 * ARCHON (N12): remembers that someone went off to Patreon to subscribe.
 *
 * ## Why this exists
 *
 * The site cannot see a subscription on its own. Pledge status is read with the
 * player's OWN Patreon access token (PatreonService reads `/identity` as them),
 * and there is no webhook and no campaign-members poll - so an account that has
 * never been linked is invisible to us no matter how much it pays.
 *
 * That makes the link step the only channel, and it used to be a click the
 * player had to discover for themselves in Profile -> Integrations. The failure
 * mode is nasty and silent: they pay, they come back, the site still says Free,
 * and the reasonable conclusion is that the payment did not work.
 *
 * So when someone clicks a tier we record the intent, and when they come back
 * we ask them to finish. Nothing here grants anything - it only decides whether
 * to show a prompt.
 *
 * Deliberately localStorage rather than server state: it is a UI breadcrumb for
 * one browser, it must survive the full page load that follows a return from
 * Patreon, and it is not worth a database write for someone who may simply have
 * changed their mind.
 */

const KEY = 'aa_patreon_intent';

// Long enough to cover reading the tier list, signing in to Patreon and paying;
// short enough that a tab reopened next week does not nag about a decision the
// player has forgotten making.
const TTL_MS = 2 * 60 * 60 * 1000;

const storage = () => {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        // Access itself throws in some privacy modes.
        return null;
    }
};

/**
 * Note that the player has gone to Patreon to subscribe at `tierId`.
 *
 * @param {string} tierId
 */
export function recordUpgradeIntent(tierId) {
    const store = storage();

    if (!store) {
        return;
    }

    try {
        store.setItem(KEY, JSON.stringify({ tier: tierId, at: Date.now() }));
    } catch {
        // A full or unavailable store costs the prompt, nothing else.
    }
}

/**
 * The pending intent, or null. Expired entries are cleared as they are read, so
 * a stale breadcrumb cannot linger.
 *
 * @returns {{tier: string, at: number}|null}
 */
export function readUpgradeIntent() {
    const store = storage();

    if (!store) {
        return null;
    }

    let raw;

    try {
        raw = store.getItem(KEY);
    } catch {
        return null;
    }

    if (!raw) {
        return null;
    }

    let intent;

    try {
        intent = JSON.parse(raw);
    } catch {
        clearUpgradeIntent();

        return null;
    }

    if (!intent || typeof intent.at !== 'number' || Date.now() - intent.at > TTL_MS) {
        clearUpgradeIntent();

        return null;
    }

    return intent;
}

export function clearUpgradeIntent() {
    const store = storage();

    if (!store) {
        return;
    }

    try {
        store.removeItem(KEY);
    } catch {
        // Nothing to do; a stale entry expires on its own.
    }
}

export const UPGRADE_INTENT_TTL_MS = TTL_MS;
