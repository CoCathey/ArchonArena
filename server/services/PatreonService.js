const logger = require('../log.js');

/**
 * Patreon account linking and pledge status.
 *
 * ARCHON (I5): this used to run on the `patreon` npm package, which has been
 * unmaintained for years and pulled a transitive dependency tree that kept
 * showing up in `npm audit`. Everything it did here is three HTTP calls, so it
 * is now plain `fetch` and the dependency is gone.
 *
 * Two things changed with it, both deliberate:
 *
 *  - **API v2 instead of v1.** The package spoke Patreon's v1 API, which has
 *    been deprecated for years; `/current_user` and the pledge schema it used
 *    are on the way out. v2's identity endpoint is the supported equivalent.
 *  - **Errors are read as text, not as a stream.** The old code had a helper
 *    that drained `err.response.body` as a Node stream purely because the HTTP
 *    library returned one.
 *
 * The integration is still dormant - there is no campaign, no credentials and
 * no defined perks (see **N12**), so nothing here has been exercised against a
 * live Patreon account. N12 owns that verification; this change is about the
 * dependency, and it keeps the same public interface so N12 has the same
 * surface to wire up.
 */

const TOKEN_URL = 'https://www.patreon.com/api/oauth2/token';
const IDENTITY_URL =
    'https://www.patreon.com/api/oauth2/v2/identity' +
    '?include=memberships&fields%5Bmember%5D=patron_status';

// Patreon is a third party on the network path; never let a hung request hold
// an account page open indefinitely.
const REQUEST_TIMEOUT_MS = 10000;

class PatreonService {
    constructor(clientId, secret, userService, callbackUrl) {
        this.userService = userService;
        this.callbackUrl = callbackUrl;
        this.clientId = clientId;
        this.secret = secret;
    }

    /**
     * POST to Patreon's OAuth token endpoint. Shared by the initial code
     * exchange and the refresh, which differ only in grant type.
     *
     * @returns {Promise<object|undefined>} the token payload, or undefined
     */
    async requestToken(params) {
        let response;

        try {
            response = await fetch(TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: this.clientId,
                    client_secret: this.secret,
                    ...params
                }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
        } catch (err) {
            logger.error('Error contacting Patreon token endpoint: %s', err.message);

            return undefined;
        }

        if (!response.ok) {
            // Body is read as text: an error response is not reliably JSON, and
            // a parse failure here would mask the status that explains it.
            logger.error(
                'Patreon token request failed (%s): %s',
                response.status,
                (await response.text().catch(() => '')).slice(0, 500)
            );

            return undefined;
        }

        try {
            return await response.json();
        } catch (err) {
            logger.error('Patreon returned an unreadable token response: %s', err.message);

            return undefined;
        }
    }

    /**
     * 'none' (no usable link), 'linked' (linked, not pledging) or 'pledged'.
     *
     * The status vocabulary is unchanged from the v1 implementation, so callers
     * and the stored `patreon` role logic behave the same.
     */
    async getPatreonStatusForUser(user) {
        const accessToken = user && user.patreon && user.patreon.access_token;

        if (!accessToken) {
            return 'none';
        }

        let response;

        try {
            response = await fetch(IDENTITY_URL, {
                headers: { Authorization: `Bearer ${accessToken}` },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
        } catch (err) {
            logger.error('Error getting patreon status for %s: %s', user.username, err.message);

            return 'none';
        }

        if (!response.ok) {
            logger.error(
                'Error getting patreon status for %s (%s): %s',
                user.username,
                response.status,
                (await response.text().catch(() => '')).slice(0, 500)
            );

            return 'none';
        }

        let body;

        try {
            body = await response.json();
        } catch (err) {
            logger.error('Patreon returned an unreadable identity response: %s', err.message);

            return 'none';
        }

        // v2 returns memberships in `included`; an active patron has at least
        // one member record whose patron_status is active_patron. Anything
        // else - declined, former, or no memberships at all - is 'linked'.
        const memberships = Array.isArray(body.included) ? body.included : [];
        const isActivePatron = memberships.some(
            (entry) =>
                entry &&
                entry.type === 'member' &&
                entry.attributes &&
                entry.attributes.patron_status === 'active_patron'
        );

        return isActivePatron ? 'pledged' : 'linked';
    }

    async refreshTokenForUser(user) {
        const refreshToken = user && user.patreon && user.patreon.refresh_token;

        if (!refreshToken) {
            return undefined;
        }

        const response = await this.requestToken({
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        });

        if (!response) {
            return undefined;
        }

        let userDetails = user.getDetails();
        // eslint-disable-next-line require-atomic-updates
        user.patreon = userDetails.patreon = response;

        try {
            await this.userService.update(userDetails);
        } catch (err) {
            logger.error(err);

            return undefined;
        }

        return response;
    }

    async linkAccount(username, code) {
        const response = await this.requestToken({
            grant_type: 'authorization_code',
            code,
            redirect_uri: this.callbackUrl
        });

        if (!response) {
            return false;
        }

        response.date = new Date();

        let user = await this.userService.getUserByUsername(username);
        if (!user) {
            logger.error('Error linking patreon account, user not found');

            return false;
        }

        user.patreon = response;

        try {
            let password = user.password;

            user.password = undefined;
            await this.userService.update(user);

            user.password = password;
        } catch (err) {
            logger.error(err);

            return false;
        }

        return user;
    }

    async unlinkAccount(username) {
        let user = await this.userService.getUserByUsername(username);
        if (!user) {
            logger.error('Error unlinking patreon account, user not found');

            return false;
        }

        user.patreon = undefined;

        try {
            await this.userService.update(user);
        } catch (err) {
            logger.error(err);

            return false;
        }

        return true;
    }
}

module.exports = PatreonService;
