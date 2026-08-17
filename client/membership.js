/**
 * ARCHON (N12): client-side membership helpers.
 *
 * These capability ids mirror server/services/membership/capabilities.js. The
 * duplication is deliberate and is limited to the *names*: the mapping from
 * tier to capability, and the admin override, exist only on the server, and the
 * client never re-derives either. It reads `user.capabilities` - the resolved
 * list the server put on the user object - and asks whether a string is in it.
 *
 * That is what keeps the two honest. A hand-edited client can unhide a panel,
 * but the endpoint behind it carries `requireCapability` and will refuse, so
 * the worst outcome is an empty panel rather than leaked premium data.
 */

export const CAPABILITIES = Object.freeze({
    // Supporter
    ELO_HISTORY: 'elo_history',
    EXPANDED_MATCH_HISTORY: 'expanded_match_history',
    ADVANCED_PLAYER_STATS: 'advanced_player_stats',
    ADVANCED_DECK_STATS: 'advanced_deck_stats',
    PERFORMANCE_DASHBOARD: 'performance_dashboard',
    PROFILE_COSMETICS: 'profile_cosmetics',
    SUPPORTER_BADGE: 'supporter_badge',
    HISTORICAL_STATS: 'historical_stats',

    // Archon
    ARCHON_INTELLIGENCE: 'archon_intelligence',
    MATCHUP_ANALYTICS: 'matchup_analytics',
    DECK_COMPARISON: 'deck_comparison',
    PERSONAL_DECK_RANKINGS: 'personal_deck_rankings',
    TOURNAMENT_LAB: 'tournament_lab',
    ADVANCED_REPLAYS: 'advanced_replays',
    PRIVATE_LEAGUES: 'private_leagues',
    CUSTOM_TOURNAMENTS: 'custom_tournaments',
    ADVANCED_PERFORMANCE_DASHBOARD: 'advanced_performance_dashboard',
    META_ANALYTICS: 'meta_analytics',
    AERC_ANALYTICS: 'aerc_analytics',
    EARLY_ACCESS: 'early_access',

    // Vault Master
    EXPERIMENTAL_FEATURES: 'experimental_features',
    BETA_FEATURES: 'beta_features',
    ENHANCED_COSMETICS: 'enhanced_cosmetics',
    ORGANIZER_TOOLS: 'organizer_tools',
    PRIORITY_ACCESS: 'priority_access',
    CHAMPIONS_CHALLENGE: 'champions_challenge'
});

export const TIERS = Object.freeze({
    FREE: 'free',
    SUPPORTER: 'supporter',
    ARCHON: 'archon',
    VAULT_MASTER: 'vault_master'
});

/**
 * Does this user hold a capability?
 *
 * ## The client-side admin override
 *
 * An admin's `capabilities` array already contains everything, because the
 * server resolved it that way - so in the normal case the array alone is
 * enough. The explicit admin check below is a floor under that, for the case
 * where the array is missing or stale:
 *
 *   - a session whose stored user predates this feature,
 *   - a user object that reached redux by a path that does not carry
 *     capabilities,
 *   - anything that leaves `capabilities` undefined.
 *
 * In every one of those, an admin would otherwise see every premium panel
 * locked - which is exactly the failure this system is supposed to make
 * impossible, and it fails silently because a locked panel looks like a
 * product decision rather than a bug.
 *
 * This is NOT the scattered `|| isAdmin` the entitlement system exists to
 * avoid: `hasCapability` is the single function every client-side gate calls,
 * so this is the same centralisation applied on this side of the wire. There
 * is still exactly one admin check per side.
 *
 * `permissions.isAdmin` is preferred over `membership.isAdmin` as the signal
 * because permissions have been on the client user object since long before
 * memberships existed, so even a partial or stale user carries it.
 *
 * It grants nothing on its own. The API behind each panel enforces the same
 * rule server-side, so a hand-edited client gets an empty panel, not data.
 *
 * @param {object} [user] the redux account user
 * @param {string} capability
 * @returns {boolean}
 */
export function hasCapability(user, capability) {
    if (!user) {
        return false;
    }

    if (isAdminUser(user)) {
        return true;
    }

    return Array.isArray(user.capabilities) && user.capabilities.includes(capability);
}

/** Whether the account is an administrator, by either signal the server sends. */
export function isAdminUser(user) {
    return !!(user && (user.permissions?.isAdmin || user.membership?.isAdmin));
}

/**
 * The account's tier id, or 'free' for a logged-out or unknown user.
 *
 * An admin reads as the highest tier even when the server did not send a
 * membership block, so the badge cannot disagree with what they can actually
 * use.
 */
export function tierOf(user) {
    if (user && !user.membership && isAdminUser(user)) {
        return TIERS.VAULT_MASTER;
    }

    return (user && user.membership && user.membership.tier) || TIERS.FREE;
}

/** Display name of the account's tier, e.g. 'Archon'. */
export function tierNameOf(user) {
    if (user && !user.membership && isAdminUser(user)) {
        return 'Vault Master';
    }

    return (user && user.membership && user.membership.tierName) || 'Free';
}

/** Whether the account is on any paid (or comped/admin) tier. */
export function isPaidMember(user) {
    if (isAdminUser(user)) {
        return true;
    }

    return !!(user && user.membership && user.membership.rank > 0);
}

/**
 * Tailwind classes for a tier badge. Kept here so the badge looks the same
 * everywhere it appears - profile menu, profile page, lobby.
 */
export const TIER_BADGE_CLASS = Object.freeze({
    [TIERS.FREE]: 'bg-surface-secondary text-muted border-border',
    [TIERS.SUPPORTER]: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
    [TIERS.ARCHON]: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
    [TIERS.VAULT_MASTER]: 'bg-violet-500/15 text-violet-300 border-violet-500/40'
});
