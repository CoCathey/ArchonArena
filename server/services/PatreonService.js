const crypto = require('crypto');

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
 * ARCHON (N12): the integration is no longer dormant. Credentials now come from
 * the `patreon` config section (env: PATREON_CLIENT_ID / PATREON_CLIENT_SECRET)
 * instead of being hardcoded, and three things had to change before a real
 * campaign could be pointed at it:
 *
 *  - **Scopes.** The authorization request now asks for `identity` *and*
 *    `identity.memberships`. Without the second one Patreon returns an identity
 *    with no membership records at all, so an active patron is indistinguishable
 *    from a lapsed one and nobody ever reaches 'pledged'. This is why the
 *    inherited flow could never have granted the supporter role.
 *  - **Campaign scoping.** `/identity` returns memberships for *every* creator
 *    the player supports. Counting all of them makes anyone who backs any
 *    unrelated Patreon a supporter here. When `campaignId` is configured, only
 *    memberships of that campaign count.
 *  - **The `state` parameter.** Built here, verified by the API layer, so a
 *    third party cannot walk a logged-in player through a link of *their*
 *    Patreon account.
 *
 * Tier entitlements come back with the membership so the supporter perks in the
 * roadmap have something to key off; nothing in this file decides what a tier
 * unlocks.
 */

const TOKEN_URL = 'https://www.patreon.com/api/oauth2/token';
const AUTHORIZE_URL = 'https://www.patreon.com/oauth2/authorize';
const IDENTITY_URL = 'https://www.patreon.com/api/oauth2/v2/identity';

// `identity` is who they are; `identity.memberships` is whether they pledge,
// to which campaign, and at which tier. The second is not optional - see the
// note above.
const SCOPES = 'identity identity.memberships';

// The include path (rather than a bare `include=memberships`) is what
// guarantees each member record carries its campaign and tier linkage, which
// campaign scoping and tier display both read.
const IDENTITY_QUERY = new URLSearchParams({
    include: 'memberships.campaign,memberships.currently_entitled_tiers',
    'fields[member]': 'patron_status,currently_entitled_amount_cents,last_charge_status',
    'fields[tier]': 'title,amount_cents'
}).toString();

// Patreon is a third party on the network path; never let a hung request hold
// an account page open indefinitely.
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

class PatreonService {
    /**
     * @param {import('./ConfigService')} configService reads the `patreon` section
     * @param {object} userService persists the token against the account
     */
    constructor(configService, userService) {
        this.configService = configService;
        this.userService = userService;
    }

    getConfig() {
        return this.configService.getValue('patreon') || {};
    }

    /**
     * Whether the integration can actually be used. Credentials are part of the
     * test, not just the flag: a half-configured deployment must present no
     * Patreon UI at all rather than a button that dead-ends on Patreon's error
     * page.
     */
    isEnabled() {
        const config = this.getConfig();

        return !!(config.enabled && config.clientId && config.clientSecret && config.callbackUrl);
    }

    get timeoutMs() {
        return this.getConfig().requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    }

    /**
     * The authorization URL to send the player to, plus the `state` the
     * callback has to echo back. The caller is responsible for remembering the
     * state (a signed cookie, in the API layer) and rejecting a mismatch.
     *
     * @returns {{url: string, state: string}}
     */
    createAuthRequest() {
        const config = this.getConfig();
        const state = crypto.randomBytes(24).toString('base64url');

        const params = new URLSearchParams({
            response_type: 'code',
            client_id: config.clientId,
            redirect_uri: config.callbackUrl,
            scope: SCOPES,
            state: state
        });

        // URLSearchParams encodes the space between the two scopes as '+',
        // which is only a space under form-encoding rules. %20 means a space
        // under both, and a provider that read the '+' literally would hand
        // back a token without `identity.memberships` - the one failure that
        // looks like "nobody is a patron" rather than like an error.
        return { url: `${AUTHORIZE_URL}?${params.toString().replace(/\+/g, '%20')}`, state: state };
    }

    /**
     * POST to Patreon's OAuth token endpoint. Shared by the initial code
     * exchange and the refresh, which differ only in grant type.
     *
     * @returns {Promise<object|undefined>} the token payload, or undefined
     */
    async requestToken(params) {
        const config = this.getConfig();
        let response;

        try {
            response = await fetch(TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: config.clientId,
                    client_secret: config.clientSecret,
                    ...params
                }),
                signal: AbortSignal.timeout(this.timeoutMs)
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
     * The player's membership of *this* campaign.
     *
     * @returns {Promise<{status: string, tiers: object[], amountCents: number|null,
     *          lastChargeStatus: string|null}>} status is 'none' (no usable
     *          link), 'linked' (linked, not pledging) or 'pledged'.
     */
    async getMembershipForUser(user) {
        const accessToken = user && user.patreon && user.patreon.access_token;
        const none = { status: 'none', tiers: [], amountCents: null, lastChargeStatus: null };

        if (!accessToken) {
            return none;
        }

        let response;

        try {
            response = await fetch(`${IDENTITY_URL}?${IDENTITY_QUERY}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
                signal: AbortSignal.timeout(this.timeoutMs)
            });
        } catch (err) {
            logger.error('Error getting patreon status for %s: %s', user.username, err.message);

            return none;
        }

        if (!response.ok) {
            logger.error(
                'Error getting patreon status for %s (%s): %s',
                user.username,
                response.status,
                (await response.text().catch(() => '')).slice(0, 500)
            );

            return none;
        }

        let body;

        try {
            body = await response.json();
        } catch (err) {
            logger.error('Patreon returned an unreadable identity response: %s', err.message);

            return none;
        }

        return this.readMembership(body);
    }

    /**
     * 'none' (no usable link), 'linked' (linked, not pledging) or 'pledged'.
     *
     * The status vocabulary is unchanged from the v1 implementation, so callers
     * and the stored `patreon` role logic behave the same.
     */
    async getPatreonStatusForUser(user) {
        return (await this.getMembershipForUser(user)).status;
    }

    /**
     * Reduce a v2 identity payload to this campaign's membership.
     *
     * Split out from the fetch so the JSON:API reshaping - which is the part
     * with the interesting edge cases - is directly testable.
     */
    readMembership(body) {
        const campaignId = this.getConfig().campaignId;
        const included = Array.isArray(body && body.included) ? body.included : [];

        const tiersById = new Map(
            included
                .filter((entry) => entry && entry.type === 'tier')
                .map((entry) => [
                    String(entry.id),
                    {
                        id: String(entry.id),
                        title: (entry.attributes && entry.attributes.title) || null,
                        amountCents: (entry.attributes && entry.attributes.amount_cents) ?? null
                    }
                ])
        );

        let memberships = included.filter((entry) => entry && entry.type === 'member');

        if (campaignId) {
            // Fail closed: a member record whose campaign linkage is missing is
            // not evidence of a pledge to *us*. Counting it would hand the
            // supporter role to anyone who backs any creator on Patreon.
            memberships = memberships.filter(
                (entry) =>
                    String(
                        entry.relationships &&
                            entry.relationships.campaign &&
                            entry.relationships.campaign.data &&
                            entry.relationships.campaign.data.id
                    ) === String(campaignId)
            );
        }

        // 'active_patron' is the only status that pays. Anything else -
        // declined, former, or no membership at all - is a link without a
        // pledge, and must not keep the perks.
        const active = memberships.find(
            (entry) => entry.attributes && entry.attributes.patron_status === 'active_patron'
        );

        if (!active) {
            return { status: 'linked', tiers: [], amountCents: null, lastChargeStatus: null };
        }

        const entitled =
            (active.relationships &&
                active.relationships.currently_entitled_tiers &&
                active.relationships.currently_entitled_tiers.data) ||
            [];

        return {
            status: 'pledged',
            tiers: entitled.map((ref) => tiersById.get(String(ref && ref.id))).filter(Boolean),
            amountCents: active.attributes.currently_entitled_amount_cents ?? null,
            lastChargeStatus: active.attributes.last_charge_status || null
        };
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

        response.date = new Date();

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
            redirect_uri: this.getConfig().callbackUrl
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
module.exports.SCOPES = SCOPES;
