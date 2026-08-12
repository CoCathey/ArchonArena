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
        learn: 'See every rating change you have ever had, not just your current number.'
    },
    [CAPABILITIES.EXPANDED_MATCH_HISTORY]: {
        label: 'Expanded match history',
        learn: 'Go back through your whole match record instead of only recent games.'
    },
    [CAPABILITIES.ADVANCED_PLAYER_STATS]: {
        label: 'Advanced player statistics',
        learn: 'See how you perform by house, by opponent and over time.'
    },
    [CAPABILITIES.ADVANCED_DECK_STATS]: {
        label: 'Advanced deck statistics',
        learn: 'See the real record, average keys and game length for each of your decks.'
    },
    [CAPABILITIES.PERFORMANCE_DASHBOARD]: {
        label: 'Performance dashboard',
        learn: 'One page that shows whether you are actually improving.'
    },
    [CAPABILITIES.PROFILE_COSMETICS]: {
        label: 'Profile customisation',
        learn: 'Customise how your profile looks to other players.'
    },
    [CAPABILITIES.SUPPORTER_BADGE]: {
        label: 'Supporter badge',
        learn: 'Show your support next to your name in the lobby and on your profile.'
    },
    [CAPABILITIES.HISTORICAL_STATS]: {
        label: 'Additional historical statistics',
        learn: 'Look further back than the default window on every statistic.'
    },
    [CAPABILITIES.ARCHON_INTELLIGENCE]: {
        label: 'Archon Intelligence',
        learn: 'Is this deck good, are you good with it, and how does it fare against the current meta?'
    },
    [CAPABILITIES.MATCHUP_ANALYTICS]: {
        label: 'Advanced matchup analytics',
        learn: 'See which opposing houses you beat and which ones consistently beat you.'
    },
    [CAPABILITIES.DECK_COMPARISON]: {
        label: 'Deck comparison',
        learn: 'Put your decks side by side on record, Elo and matchups.'
    },
    [CAPABILITIES.PERSONAL_DECK_RANKINGS]: {
        label: 'Personal deck rankings',
        learn: 'Rank your own decks by how they actually perform for you.'
    },
    [CAPABILITIES.TOURNAMENT_LAB]: {
        label: 'Tournament Lab',
        learn: 'Work out which of your decks to bring to an event, from your own results.'
    },
    [CAPABILITIES.ADVANCED_REPLAYS]: {
        label: 'Advanced replay',
        learn: 'Walk a finished game turn by turn and find the point it was decided.'
    },
    [CAPABILITIES.PRIVATE_LEAGUES]: {
        label: 'Private groups and leagues',
        learn: 'Run an invite-only league for your playgroup.'
    },
    [CAPABILITIES.CUSTOM_TOURNAMENTS]: {
        label: 'Custom tournaments',
        learn: 'Run events with your own structure and rules.'
    },
    [CAPABILITIES.ADVANCED_PERFORMANCE_DASHBOARD]: {
        label: 'Advanced performance dashboard',
        learn: 'Track your results against what your rating predicted, over time.'
    },
    [CAPABILITIES.META_ANALYTICS]: {
        label: 'Meta analytics',
        learn: 'See what the field is actually playing and how it is performing.'
    },
    [CAPABILITIES.EARLY_ACCESS]: {
        label: 'Early access',
        learn: 'Use major new features before they are released to everyone.'
    },
    [CAPABILITIES.EXPERIMENTAL_FEATURES]: {
        label: 'Experimental features',
        learn: 'Try tools that are still being designed, and shape where they go.'
    },
    [CAPABILITIES.BETA_FEATURES]: {
        label: 'Beta features',
        learn: 'Get new competitive tools while they are still in testing.'
    },
    [CAPABILITIES.ENHANCED_COSMETICS]: {
        label: 'Enhanced cosmetics',
        learn: 'Additional profile and in-game customisation.'
    },
    [CAPABILITIES.ORGANIZER_TOOLS]: {
        label: 'Organiser tools',
        learn: 'Extra capability for running events for other people.'
    },
    [CAPABILITIES.PRIORITY_ACCESS]: {
        label: 'Priority access',
        learn: 'First access to new competitive tools as they land.'
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
