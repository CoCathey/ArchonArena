const passport = require('passport');

const logger = require('../log.js');
const { wrapAsync } = require('../util.js');
const UserService = require('../services/UserService');
const ConfigService = require('../services/ConfigService');
const MembershipService = require('../services/membership/MembershipService');
const BadgeService = require('../services/membership/BadgeService');
const { patreonService } = require('./patreon');
const {
    tierCatalog,
    tierById,
    tierFromPatreonMembership,
    TIER_IDS
} = require('../services/membership/tiers');
const { CAPABILITY_CATALOG } = require('../services/membership/capabilities');
const { entitlementsForRequest } = require('./requireCapability');

const configService = new ConfigService();
const userService = new UserService(configService);
const membershipService = new MembershipService();
const badgeService = new BadgeService();

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
 * GET  /api/membership/badges         -> badges for a list of players (public)
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

    /**
     * ARCHON (N12): badges for a set of players, so any list of names can show
     * who supports the site.
     *
     * Public, and deliberately so: a badge whose whole purpose is that other
     * people see it cannot require the viewer to be signed in. It exposes the
     * tier NAME and nothing else - no expiry, no provider, no billing, and no
     * admin-override tier (see publicBadge for why that one matters).
     *
     * GET /api/membership/badges?usernames=alice,bob
     */
    server.get(
        '/api/membership/badges',
        wrapAsync(async (req, res) => {
            const usernames = String(req.query.usernames || '')
                .split(',')
                .map((name) => name.trim())
                .filter(Boolean);

            res.send({ success: true, badges: await badgeService.getBadges(usernames) });
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

    /**
     * ARCHON (N12): "does Patreon actually work?" in one call.
     *
     * Answering that used to mean reading three endpoints and inferring the
     * rest, and the interesting failures are all invisible from the outside: a
     * campaign id that never reached the container, a pledge Patreon reports
     * under a tier title we do not recognise, a stored row that disagrees with
     * what Patreon last said. This reports each stage of the chain separately
     * so the broken one is obvious rather than deduced.
     *
     * Admin-only, and it reports the SECRET as a boolean - the whole point is
     * to be safe to run on a live site and paste into a bug report.
     */
    server.get(
        '/api/admin/patreon/diagnostics',
        passport.authenticate('jwt', { session: false }),
        requireAdmin,
        wrapAsync(async (req, res) => {
            const config = configService.getValue('patreon') || {};
            const user = await userService.getFullUserByUsername(req.user.username);

            const configured = {
                enabled: !!config.enabled,
                // Booleans, never the values.
                hasClientId: !!config.clientId,
                hasClientSecret: !!config.clientSecret,
                callbackUrl: config.callbackUrl || null,
                campaignId: config.campaignId || null,
                campaignUrl: config.campaignUrl || null,
                // Without a campaign id, a pledge to ANY creator counts here.
                campaignScoped: !!config.campaignId,
                tierLinks: Object.fromEntries(
                    tierCatalog(config).map((tier) => [tier.id, tier.checkoutUrl])
                ),
                readyToLink: patreonService.isEnabled()
            };

            const account = {
                linked: !!(user && user.patreon && user.patreon.access_token),
                hasRefreshToken: !!(user && user.patreon && user.patreon.refresh_token)
            };

            // What Patreon says right now, and what we make of it. Only asked
            // when there is a token to ask with.
            let patreonSays = null;
            let mapsToTier = null;

            if (account.linked && patreonService.isEnabled()) {
                const membership = await patreonService.getMembershipForUser(user);

                patreonSays = {
                    status: membership.status,
                    tierTitles: (membership.tiers || []).map((tier) => tier.title),
                    amountCents: membership.amountCents,
                    lastChargeStatus: membership.lastChargeStatus
                };
                mapsToTier =
                    membership.status === 'pledged'
                        ? tierFromPatreonMembership(membership)
                        : TIER_IDS.FREE;
            }

            const stored = await membershipService.getMembership(req.user.id);
            const entitlements = entitlementsForRequest(req);

            res.send({
                success: true,
                configured,
                account,
                patreonSays,
                mapsToTier,
                stored: stored
                    ? {
                          provider: stored.provider,
                          tier: stored.tier,
                          status: stored.status,
                          expiresAt: stored.expiresAt,
                          lastSyncedAt: stored.lastSyncedAt,
                          grantedTier: stored.grantedTier,
                          grantedUntil: stored.grantedUntil
                      }
                    : null,
                effective: {
                    tier: entitlements.tierId,
                    source: entitlements.source,
                    isAdmin: entitlements.isAdmin,
                    capabilityCount: entitlements.capabilities.length
                }
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
