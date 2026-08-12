const { can } = require('../services/membership/entitlements');
const { CAPABILITIES } = require('../services/membership/capabilities');
const { entitlementsForRequest } = require('./requireCapability');

/**
 * ARCHON (N12): premium filtering for the /api/stats/* payloads.
 *
 * These three routes are, and must remain, UNAUTHENTICATED. They serve the
 * public player profile, which a logged-out visitor has to be able to read -
 * putting `passport.authenticate` in front of them would 401 every anonymous
 * viewer of /players/:username, which is a regression dressed as a paywall.
 *
 * So instead of gating the ROUTE, this gates the PAYLOAD. The free shape (the
 * overall record, the Elo number, the deck list) always goes out; the expensive
 * analytical extras are stripped for a caller who has not paid for them. That
 * also means the free tier's promise - "win/loss record and Elo", "player
 * profiles", "basic deck information" - is expressed as fields that are never
 * removed, rather than as a capability nobody checks.
 *
 * `optionalUser` populates req.user when a token happens to be present without
 * requiring one, so a signed-in Archon member browsing the same public page
 * sees their extras.
 */

/** Fields on /api/stats/player that are premium. */
const PLAYER_PREMIUM = {
    // Win rate by format and by house: "advanced player statistics".
    formats: CAPABILITIES.ADVANCED_PLAYER_STATS,
    houses: CAPABILITIES.ADVANCED_PLAYER_STATS
};

/** Fields on /api/stats/meta that are premium. */
const META_PREMIUM = {
    // The house-vs-house matrix is both the most valuable meta read and the
    // single most expensive query in StatisticsService, so gating it is a cost
    // win as well as a product one.
    houseMatchups: CAPABILITIES.META_ANALYTICS,
    sasBands: CAPABILITIES.META_ANALYTICS,
    sets: CAPABILITIES.META_ANALYTICS
};

/** Fields on /api/stats/decks that are premium. */
const DECK_PREMIUM = {
    matchups: CAPABILITIES.MATCHUP_ANALYTICS,
    bestMatchup: CAPABILITIES.MATCHUP_ANALYTICS,
    worstMatchup: CAPABILITIES.MATCHUP_ANALYTICS,
    bestDeck: CAPABILITIES.PERSONAL_DECK_RANKINGS,
    worstDeck: CAPABILITIES.PERSONAL_DECK_RANKINGS
};

/** Per-deck row keys that are premium (the expected-win-rate columns). */
const DECK_ROW_PREMIUM = {
    expectedWinRate: CAPABILITIES.ADVANCED_DECK_STATS,
    sasDelta: CAPABILITIES.ADVANCED_DECK_STATS
};

/**
 * Strip premium keys the caller may not have, and report which were removed.
 *
 * The removed list is returned to the client as `locked` so the UI can render
 * the right upgrade prompt in the right place - the difference between a panel
 * that is missing and a panel that says what it would tell you.
 *
 * @param {object} stats
 * @param {object} fieldMap key -> capability
 * @param {object|null} entitlements
 * @returns {{stats: object, locked: string[]}}
 */
function filterFields(stats, fieldMap, entitlements) {
    if (!stats) {
        return { stats, locked: [] };
    }

    const out = { ...stats };
    const locked = [];

    for (const [field, capability] of Object.entries(fieldMap)) {
        if (out[field] === undefined) {
            continue;
        }

        if (!can(entitlements, capability)) {
            delete out[field];
            locked.push(field);
        }
    }

    return { stats: out, locked };
}

/**
 * The full premium filter for a deck-stats payload, including the per-row
 * columns.
 */
function filterDeckStats(stats, entitlements) {
    const { stats: filtered, locked } = filterFields(stats, DECK_PREMIUM, entitlements);

    if (Array.isArray(filtered.decks)) {
        const rowLocked = [];

        filtered.decks = filtered.decks.map((deck) => {
            const row = { ...deck };

            for (const [field, capability] of Object.entries(DECK_ROW_PREMIUM)) {
                if (row[field] !== undefined && !can(entitlements, capability)) {
                    delete row[field];

                    if (!rowLocked.includes(field)) {
                        rowLocked.push(field);
                    }
                }
            }

            return row;
        });

        locked.push(...rowLocked);
    }

    return { stats: filtered, locked };
}

/**
 * Populate req.user from a bearer token if one is present, without requiring
 * one. passport's `jwt` strategy is not used here because its failure mode is a
 * 401, and the whole point is that no token is a valid state.
 */
function optionalUser(passport) {
    return function (req, res, next) {
        if (!req.headers || !req.headers.authorization) {
            return next();
        }

        passport.authenticate('jwt', { session: false }, (err, user) => {
            if (user) {
                req.user = user;
            }

            next();
        })(req, res, next);
    };
}

module.exports = {
    filterFields,
    filterDeckStats,
    optionalUser,
    entitlementsForRequest,
    PLAYER_PREMIUM,
    META_PREMIUM,
    DECK_PREMIUM,
    DECK_ROW_PREMIUM
};
