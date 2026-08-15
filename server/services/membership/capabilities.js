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
 *
 * `planned: true` marks a capability that is NOT built yet. An audit of every
 * tier promise against the code found thirteen of them, including all five of
 * Vault Master's - so the pricing page was advertising, and the tiers were
 * selling, features that did not exist. Rather than quietly deleting them (the
 * roadmap is real and worth showing) they are marked, and the UI must render
 * them as planned rather than as included: no tick in the comparison grid, and
 * counted separately on the tier card.
 *
 * Remove the flag when the feature ships AND something gates on the capability.
 * A capability with no gate and no `planned` flag is a promise nobody is
 * keeping.
 */
const CAPABILITY_CATALOG = {
    [CAPABILITIES.ELO_HISTORY]: {
        label: 'Elo history',
        // Was "Full Elo history ... every rating change you have ever had".
        // playerRatingHistory is called with limit 500 and hard-caps at 2000, so
        // "every ... ever" is not what is served; and the profile does not show
        // rating history at all, only Archon Intelligence does.
        learn: 'See how your rating moved game by game, not just your current number.',
        where: 'Archon Intelligence'
    },
    [CAPABILITIES.EXPANDED_MATCH_HISTORY]: {
        label: 'Expanded match history',
        learn: 'Go back through your whole match record instead of only recent games.',
        where: 'Game History',
        planned: true
    },
    [CAPABILITIES.ADVANCED_PLAYER_STATS]: {
        label: 'Advanced player statistics',
        // Was "by house, by opponent and over time". Only the house and format
        // breakdowns exist (StatisticsService.getPlayerStats); per-opponent and
        // over-time were never built, and this is a live paid promise, so the
        // copy is corrected rather than the gap excused.
        learn: 'See your win rate broken down by house and by game format.',
        where: 'Stats, and any player profile'
    },
    [CAPABILITIES.ADVANCED_DECK_STATS]: {
        label: 'Advanced deck statistics',
        // Was "the real record, average keys and game length". None of those
        // three are what this gate protects - it protects the expected-win-rate
        // and SAS-delta columns (statsGating DECK_ROW_PREMIUM). Record, keys and
        // game length come with Archon Intelligence, one tier up.
        learn: 'See how each of your decks performs against what its SAS predicts.',
        where: 'Stats → Your Decks'
    },
    [CAPABILITIES.PERFORMANCE_DASHBOARD]: {
        label: 'Performance dashboard',
        // Was "whether you are actually improving", which promises a trend.
        // playerVsExpectation is called with no `sinceDays`, so there is no date
        // filter and no time axis - it is one lifetime figure. The trend version
        // is ADVANCED_PERFORMANCE_DASHBOARD below, and it is still planned.
        learn: 'See whether you are beating what your rating predicted, across your whole record.',
        where: 'Archon Intelligence'
    },
    [CAPABILITIES.PROFILE_COSMETICS]: {
        label: 'Profile customisation',
        // Planned. Worded as intent, not as a claim about today - the only
        // customisation that exists is the board background, which is free.
        learn: 'Customise how your profile looks.',
        where: 'Profile → Appearance',
        planned: true
    },
    [CAPABILITIES.SUPPORTER_BADGE]: {
        label: 'Supporter badge',
        learn: 'Show your support next to your name in the lobby and on your profile.',
        where: 'Shown next to your name automatically'
    },
    [CAPABILITIES.HISTORICAL_STATS]: {
        label: 'Additional historical statistics',
        learn: 'Look further back than the default window on every statistic.',
        where: 'Stats',
        planned: true
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
        label: 'Replay analysis',
        // The line here has to keep saying what is NOT sold, because the
        // obvious reading of "advanced replays" is the replay viewer, and that
        // is free for everyone. What membership buys is the reading of a game
        // rather than the watching of it - and above all the house-by-house
        // record, which exists in no other table on the site.
        learn:
            'Which house you call each turn and how you do when you call it, your amber per ' +
            'turn, and the turn each game stopped changing hands. Watching replays is free ' +
            'for everyone.',
        where: 'Any finished game → Replay, and Archon Intelligence → Replay Intelligence'
    },
    [CAPABILITIES.PRIVATE_LEAGUES]: {
        label: 'League play for your club',
        // Was "run an invite-only group for your playgroup" - clubs already do
        // that for free, join codes and all (ClubService). What no club has is
        // league play: seasons, fixtures, standings. That is the unbuilt part,
        // so that is what this describes.
        learn: 'Seasons and standings inside a club. Clubs themselves are free for everyone.',
        where: 'Community → Clubs',
        planned: true
    },
    [CAPABILITIES.CUSTOM_TOURNAMENTS]: {
        label: 'Extended tournament options',
        // Was "run events with your own structure and rules", which TournamentService.create
        // already lets any free account do across ~42 configurable fields -
        // format, rounds, cut, seeding, SAS bands, teams, pacing, prizes. Anyone
        // can run a custom event; this is only ever additions on top of that.
        learn: 'Extra options on top of tournament creation, which is free for everyone.',
        where: 'Tournaments → Create',
        planned: true
    },
    [CAPABILITIES.ADVANCED_PERFORMANCE_DASHBOARD]: {
        label: 'Advanced performance dashboard',
        // The difference from Supporter's PERFORMANCE_DASHBOARD is the time
        // axis, so say so - otherwise the two read as the same thing sold twice.
        learn: 'Break that same comparison down over time, so you can see the trend.',
        where: 'Archon Intelligence → Player Intelligence',
        planned: true
    },
    [CAPABILITIES.META_ANALYTICS]: {
        label: 'Meta analytics',
        learn: 'See what the field is actually playing and how it is performing.',
        where: 'Archon Intelligence → Meta Intelligence, and Stats'
    },
    [CAPABILITIES.EARLY_ACCESS]: {
        label: 'Early access',
        learn: 'Use major new features before they are released to everyone.',
        where: 'Announced in News as features land',
        planned: true
    },
    [CAPABILITIES.EXPERIMENTAL_FEATURES]: {
        label: 'Experimental features',
        learn: 'Try tools that are still being designed, and shape where they go.',
        where: 'Profile → Appearance, as they are released',
        planned: true
    },
    [CAPABILITIES.BETA_FEATURES]: {
        label: 'Beta features',
        learn: 'Get new competitive tools while they are still in testing.',
        where: 'Announced in News',
        planned: true
    },
    [CAPABILITIES.ENHANCED_COSMETICS]: {
        label: 'Enhanced cosmetics',
        learn: 'Additional profile and in-game customisation.',
        where: 'Profile → Appearance',
        planned: true
    },
    [CAPABILITIES.ORGANIZER_TOOLS]: {
        label: 'Organiser tools',
        learn: 'Extra capability for running events for other people.',
        where: 'Tournaments, when running an event',
        planned: true
    },
    [CAPABILITIES.PRIORITY_ACCESS]: {
        label: 'Priority access',
        learn: 'First access to new competitive tools as they land.',
        where: 'Announced in News',
        planned: true
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
