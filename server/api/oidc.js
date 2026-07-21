const jwt = require('jsonwebtoken');

const logger = require('../log.js');
const { wrapAsync } = require('../util.js');
const ConfigService = require('../services/ConfigService');
const UserService = require('../services/UserService');
const OidcService = require('../services/auth/OidcService');

const configService = new ConfigService();
const userService = new UserService(configService);
const oidcService = new OidcService(configService, userService);

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
            const fail = (message) => {
                res.clearCookie(STATE_COOKIE);
                res.redirect(`/login#ssoError=${encodeURIComponent(message)}`);
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
