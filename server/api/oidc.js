const jwt = require('jsonwebtoken');
const passport = require('passport');

const logger = require('../log.js');
const { wrapAsync } = require('../util.js');
const ConfigService = require('../services/ConfigService');
const UserService = require('../services/UserService');
const OidcService = require('../services/auth/OidcService');
const BanlistService = require('../services/BanlistService');

const configService = new ConfigService();
const userService = new UserService(configService);
const banlistService = new BanlistService(null, configService);
// Pass the banlist so SSO account creation refuses banned IPs (ban evasion).
const oidcService = new OidcService(
    configService,
    userService,
    undefined,
    undefined,
    banlistService
);

const STATE_COOKIE = 'aa_oidc_state';

/**
 * Browser-redirect endpoints for OpenID Connect login (Keybringer).
 *
 * GET /api/account/oidc/login     -> redirect to the provider
 * GET /api/account/oidc/callback  -> exchange code, mint the same JWT +
 *                                    refresh token as password login, then
 *                                    redirect to /login#sso=<payload> where
 *                                    the SPA stores the tokens. The payload
 *                                    travels in the URL fragment so it never
 *                                    appears in server logs.
 *
 * Transient state (state/nonce/PKCE verifier) crosses the redirect in a
 * short-lived signed httpOnly cookie, so the flow works across lobby
 * instances with no server-side session store.
 */
module.exports.init = function (server) {
    server.get(
        '/api/account/oidc/status',
        wrapAsync(async (req, res) => {
            const config = oidcService.getConfig();

            res.send({
                success: true,
                enabled: oidcService.isEnabled(),
                providerName: config.providerDisplayName || 'Keybringer'
            });
        })
    );

    server.get(
        '/api/account/oidc/identities',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            const identities = await oidcService.getIdentitiesForUser(req.user.id);

            res.send({ success: true, identities: identities });
        })
    );

    server.post(
        '/api/account/oidc/unlink',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!req.body.provider) {
                return res.send({ success: false, message: 'provider must be specified' });
            }

            const fullUser = await userService.getFullUserByUsername(req.user.username);
            const hasUsablePassword = !!(fullUser && fullUser.password);

            const result = await oidcService.unlinkIdentity(
                req.user.id,
                req.body.provider,
                hasUsablePassword
            );

            res.send(result);
        })
    );

    // Settings "Link Account": an authenticated XHR asks for the provider
    // authorization URL; the signed state cookie additionally carries the
    // requesting user's id so the callback links instead of logging in.
    server.post(
        '/api/account/oidc/link/start',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!oidcService.isEnabled()) {
                return res.send({ success: false, message: 'SSO is not enabled' });
            }

            let authRequest;
            try {
                authRequest = await oidcService.createAuthRequest();
            } catch (err) {
                logger.error('OIDC discovery/auth request failed', err);

                return res.send({ success: false, message: 'SSO provider is unavailable' });
            }

            const stateToken = jwt.sign(
                {
                    state: authRequest.state,
                    nonce: authRequest.nonce,
                    verifier: authRequest.codeVerifier,
                    linkUserId: req.user.id
                },
                configService.getValue('secret'),
                { expiresIn: '10m' }
            );

            res.cookie(STATE_COOKIE, stateToken, {
                httpOnly: true,
                sameSite: 'lax',
                secure: req.secure || req.get('x-forwarded-proto') === 'https',
                maxAge: 10 * 60 * 1000
            });

            res.send({ success: true, url: authRequest.url });
        })
    );

    server.get(
        '/api/account/oidc/login',
        wrapAsync(async (req, res) => {
            if (!oidcService.isEnabled()) {
                return res.redirect('/login#ssoError=SSO login is not enabled');
            }

            let authRequest;
            try {
                authRequest = await oidcService.createAuthRequest();
            } catch (err) {
                logger.error('OIDC discovery/auth request failed', err);

                return res.redirect('/login#ssoError=SSO provider is unavailable');
            }

            const stateToken = jwt.sign(
                {
                    state: authRequest.state,
                    nonce: authRequest.nonce,
                    verifier: authRequest.codeVerifier
                },
                configService.getValue('secret'),
                { expiresIn: '10m' }
            );

            res.cookie(STATE_COOKIE, stateToken, {
                httpOnly: true,
                sameSite: 'lax',
                secure: req.secure || req.get('x-forwarded-proto') === 'https',
                maxAge: 10 * 60 * 1000
            });

            res.redirect(authRequest.url);
        })
    );

    server.get(
        '/api/account/oidc/callback',
        wrapAsync(async (req, res) => {
            // Link-mode callbacks (started from account settings while
            // logged in) land back on the profile page; login callbacks on
            // the login page. Detected from the signed state cookie.
            let isLinkFlow = false;
            const fail = (message) => {
                res.clearCookie(STATE_COOKIE);
                const target = isLinkFlow ? '/profile' : '/login';
                res.redirect(`${target}#ssoError=${encodeURIComponent(message)}`);
            };

            if (!oidcService.isEnabled()) {
                return fail('SSO login is not enabled');
            }

            if (req.query.error) {
                logger.warn(`OIDC provider returned error: ${req.query.error}`);

                return fail('Sign in was cancelled or refused');
            }

            const stateToken = req.cookies && req.cookies[STATE_COOKIE];
            if (!stateToken || !req.query.code || !req.query.state) {
                return fail('Sign in session expired, please try again');
            }

            let transient;
            try {
                transient = jwt.verify(stateToken, configService.getValue('secret'));
            } catch (err) {
                return fail('Sign in session expired, please try again');
            }

            isLinkFlow = !!transient.linkUserId;

            if (transient.state !== req.query.state) {
                return fail('Sign in state mismatch, please try again');
            }

            let claims;
            try {
                claims = await oidcService.handleCallback({
                    code: req.query.code,
                    codeVerifier: transient.verifier,
                    nonce: transient.nonce
                });
            } catch (err) {
                logger.error('OIDC callback failed', err);

                return fail('Sign in failed, please try again');
            }

            // Settings link flow: attach the identity to the requesting
            // account and return to settings — no session minting needed.
            if (isLinkFlow) {
                try {
                    await oidcService.linkClaimsToUser(transient.linkUserId, claims);
                } catch (err) {
                    logger.warn(`OIDC link failed for user ${transient.linkUserId}`, err);

                    return fail('That identity is already linked to a different account');
                }

                res.clearCookie(STATE_COOKIE);

                return res.redirect('/profile#ssoLinked=1');
            }

            let ip = req.get('x-real-ip');
            if (!ip) {
                ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
            }

            let user;
            try {
                const username = await oidcService.resolveUser(claims, ip);
                user = await userService.getFullUserByUsername(username);
            } catch (err) {
                logger.error('Failed to resolve OIDC user', err);

                return fail('Could not link your account, please contact support');
            }

            if (!user || user.disabled) {
                return fail('This account is disabled');
            }

            const userObj = user.getWireSafeDetails();
            const authToken = jwt.sign(userObj, configService.getValue('secret'), {
                expiresIn: '5m'
            });

            const refreshToken = await userService.addRefreshToken(user, authToken, ip);
            if (!refreshToken) {
                return fail('Sign in failed, please try again');
            }

            const payload = Buffer.from(
                JSON.stringify({ token: authToken, refreshToken: refreshToken, user: userObj })
            ).toString('base64url');

            res.clearCookie(STATE_COOKIE);
            res.redirect(`/login#sso=${payload}`);
        })
    );
};
