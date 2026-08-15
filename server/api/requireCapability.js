const { resolveEntitlements } = require('../services/membership/entitlements');
const { can } = require('../services/membership/entitlements');
const { isKnownCapability } = require('../services/membership/capabilities');

/**
 * ARCHON (N12): Express guard for a premium endpoint.
 *
 * The client hides and locks premium UI; this is what actually enforces it. A
 * locked panel is a courtesy, not a control - anyone can call the API directly
 * - so every premium endpoint carries this and no premium data is computed for
 * an account that may not see it.
 *
 * Reads entitlements straight off `req.user`, which passport populated from the
 * JWT, which was minted from `getWireSafeDetails()`, which resolved them
 * through the one authority. That means the admin override applies here without
 * this file knowing anything about admins.
 *
 * Use after an authentication middleware:
 *
 *   server.get('/api/thing',
 *       passport.authenticate('jwt', { session: false }),
 *       requireCapability(CAPABILITIES.ARCHON_INTELLIGENCE),
 *       wrapAsync(handler));
 *
 * @param {string} capability
 */
function requireCapability(capability) {
    // Thrown at wiring time, not request time: a mistyped capability would
    // otherwise turn into a 403 for every user including admins, which reads
    // like a deliberate paywall rather than a typo.
    if (!isKnownCapability(capability)) {
        throw new Error(
            `requireCapability called with unknown capability '${capability}'. ` +
                'Add it to server/services/membership/capabilities.js.'
        );
    }

    return function (req, res, next) {
        if (!req.user) {
            return res.status(401).send({ success: false, message: 'Unauthorized' });
        }

        // A floor under the resolved entitlements. `entitlementsForRequest`
        // already returns everything for an admin - via the token's capability
        // list, or by re-resolving from permissions - but an admin being
        // refused a premium endpoint is the one outcome this system must never
        // produce, and the cost of checking twice is a property read.
        if (req.user.permissions && req.user.permissions.isAdmin) {
            return next();
        }

        if (!can(entitlementsForRequest(req), capability)) {
            // 403 with the capability named, so the client can show the right
            // upgrade prompt rather than a generic error.
            return res.status(403).send({
                success: false,
                message: 'This feature is part of Archon Arena membership.',
                capability: capability,
                upgradeRequired: true
            });
        }

        return next();
    };
}

/**
 * Entitlements for the authenticated user on a request.
 *
 * Prefers what the JWT already carries (minted by getWireSafeDetails) and falls
 * back to re-resolving from permissions. The fallback matters for tokens minted
 * before this feature shipped: they have `permissions` but no `capabilities`,
 * and without it every existing session would be treated as free until it
 * refreshed - including an admin's.
 *
 * @param {object} req
 * @returns {import('../services/membership/entitlements').Entitlements|null}
 */
function entitlementsForRequest(req) {
    const user = req && req.user;

    if (!user) {
        return null;
    }

    if (Array.isArray(user.capabilities) && user.membership) {
        return {
            tierId: user.membership.tier,
            tierName: user.membership.tierName,
            rank: user.membership.rank,
            capabilities: user.capabilities,
            isAdmin: !!user.membership.isAdmin,
            source: user.membership.source,
            complimentary: !!user.membership.complimentary,
            expiresAt: user.membership.expiresAt || null
        };
    }

    // Older token: resolve from what it does carry. An admin still gets
    // everything, because that is decided by permissions.isAdmin.
    return resolveEntitlements({ user });
}

module.exports = { requireCapability, entitlementsForRequest };
