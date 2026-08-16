const { CAPABILITIES, ALL_CAPABILITIES, CAPABILITY_CATALOG } = require('./capabilities');

/**
 * ARCHON (N12): membership tiers, and the one place that says which tier
 * unlocks what.
 *
 * Tiers are cumulative by rank: a tier's effective capabilities are its own
 * plus every lower tier's, computed here rather than written out per tier, so
 * a capability can be moved between tiers by editing exactly one line and
 * cannot be accidentally granted to Archon but not Vault Master.
 *
 * `patreonTitles` maps Patreon's own tier names onto ours. It is matched
 * case-insensitively against the tier titles Patreon returns for a membership,
 * and `minAmountCents` is the fallback when a campaign's tier names do not
 * match - a pledge of the right size lands on the right tier even if the
 * creator renamed the tier on Patreon. Patreon tells us what someone pays;
 * this file decides what that buys.
 */

const TIER_IDS = {
    FREE: 'free',
    SUPPORTER: 'supporter',
    ARCHON: 'archon',
    VAULT_MASTER: 'vault_master'
};

/**
 * Ascending by rank. Rank is what comparisons use - never array position, and
 * never the id, so inserting a tier in the middle later is safe.
 */
const TIERS = [
    {
        id: TIER_IDS.FREE,
        rank: 0,
        name: 'Free',
        priceUsd: 0,
        tagline: 'Play all you like, forever.',
        blurb:
            'Everything you need to play Archon Arena competitively: unlimited games, deck ' +
            'import, matchmaking, leaderboards, tournaments and spectating.',
        // Deliberately empty. Everything free is simply not gated - there is no
        // capability for "can play a game", because nothing checks for one.
        capabilities: [],
        includes: [
            'Unlimited games',
            'Deck importing and registration',
            'Basic deck information',
            'Player profiles',
            'Win/loss record and Elo',
            'Global leaderboards',
            'Normal matchmaking',
            'Public groups and teams',
            'Public tournaments',
            'Spectating',
            'Basic game history'
        ],
        patreonTitles: [],
        minAmountCents: 0
    },
    {
        id: TIER_IDS.SUPPORTER,
        rank: 1,
        name: 'Supporter',
        priceUsd: 5,
        tagline: 'Keep the lights on, and see more of your own game.',
        blurb:
            'Your full rating history, deeper statistics on you and your decks, and a badge ' +
            'that says you help pay for the servers.',
        capabilities: [
            CAPABILITIES.ELO_HISTORY,
            CAPABILITIES.EXPANDED_MATCH_HISTORY,
            CAPABILITIES.ADVANCED_PLAYER_STATS,
            CAPABILITIES.ADVANCED_DECK_STATS,
            CAPABILITIES.PERFORMANCE_DASHBOARD,
            CAPABILITIES.PROFILE_COSMETICS,
            CAPABILITIES.SUPPORTER_BADGE,
            CAPABILITIES.HISTORICAL_STATS
        ],
        includes: [],
        patreonTitles: ['supporter', 'patron', 'friend'],
        minAmountCents: 500
    },
    {
        id: TIER_IDS.ARCHON,
        rank: 2,
        name: 'Archon',
        priceUsd: 10,
        recommended: true,
        tagline: 'Understand your decks, your play, and the field.',
        blurb:
            'Archon Intelligence, the Tournament Lab, matchup analytics and advanced replay - ' +
            'the tools for players who want to know why they win and lose, not just that they did.',
        capabilities: [
            CAPABILITIES.ARCHON_INTELLIGENCE,
            CAPABILITIES.MATCHUP_ANALYTICS,
            CAPABILITIES.DECK_COMPARISON,
            CAPABILITIES.PERSONAL_DECK_RANKINGS,
            CAPABILITIES.TOURNAMENT_LAB,
            CAPABILITIES.ADVANCED_REPLAYS,
            CAPABILITIES.PRIVATE_LEAGUES,
            CAPABILITIES.CUSTOM_TOURNAMENTS,
            CAPABILITIES.ADVANCED_PERFORMANCE_DASHBOARD,
            CAPABILITIES.META_ANALYTICS,
            CAPABILITIES.AERC_ANALYTICS,
            CAPABILITIES.EARLY_ACCESS
        ],
        includes: [],
        patreonTitles: ['archon'],
        minAmountCents: 1000
    },
    {
        id: TIER_IDS.VAULT_MASTER,
        rank: 3,
        name: 'Vault Master',
        priceUsd: 20,
        tagline: 'Everything, first.',
        blurb:
            'Experimental and beta tools as they are built, the deepest analytics we develop, ' +
            'and extra capability for people who run events.',
        capabilities: [
            CAPABILITIES.EXPERIMENTAL_FEATURES,
            CAPABILITIES.BETA_FEATURES,
            CAPABILITIES.ENHANCED_COSMETICS,
            CAPABILITIES.ORGANIZER_TOOLS,
            CAPABILITIES.PRIORITY_ACCESS
        ],
        includes: [],
        patreonTitles: ['vault master', 'vaultmaster', 'vault-master'],
        minAmountCents: 2000
    }
];

const TIERS_BY_ID = new Map(TIERS.map((tier) => [tier.id, tier]));

/** The highest-ranked tier. What an admin is treated as. */
const HIGHEST_TIER = TIERS.reduce((best, tier) => (tier.rank > best.rank ? tier : best), TIERS[0]);

const FREE_TIER = TIERS_BY_ID.get(TIER_IDS.FREE);

/**
 * A tier's capabilities including everything below it.
 *
 * Computed rather than declared so the tiers cannot disagree with each other:
 * there is no way to grant a capability to Archon and forget Vault Master.
 *
 * @param {string} tierId
 * @returns {string[]}
 */
function capabilitiesForTier(tierId) {
    const tier = TIERS_BY_ID.get(tierId);

    if (!tier) {
        return [];
    }

    const cumulative = TIERS.filter((candidate) => candidate.rank <= tier.rank).flatMap(
        (candidate) => candidate.capabilities
    );

    return [...new Set(cumulative)];
}

/** @returns {object|undefined} */
function tierById(tierId) {
    return TIERS_BY_ID.get(tierId);
}

/**
 * The higher of two tier ids. Unknown ids count as free rather than throwing:
 * a tier removed in a later release must not lock a paying member out while
 * their row still names it.
 */
function higherTier(a, b) {
    const left = TIERS_BY_ID.get(a) || FREE_TIER;
    const right = TIERS_BY_ID.get(b) || FREE_TIER;

    return left.rank >= right.rank ? left.id : right.id;
}

/**
 * Map a Patreon membership onto one of our tiers.
 *
 * Title match first (a creator naming their tiers after ours is the intended
 * setup), then pledge size as a fallback so a renamed Patreon tier still
 * resolves. Returns 'free' for anything that does not reach the lowest paid
 * tier - including an empty pledge - rather than guessing upward.
 *
 * @param {{tiers?: {title?: string}[], amountCents?: number|null}} membership
 * @returns {string} a tier id
 */
function tierFromPatreonMembership(membership) {
    const titles = ((membership && membership.tiers) || [])
        .map((tier) =>
            String((tier && tier.title) || '')
                .trim()
                .toLowerCase()
        )
        .filter(Boolean);

    // Highest matching title wins: Patreon can report more than one entitled
    // tier, and a member is owed the best of them.
    const byTitle = TIERS.filter((tier) =>
        tier.patreonTitles.some((candidate) => titles.includes(candidate))
    );

    if (byTitle.length) {
        return byTitle.reduce((best, tier) => (tier.rank > best.rank ? tier : best)).id;
    }

    const amount = Number((membership && membership.amountCents) || 0);

    if (!amount) {
        return TIER_IDS.FREE;
    }

    const byAmount = TIERS.filter(
        (tier) => tier.minAmountCents > 0 && amount >= tier.minAmountCents
    );

    return byAmount.length
        ? byAmount.reduce((best, tier) => (tier.rank > best.rank ? tier : best)).id
        : TIER_IDS.FREE;
}

/**
 * The tier list as the membership page renders it, with cumulative
 * capabilities resolved. Safe to send to an unauthenticated client - it is
 * a price list, not anybody's entitlements.
 */
/** Capabilities of a tier that actually work today (not flagged planned). */
function liveCapabilitiesForTier(tierId) {
    return capabilitiesForTier(tierId).filter(
        (capability) => !(CAPABILITY_CATALOG[capability] || {}).planned
    );
}

/**
 * ARCHON (N12): may this tier be sold right now?
 *
 * A paid tier is purchasable only if it delivers something, TODAY, that the
 * tier below it does not already include. Vault Master failed this the moment
 * it was audited: all five of its capabilities were unbuilt, so $20 a month
 * bought nothing whatsoever over Archon's $10.
 *
 * Deriving this rather than hand-maintaining a flag means a tier cannot be left
 * on sale by accident, and becomes purchasable automatically the day its first
 * feature ships.
 */
function isTierPurchasable(tier) {
    if (!tier.priceUsd) {
        return false;
    }

    const below = TIERS.filter((candidate) => candidate.rank < tier.rank).sort(
        (a, b) => b.rank - a.rank
    )[0];
    const inherited = new Set(below ? liveCapabilitiesForTier(below.id) : []);

    return liveCapabilitiesForTier(tier.id).some((capability) => !inherited.has(capability));
}

function tierCatalog(patreonConfig = {}) {
    return TIERS.map((tier) => ({
        id: tier.id,
        rank: tier.rank,
        name: tier.name,
        priceUsd: tier.priceUsd,
        tagline: tier.tagline,
        blurb: tier.blurb,
        recommended: !!tier.recommended,
        includes: tier.includes,
        // Only what this tier adds, for the "everything in X, plus" rendering.
        adds: tier.capabilities,
        capabilities: capabilitiesForTier(tier.id),
        // What works today, and whether there is enough of it to charge for.
        liveCapabilities: liveCapabilitiesForTier(tier.id),
        purchasable: isTierPurchasable(tier),
        checkoutUrl: isTierPurchasable(tier) ? checkoutUrlFor(tier, patreonConfig) : null
    }));
}

/**
 * The Patreon URL that starts a pledge at THIS tier.
 *
 * Patreon takes a per-tier checkout link of the form
 * `https://www.patreon.com/checkout/<page>?rid=<reward id>`. Without the `rid`
 * every button on the pricing page lands on the campaign homepage, and a player
 * who just clicked "Choose Archon" has to go and find Archon again - which is
 * exactly where people give up.
 *
 * The reward ids come from the creator dashboard (Membership -> Edit a tier;
 * the number at the end of that URL) and live in config rather than in this
 * file, so they can be filled in - or changed when a tier is recreated on
 * Patreon - without a redeploy.
 *
 * Falls back to the plain campaign page when an id is missing, which is the
 * old behaviour, and to null when there is no campaign at all so the UI can say
 * "coming soon" instead of rendering a dead button.
 *
 * @param {object} tier
 * @param {{campaignUrl?: string, pageName?: string, tierIds?: object}} config
 * @returns {string|null}
 */
function checkoutUrlFor(tier, config = {}) {
    if (!tier.priceUsd) {
        return null;
    }

    const campaignUrl = config.campaignUrl || null;
    const configured = config.tierIds && config.tierIds[tier.id];

    if (!configured) {
        return campaignUrl;
    }

    // A full URL is used exactly as given. Patreon has several link shapes for
    // a tier and they change over time; when an operator has a link that they
    // have actually clicked and seen work, composing a different one from its
    // id would be replacing something verified with something guessed.
    if (isHttpUrl(configured)) {
        return String(configured);
    }

    const pageName = config.pageName || pageNameFromCampaignUrl(campaignUrl);

    if (!pageName) {
        return campaignUrl;
    }

    return `https://www.patreon.com/checkout/${encodeURIComponent(
        pageName
    )}?rid=${encodeURIComponent(configured)}`;
}

/** Only http(s), so a config value cannot smuggle in a javascript: URL. */
function isHttpUrl(value) {
    try {
        const protocol = new URL(String(value)).protocol;

        return protocol === 'https:' || protocol === 'http:';
    } catch {
        return false;
    }
}

/**
 * The campaign's page name, taken from its public URL so an operator only has
 * to configure one of the two. `https://www.patreon.com/archonarena` ->
 * `archonarena`. Returns null for anything that is not a plain campaign URL,
 * rather than guessing at a path segment.
 */
function pageNameFromCampaignUrl(campaignUrl) {
    if (!campaignUrl) {
        return null;
    }

    let segments;

    try {
        segments = new URL(campaignUrl).pathname.split('/').filter(Boolean);
    } catch {
        return null;
    }

    // Patreon hands out several shapes for the same campaign:
    //   /archonarena              the classic vanity page
    //   /c/archonarena            the newer creator path
    //   /16554466/join            a share/join link, keyed by campaign id
    //   /archonarena/membership   a tab on the page
    // The identifier is the first segment once the /c/ prefix and any trailing
    // page section are removed.
    if (segments[0] === 'c') {
        segments = segments.slice(1);
    }

    const identifier = segments[0];

    // `/user?u=123` and `/checkout/...` are Patreon's own routes, not campaign
    // identifiers - deriving "user" from the first would build a checkout link
    // to somebody else entirely.
    const RESERVED = ['user', 'checkout', 'join', 'login', 'signup', 'home'];

    if (!identifier || RESERVED.includes(identifier)) {
        return null;
    }

    // Anything left after the identifier must be a known page section, not a
    // second identifier - better to derive nothing than to derive the wrong
    // thing and build a checkout link that 404s.
    const rest = segments.slice(1);
    const KNOWN_SECTIONS = ['join', 'membership', 'posts', 'about', 'shop'];

    if (rest.length && !rest.every((segment) => KNOWN_SECTIONS.includes(segment))) {
        return null;
    }

    return identifier;
}

module.exports = {
    TIER_IDS,
    TIERS,
    HIGHEST_TIER,
    FREE_TIER,
    ALL_CAPABILITIES,
    capabilitiesForTier,
    tierById,
    higherTier,
    tierFromPatreonMembership,
    tierCatalog,
    liveCapabilitiesForTier,
    isTierPurchasable,
    checkoutUrlFor,
    pageNameFromCampaignUrl
};
