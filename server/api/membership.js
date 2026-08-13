const passport = require('passport');

const logger = require('../log.js');
const { wrapAsync } = require('../util.js');
const UserService = require('../services/UserService');
const ConfigService = require('../services/ConfigService');
const MembershipService = require('../services/membership/MembershipService');
const { tierCatalog, tierById, TIER_IDS } = require('../services/membership/tiers');
const { CAPABILITY_CATALOG } = require('../services/membership/capabilities');
const { entitlementsForRequest } = require('./requireCapability');

const configService = new ConfigService();
const userService = new UserService(configService);
const membershipService = new MembershipService();

/** Mirrors admin-settings.js - isAdmin only. */
const requireAdmin = (req, res, next) => {
    if (!req.user?.permissions?.isAdmin) {
        return res.status(403).send({ success: false, message: 'Forbidden' });
    }

    next();
};

/**
 * ARCHON (N12): membership status, the tier catalogue, and admin grants.
 *
 * GET  /api/membership/catalog        -> the price list (public)
 * GET  /api/membership/me             -> the caller's own entitlements
 * GET  /api/admin/memberships         -> who has what (admin)
 * POST /api/admin/memberships/grant   -> comp a tier to an account (admin)
 *
 * The catalogue is public because it is a price list - a logged-out visitor
 * has to be able to read the membership page before deciding to sign up.
 */
module.exports.init = function (server) {
    server.get(
        '/api/membership/catalog',
        wrapAsync(async (req, res) => {
            res.send({
                success: true,
                // Per-tier Patreon checkout links are built server-side, so the
                // reward ids stay in config and the client never assembles a
                // provider URL.
                tiers: tierCatalog(configService.getValue('patreon') || {}),
                // The copy for every capability, so locked panels and the
                // pricing page describe a feature the same way.
                capabilities: CAPABILITY_CATALOG
            });
        })
    );

    server.get(
        '/api/membership/me',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            const entitlements = entitlementsForRequest(req);
            const membership = entitlements.isAdmin
                ? null
                : await membershipService.getMembership(req.user.id);

            res.send({
                success: true,
                membership: {
                    tier: entitlements.tierId,
                    tierName: entitlements.tierName,
                    rank: entitlements.rank,
                    isAdmin: entitlements.isAdmin,
                    complimentary: entitlements.complimentary,
                    source: entitlements.source,
                    expiresAt: entitlements.expiresAt,
                    provider: membership ? membership.provider : null,
                    status: membership ? membership.status : null,
                    lastSyncedAt: membership ? membership.lastSyncedAt : null
                },
                capabilities: entitlements.capabilities
            });
        })
    );

    server.get(
        '/api/admin/memberships',
        passport.authenticate('jwt', { session: false }),
        requireAdmin,
        wrapAsync(async (req, res) => {
            res.send({ success: true, members: await membershipService.listMembers({}) });
        })
    );

    /**
     * Comp a tier to an account: contributors, beta testers, a promotion, or
     * putting something right for somebody.
     *
     * `tier: null` revokes the comp and leaves any paid membership alone -
     * which is why grants are stored in their own columns rather than
     * overwriting the provider's.
     */
    server.post(
        '/api/admin/memberships/grant',
        passport.authenticate('jwt', { session: false }),
        requireAdmin,
        wrapAsync(async (req, res) => {
            const { username, tier, until, reason } = req.body || {};

            if (!username) {
                return res.send({ success: false, message: 'A username is required' });
            }

            if (tier && tier !== TIER_IDS.FREE && !tierById(tier)) {
                return res.send({ success: false, message: `Unknown tier '${tier}'` });
            }

            const user = await userService.getUserByUsername(username);

            if (!user) {
                return res.send({ success: false, message: 'No such account' });
            }

            let expiry = null;
            if (until) {
                const parsed = new Date(until);

                if (Number.isNaN(parsed.getTime())) {
                    return res.send({ success: false, message: 'Could not read that date' });
                }

                expiry = parsed;
            }

            try {
                const membership = await membershipService.grantComplimentary(user.id, {
                    // 'free' and null both mean "no comp"; normalising here
                    // keeps the revoke path a single concept downstream.
                    tier: tier && tier !== TIER_IDS.FREE ? tier : null,
                    until: expiry,
                    grantedBy: req.user.id,
                    reason: reason || null
                });

                logger.info(
                    'Membership grant: %s -> %s by %s',
                    username,
                    tier || 'revoked',
                    req.user.username
                );

                return res.send({ success: true, membership });
            } catch (err) {
                return res.send({ success: false, message: err.message });
            }
        })
    );
};

module.exports.membershipService = membershipService;
