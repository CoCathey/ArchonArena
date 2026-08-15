/**
 * ARCHON (N12): the catalogue of premium capabilities.
 *
 * A capability is the unit features check - never a tier name. Code asks
 * "does this account have `archon_intelligence`?", not "is this account
 * Archon or above?". That indirection is the whole point: moving a feature
 * between tiers, running a promotion, or adding a tier is an edit to
 * `tiers.js` and nothing else, and no feature has to be found and rewritten.
 *
 * Each entry carries the copy the UI needs as well as the id, because a locked
 * premium feature is supposed to explain what the player would learn rather
 * than saying "Premium Required". Keeping that text here means the membership
 * page, the lock overlays and the upgrade prompts cannot drift apart.
 */

const CAPABILITIES = {
    // --- Supporter -----------------------------------------------------------
    ELO_HISTORY: 'elo_history',
    EXPANDED_MATCH_HISTORY: 'expanded_match_history',
    ADVANCED_PLAYER_STATS: 'advanced_player_stats',
    ADVANCED_DECK_STATS: 'advanced_deck_stats',
    PERFORMANCE_DASHBOARD: 'performance_dashboard',
    PROFILE_COSMETICS: 'profile_cosmetics',
    SUPPORTER_BADGE: 'supporter_badge',
    HISTORICAL_STATS: 'historical_stats',

    // --- Archon --------------------------------------------------------------
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

    // --- Vault Master --------------------------------------------------------
    EXPERIMENTAL_FEATURES: 'experimental_features',
    BETA_FEATURES: 'beta_features',
    ENHANCED_COSMETICS: 'enhanced_cosmetics',
    ORGANIZER_TOOLS: 'organizer_tools',
    PRIORITY_ACCESS: 'priority_access'
};

/**
 * Player-facing copy for every capability.
 *
 * `learn` is deliberately phrased as what the player finds out, not as what
 * the product does - it is the line shown on a locked panel, and "See which
 * houses beat you most often" earns an upgrade in a way "Matchup analytics"
 * does not.
 */
const CAPABILITY_CATALOG = {
    [CAPABILITIES.ELO_HISTORY]: {
        label: 'Full Elo history',
        learn: 'See every rating change you have ever had, not just your current number.',
        where: 'Archon Intelligence, and your profile'
    },
    [CAPABILITIES.EXPANDED_MATCH_HISTORY]: {
        label: 'Expanded match history',
        learn: 'Go back through your whole match record instead of only recent games.',
        where: 'Game History'
    },
    [CAPABILITIES.ADVANCED_PLAYER_STATS]: {
        label: 'Advanced player statistics',
        learn: 'See how you perform by house, by opponent and over time.',
        where: 'Stats, and any player profile'
    },
    [CAPABILITIES.ADVANCED_DECK_STATS]: {
        label: 'Advanced deck statistics',
        learn: 'See the real record, average keys and game length for each of your decks.',
        where: 'Stats → Your Decks'
    },
    [CAPABILITIES.PERFORMANCE_DASHBOARD]: {
        label: 'Performance dashboard',
        learn: 'One page that shows whether you are actually improving.',
        where: 'Archon Intelligence'
    },
    [CAPABILITIES.PROFILE_COSMETICS]: {
        label: 'Profile customisation',
        learn: 'Customise how your profile looks to other players.',
        where: 'Profile → Appearance'
    },
    [CAPABILITIES.SUPPORTER_BADGE]: {
        label: 'Supporter badge',
        learn: 'Show your support next to your name in the lobby and on your profile.',
        where: 'Shown next to your name automatically'
    },
    [CAPABILITIES.HISTORICAL_STATS]: {
        label: 'Additional historical statistics',
        learn: 'Look further back than the default window on every statistic.',
        where: 'Stats'
    },
    [CAPABILITIES.ARCHON_INTELLIGENCE]: {
        label: 'Archon Intelligence',
        learn: 'Is this deck good, are you good with it, and how does it fare against the current meta?',
        where: 'Archon+ → Archon Intelligence'
    },
    [CAPABILITIES.MATCHUP_ANALYTICS]: {
        label: 'Advanced matchup analytics',
        learn: 'See which opposing houses you beat and which ones consistently beat you.',
        where: 'Archon Intelligence → Your record by house'
    },
    [CAPABILITIES.DECK_COMPARISON]: {
        label: 'Deck comparison',
        learn: 'Put your decks side by side on record, Elo and matchups.',
        where: 'Archon+ → Tournament Lab'
    },
    [CAPABILITIES.PERSONAL_DECK_RANKINGS]: {
        label: 'Personal deck rankings',
        learn: 'Rank your own decks by how they actually perform for you.',
        where: 'Archon Intelligence → Deck Intelligence'
    },
    [CAPABILITIES.TOURNAMENT_LAB]: {
        label: 'Tournament Lab',
        learn: 'Work out which of your decks to bring to an event, from your own results.',
        where: 'Archon+ → Tournament Lab'
    },
    [CAPABILITIES.ADVANCED_REPLAYS]: {
        label: 'Advanced replay',
        learn: 'Walk a finished game turn by turn and find the point it was decided.',
        where: 'Any finished game → Replay'
    },
    [CAPABILITIES.PRIVATE_LEAGUES]: {
        label: 'Private groups and leagues',
        learn: 'Run an invite-only league for your playgroup.',
        where: 'Community → Clubs'
    },
    [CAPABILITIES.CUSTOM_TOURNAMENTS]: {
        label: 'Custom tournaments',
        learn: 'Run events with your own structure and rules.',
        where: 'Tournaments → Create'
    },
    [CAPABILITIES.ADVANCED_PERFORMANCE_DASHBOARD]: {
        label: 'Advanced performance dashboard',
        learn: 'Track your results against what your rating predicted, over time.',
        where: 'Archon Intelligence → Player Intelligence'
    },
    [CAPABILITIES.META_ANALYTICS]: {
        label: 'Meta analytics',
        learn: 'See what the field is actually playing and how it is performing.',
        where: 'Archon Intelligence → Meta Intelligence, and Stats'
    },
    [CAPABILITIES.EARLY_ACCESS]: {
        label: 'Early access',
        learn: 'Use major new features before they are released to everyone.',
        where: 'Announced in News as features land'
    },
    [CAPABILITIES.EXPERIMENTAL_FEATURES]: {
        label: 'Experimental features',
        learn: 'Try tools that are still being designed, and shape where they go.',
        where: 'Profile → Appearance, as they are released'
    },
    [CAPABILITIES.BETA_FEATURES]: {
        label: 'Beta features',
        learn: 'Get new competitive tools while they are still in testing.',
        where: 'Announced in News'
    },
    [CAPABILITIES.ENHANCED_COSMETICS]: {
        label: 'Enhanced cosmetics',
        learn: 'Additional profile and in-game customisation.',
        where: 'Profile → Appearance'
    },
    [CAPABILITIES.ORGANIZER_TOOLS]: {
        label: 'Organiser tools',
        learn: 'Extra capability for running events for other people.',
        where: 'Tournaments, when running an event'
    },
    [CAPABILITIES.PRIORITY_ACCESS]: {
        label: 'Priority access',
        learn: 'First access to new competitive tools as they land.',
        where: 'Announced in News'
    }
};

/** Every capability id, in catalogue order. */
const ALL_CAPABILITIES = Object.values(CAPABILITIES);

/**
 * Whether a string is a capability this build knows about.
 *
 * Used to fail loudly on a typo in a gate rather than silently denying access
 * to everyone - a mistyped capability is otherwise indistinguishable from a
 * capability nobody has.
 */
function isKnownCapability(capability) {
    return ALL_CAPABILITIES.includes(capability);
}

module.exports = {
    CAPABILITIES,
    CAPABILITY_CATALOG,
    ALL_CAPABILITIES,
    isKnownCapability
};
