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
    EARLY_ACCESS: 'early_access',

    // Vault Master
    EXPERIMENTAL_FEATURES: 'experimental_features',
    BETA_FEATURES: 'beta_features',
    ENHANCED_COSMETICS: 'enhanced_cosmetics',
    ORGANIZER_TOOLS: 'organizer_tools',
    PRIORITY_ACCESS: 'priority_access'
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
 * The admin override is NOT re-implemented here: an admin's `capabilities`
 * array already contains everything, because the server resolved it that way.
 * Adding `|| user.permissions.isAdmin` at call sites is exactly the scattered
 * special-casing the entitlement system exists to avoid, and it is the version
 * that eventually misses one.
 *
 * @param {object} [user] the redux account user
 * @param {string} capability
 * @returns {boolean}
 */
export function hasCapability(user, capability) {
    return !!(user && Array.isArray(user.capabilities) && user.capabilities.includes(capability));
}

/** The account's tier id, or 'free' for a logged-out or unknown user. */
export function tierOf(user) {
    return (user && user.membership && user.membership.tier) || TIERS.FREE;
}

/** Display name of the account's tier, e.g. 'Archon'. */
export function tierNameOf(user) {
    return (user && user.membership && user.membership.tierName) || 'Free';
}

/** Whether the account is on any paid (or comped/admin) tier. */
export function isPaidMember(user) {
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
