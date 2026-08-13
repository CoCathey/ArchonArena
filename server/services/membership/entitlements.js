const { ALL_CAPABILITIES, isKnownCapability } = require('./capabilities');
const {
    TIER_IDS,
    HIGHEST_TIER,
    FREE_TIER,
    capabilitiesForTier,
    higherTier,
    tierById
} = require('./tiers');

/**
 * ARCHON (N12): the single authority on what an account may use.
 *
 * Everything - every route guard, every locked panel, every nav item - goes
 * through `resolveEntitlements`. Nothing anywhere else compares a tier name,
 * and nothing anywhere else special-cases an admin.
 *
 * ## The admin override
 *
 * There is exactly one admin check in this system and it is in this file. An
 * admin resolves to the highest tier with every capability this build knows
 * about, and `ALL_CAPABILITIES` is derived from the catalogue rather than
 * listed here, so a capability added next year is granted to admins the moment
 * it exists. No membership row, no Patreon link, and no amount of wrong data in
 * the Memberships table can take it away - the override is applied before any
 * of that is read, and returns immediately.
 *
 * That is deliberately blunt. The alternative - scattering `|| user.isAdmin`
 * through the UI - is the version that eventually misses one, and the way you
 * find out is an admin who cannot open the tool they are supposed to be
 * supporting someone through.
 *
 * ## Precedence for everyone else
 *
 * 1. Admin                    -> highest tier, everything (above)
 * 2. Manual grant             -> the granted tier, while it has not expired
 * 3. Provider (Patreon)       -> the synced tier, while the status is active
 * 4. Legacy `isSupporter` role-> Supporter, so accounts that predate this
 *                               system do not silently lose what they had
 * 5. Otherwise                -> free
 *
 * A manual grant and a provider membership are combined by taking the higher
 * of the two, not by letting one replace the other: comping an Archon month to
 * someone who already pays for Vault Master must not demote them.
 */

/** Membership statuses that count as paying right now. */
const ACTIVE_STATUSES = ['active', 'active_patron', 'complimentary', 'manual'];

/**
 * @typedef Entitlements
 * @property {string} tierId          the effective tier id
 * @property {string} tierName        its display name
 * @property {number} rank            its rank, for "is at least" comparisons
 * @property {string[]} capabilities  every capability the account may use
 * @property {boolean} isAdmin        whether the admin override applied
 * @property {string} source          'admin' | 'grant' | provider name | 'legacy-role' | 'none'
 * @property {boolean} complimentary  whether the effective tier was comped
 * @property {string|null} expiresAt  ISO date the entitlement lapses, if known
 */

/**
 * Whether a membership row is currently in force.
 *
 * Expiry is checked here rather than by a sweep job, so a lapsed membership
 * stops working the moment it lapses even if nothing has run since.
 */
function isCurrent(status, expiresAt, now) {
    if (status && !ACTIVE_STATUSES.includes(String(status).toLowerCase())) {
        return false;
    }

    if (!expiresAt) {
        return true;
    }

    const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);

    return !Number.isNaN(expiry.getTime()) && expiry.getTime() > now.getTime();
}

/**
 * Resolve what an account may use.
 *
 * Pure: it reads the user and the membership row it is given and returns a
 * value. It performs no IO, which is what lets the same function run on the
 * checkauth path, inside a route guard, and in a unit test.
 *
 * @param {object} params
 * @param {object} [params.user] the user, with `.permissions`
 * @param {object} [params.membership] the Memberships row, if any
 * @param {Date} [params.now] injected for tests
 * @returns {Entitlements}
 */
function resolveEntitlements({ user, membership, now = new Date() } = {}) {
    const permissions = (user && user.permissions) || {};

    // ---- THE ADMIN OVERRIDE -------------------------------------------------
    // First, unconditional, and derived from the catalogue rather than a list.
    // Nothing below this line can reduce it.
    if (permissions.isAdmin) {
        return {
            tierId: HIGHEST_TIER.id,
            tierName: HIGHEST_TIER.name,
            rank: HIGHEST_TIER.rank,
            capabilities: [...ALL_CAPABILITIES],
            isAdmin: true,
            source: 'admin',
            complimentary: false,
            expiresAt: null
        };
    }
    // -------------------------------------------------------------------------

    let tierId = TIER_IDS.FREE;
    let source = 'none';
    let complimentary = false;
    let expiresAt = null;

    // Manual/complimentary grant: an admin comping access, a beta tester, a
    // promotion. Deliberately independent of any provider.
    if (membership && membership.grantedTier) {
        if (isCurrent('manual', membership.grantedUntil, now)) {
            tierId = higherTier(tierId, membership.grantedTier);
            source = 'grant';
            complimentary = true;
            expiresAt = membership.grantedUntil || null;
        }
    }

    // Provider membership (Patreon today; the shape is provider-agnostic on
    // purpose so a second provider is a sync job, not a redesign).
    if (membership && membership.tier && membership.tier !== TIER_IDS.FREE) {
        if (isCurrent(membership.status, membership.expiresAt, now)) {
            const combined = higherTier(tierId, membership.tier);

            if (combined === membership.tier && combined !== tierId) {
                // The provider membership is the better of the two.
                source = membership.provider || 'provider';
                complimentary = false;
                expiresAt = membership.expiresAt || null;
            } else if (combined === tierId && source === 'none') {
                source = membership.provider || 'provider';
            }

            tierId = combined;
        }
    }

    // Accounts that predate this system: the inherited Patreon integration
    // granted a Supporter *role* rather than a membership row. Honouring it
    // means turning this on does not quietly downgrade existing supporters,
    // and `keepsSupporterWithNoPatreon` (admin-granted, for contributors and
    // lifetime supporters) keeps working exactly as it did.
    if (permissions.isSupporter || permissions.keepsSupporterWithNoPatreon) {
        const combined = higherTier(tierId, TIER_IDS.SUPPORTER);

        if (combined !== tierId) {
            tierId = combined;
            source = 'legacy-role';
            complimentary = !!permissions.keepsSupporterWithNoPatreon;
            expiresAt = null;
        }
    }

    const tier = tierById(tierId) || FREE_TIER;

    return {
        tierId: tier.id,
        tierName: tier.name,
        rank: tier.rank,
        capabilities: capabilitiesForTier(tier.id),
        isAdmin: false,
        source,
        complimentary,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null
    };
}

/**
 * Does this entitlement set include a capability?
 *
 * An unknown capability id throws in development rather than returning false.
 * A typo in a gate would otherwise be indistinguishable from a capability
 * nobody has - the feature would simply be locked for everybody, including
 * admins, and look like a product decision.
 *
 * @param {Entitlements|null} entitlements
 * @param {string} capability
 * @returns {boolean}
 */
function can(entitlements, capability) {
    if (!isKnownCapability(capability)) {
        if (process.env.NODE_ENV !== 'production') {
            throw new Error(
                `Unknown capability '${capability}'. Add it to server/services/membership/capabilities.js.`
            );
        }

        return false;
    }

    if (!entitlements || !Array.isArray(entitlements.capabilities)) {
        return false;
    }

    return entitlements.capabilities.includes(capability);
}

/** Entitlements for a logged-out visitor. */
function anonymousEntitlements() {
    return {
        tierId: FREE_TIER.id,
        tierName: FREE_TIER.name,
        rank: FREE_TIER.rank,
        capabilities: [],
        isAdmin: false,
        source: 'anonymous',
        complimentary: false,
        expiresAt: null
    };
}

module.exports = {
    resolveEntitlements,
    can,
    anonymousEntitlements,
    ACTIVE_STATUSES
};
