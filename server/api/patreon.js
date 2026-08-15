const jwt = require('jsonwebtoken');
const passport = require('passport');

const logger = require('../log.js');
const { wrapAsync } = require('../util.js');
const ConfigService = require('../services/ConfigService');
const UserService = require('../services/UserService');
const PatreonService = require('../services/PatreonService');
const MembershipService = require('../services/membership/MembershipService');

const configService = new ConfigService();
const userService = new UserService(configService);
const patreonService = new PatreonService(configService, userService);
const membershipService = new MembershipService();

const STATE_COOKIE = 'aa_patreon_state';

/**
 * ARCHON (N12): where the web callback sends a phone-app link back to.
 *
 * Matches `expo.scheme` in mobile/app.json. Patreon only ever redirects to the
 * website, so the website is what forwards it to the app.
 */
const MOBILE_DEEP_LINK = 'archonarena://patreon';

/**
 * ARCHON (N12): Patreon account linking.
 *
 * GET  /api/account/patreon/status     -> is it configured, and where is the
 *                                         campaign page (public; drives whether
 *                                         the client renders any Patreon UI)
 * GET  /api/account/patreon/me         -> the caller's pledge status and tiers
 * POST /api/account/patreon/link/start -> the authorization URL to send the
 *                                         player to, plus a signed state cookie
 * POST /api/account/linkPatreon        -> exchange the returned code
 * POST /api/account/unlinkPatreon      -> forget the stored token
 *
 * The link/unlink paths keep their inherited names because the client and any
 * bookmarked flow already use them; everything new sits under /patreon/.
 *
 * **Why `state` exists.** The inherited flow sent the player to Patreon with no
 * state parameter and accepted any code posted back. That let a third party
 * hand a logged-in player a crafted link and attach *their* Patreon account to
 * the player's Archon Arena account - or, with a stolen code, attach the
 * player's Patreon to an account the attacker controls. The state is minted
 * server-side, stored in a short-lived signed httpOnly cookie pinned to the
 * requesting user id, and must come back intact. Same mechanism as the OIDC
 * flow in api/oidc.js, for the same reason.
 */
module.exports.init = function (server) {
    server.get(
        '/api/account/patreon/status',
        wrapAsync(async (req, res) => {
            const config = patreonService.getConfig();

            res.send({
                success: true,
                enabled: patreonService.isEnabled(),
                campaignUrl: config.campaignUrl || null
            });
        })
    );

    server.get(
        '/api/account/patreon/me',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!patreonService.isEnabled()) {
                return res.send({ success: true, status: 'none', tiers: [] });
            }

            const user = await userService.getFullUserByUsername(req.user.username);

            if (!user || !user.patreon || !user.patreon.access_token) {
                return res.send({ success: true, status: 'none', tiers: [] });
            }

            const membership = await patreonService.getMembershipForUser(user);

            res.send({ success: true, ...membership });
        })
    );

    server.post(
        '/api/account/patreon/link/start',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!patreonService.isEnabled()) {
                return res.send({ success: false, message: 'Patreon linking is not enabled' });
            }

            // ARCHON (N12): the phone app has no cookie jar. It authenticates
            // with a bearer token and completes the link from a fresh process
            // after a system browser hop, so the state has to travel with it.
            const mobile = !!req.body && req.body.mobile === true;
            const authRequest = patreonService.createAuthRequest({ mobile });

            const stateToken = jwt.sign(
                { state: authRequest.state, linkUserId: req.user.id },
                configService.getValue('secret'),
                { expiresIn: '10m' }
            );

            res.cookie(STATE_COOKIE, stateToken, {
                httpOnly: true,
                // Patreon returns the player by top-level GET navigation, which
                // lax allows; strict would drop the cookie and every link would
                // fail as an expired session.
                sameSite: 'lax',
                secure: req.secure || req.get('x-forwarded-proto') === 'https',
                maxAge: 10 * 60 * 1000
            });

            res.send({
                success: true,
                url: authRequest.url,
                // Returned only to the app. It is the same signed value the
                // cookie carries and gives away nothing extra: it is pinned to
                // this account, expires in ten minutes, and is verified against
                // the state Patreon echoes back. A browser client ignores it
                // and keeps using the cookie.
                stateToken: mobile ? stateToken : undefined,
                deepLink: mobile ? MOBILE_DEEP_LINK : undefined
            });
        })
    );

    server.post(
        '/api/account/linkPatreon',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!patreonService.isEnabled()) {
                return res.send({ success: false, message: 'Patreon linking is not enabled' });
            }

            if (!req.body.code) {
                return res.send({ success: false, message: 'Code is required' });
            }

            // Cookie first, body second. The website has a cookie; the phone
            // app does not and sends back the token it was handed. Both are the
            // same signed value and go through the same verification, so this
            // is a transport difference rather than a second trust path.
            const stateToken = (req.cookies && req.cookies[STATE_COOKIE]) || req.body.stateToken;

            // One shot: the state is consumed whether or not it checks out, so
            // a failed attempt cannot be replayed against the same cookie.
            res.clearCookie(STATE_COOKIE);

            if (
                !verifyLinkState({
                    stateToken: stateToken,
                    providedState: req.body.state,
                    userId: req.user.id,
                    secret: configService.getValue('secret')
                })
            ) {
                logger.warn(`Patreon link state rejected for user ${req.user.username}`);

                return res.send({
                    success: false,
                    message: 'Your Patreon link request expired.  Please try again.'
                });
            }

            const linked = await patreonService.linkAccount(req.user.username, req.body.code);
            if (!linked) {
                return res.send({
                    success: false,
                    message:
                        'An error occurred syncing your patreon account.  Please try again later.'
                });
            }

            // Reloaded rather than reusing what linkAccount returned: that one
            // comes from getUserByUsername, which does not populate roles, and
            // the supporter sync below has to see the current permissions to
            // honour the keepsSupporterWithNoPatreon exemption.
            const user = await userService.getFullUserByUsername(req.user.username);
            const membership = await patreonService.getMembershipForUser(user);

            await syncSupporterRole(user, membership.status === 'pledged');
            // ARCHON (N12): record the membership so the entitlement system can
            // resolve a tier from it. Patreon says what someone pays; tiers.js
            // decides what that buys - nothing downstream sees this response.
            await syncMembershipTier(user.id, membership);

            return res.send({ success: true, status: membership.status, tiers: membership.tiers });
        })
    );

    server.post(
        '/api/account/unlinkPatreon',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            const ret = await patreonService.unlinkAccount(req.user.username);
            if (!ret) {
                return res.send({
                    success: false,
                    message:
                        'An error occurred unlinking your patreon account.  Please try again later.'
                });
            }

            // Unlinking is the player withdrawing the pledge's proof, so the
            // role goes with it immediately rather than at the next checkauth.
            const user = await userService.getFullUserByUsername(req.user.username);
            if (user) {
                await syncSupporterRole(user, false);
                // Unlinking withdraws the proof of the pledge, so the tier goes
                // with it. A manual comp is stored in different columns and is
                // deliberately left alone.
                await syncMembershipTier(user.id, { status: 'none' });
            }

            return res.send({ success: true });
        })
    );
};

/**
 * Does the state Patreon echoed back match the one we minted for this user?
 *
 * Everything has to line up: a cookie must be present, the request must carry
 * a state, the cookie's signature and expiry must hold, the two states must be
 * equal, and the cookie must belong to the account making the request. The last
 * check is what stops a code obtained under one account being redeemed under
 * another.
 *
 * @param {object} params
 * @param {string} [params.stateToken]    signed cookie value
 * @param {string} [params.providedState] state Patreon sent back
 * @param {number} params.userId          the authenticated user
 * @param {string} params.secret          JWT signing secret
 * @returns {boolean}
 */
function verifyLinkState({ stateToken, providedState, userId, secret }) {
    if (!stateToken || !providedState) {
        return false;
    }

    let transient;
    try {
        transient = jwt.verify(stateToken, secret);
    } catch (err) {
        return false;
    }

    return transient.state === providedState && transient.linkUserId === userId;
}

/**
 * Grant or revoke the Supporter role to match the pledge.
 *
 * Best-effort: a failure here must not fail the link itself - the account is
 * already linked at this point, and the next `checkauth` reconciles the role
 * anyway. `keepsSupporterWithNoPatreon` is an admin-granted exemption (site
 * contributors, lifetime supporters) and always wins.
 *
 * `setSupporterStatus` reads the current role first and no-ops when it already
 * matches, so this does not need to compare before calling.
 */
/**
 * ARCHON (N12): mirror a Patreon membership into the Memberships table.
 *
 * Best-effort by design. A failure here must not fail the link the player just
 * completed - the account is linked either way, the legacy Supporter role has
 * already been reconciled above, and the next checkauth re-syncs. Losing the
 * tier for a few minutes is recoverable; a link that reports failure after
 * succeeding is confusing and sends people to support.
 */
async function syncMembershipTier(userId, patreonMembership, service = membershipService) {
    try {
        return await service.syncFromPatreon(userId, patreonMembership);
    } catch (err) {
        logger.error('Failed to sync membership tier for user %s: %s', userId, err.message);

        return null;
    }
}

async function syncSupporterRole(user, isSupporter, users = userService) {
    const permissions = user.permissions || {};

    if (permissions.keepsSupporterWithNoPatreon) {
        return;
    }

    try {
        await users.setSupporterStatus(user.id, isSupporter);
        permissions.isSupporter = isSupporter;
    } catch (err) {
        logger.error('Failed to sync supporter role for %s: %s', user.username, err.message);
    }
}

module.exports.patreonService = patreonService;
module.exports.STATE_COOKIE = STATE_COOKIE;
// Exported for tests: the two decisions in this file worth pinning down.
module.exports.verifyLinkState = verifyLinkState;
module.exports.syncSupporterRole = syncSupporterRole;
module.exports.syncMembershipTier = syncMembershipTier;
