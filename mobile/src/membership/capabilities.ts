/**
 * ARCHON (N12): capability ids, mirrored from the web client.
 *
 * The duplication is limited to the *names*, exactly as it is in
 * client/membership.js: which tier grants what, and the admin override, live
 * only on the server and are never re-derived here. This file asks whether a
 * string is in the list the server resolved.
 *
 * That is what keeps the phone honest. A patched build can unhide a panel, but
 * every endpoint behind one carries `requireCapability` and refuses, so the
 * worst outcome is an empty panel rather than premium data on a device that did
 * not pay for it.
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

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

export const TIERS = Object.freeze({
    FREE: 'free',
    SUPPORTER: 'supporter',
    ARCHON: 'archon',
    VAULT_MASTER: 'vault_master'
});

/** Tier accent colours, matching the web badge palette. */
export const TIER_COLORS: Record<string, string> = {
    [TIERS.FREE]: '#647089',
    [TIERS.SUPPORTER]: '#34d399',
    [TIERS.ARCHON]: '#fbbf24',
    [TIERS.VAULT_MASTER]: '#a78bfa'
};
