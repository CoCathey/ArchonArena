const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const logger = require('../../log');

const base64url = (buffer) => buffer.toString('base64url');

/**
 * OpenID Connect login (authorization code + PKCE) against any standard
 * OIDC provider — primarily Keybringer's Keycloak realm.
 *
 * Responsibilities: provider discovery, building authorization requests,
 * exchanging codes, validating ID tokens against the provider's JWKS, and
 * resolving the OIDC identity to an Archon Arena user (login existing
 * link, link by verified email, or create a new account).
 *
 * Design constraints:
 *  - No new dependencies: discovery/JWKS via global fetch, signature
 *    verification via node crypto JWK support + jsonwebtoken.
 *  - Provider-agnostic: everything comes from config (auth.oidc), so a
 *    second provider (e.g. Discord's OIDC bridge) is a config entry away.
 *  - db and userService are injected for testability.
 */
class OidcService {
    constructor(configService, userService, db = require('../../db'), fetchImpl = fetch) {
        this.configService = configService;
        this.userService = userService;
        this.db = db;
        this.fetch = fetchImpl;
        this.discoveryCache = null;
        this.jwksCache = null;
    }

    getConfig() {
        const auth = this.configService.getValue('auth') || {};

        return auth.oidc || {};
    }

    isEnabled() {
        const config = this.getConfig();

        return !!config.enabled && !!config.issuer && !!config.clientId;
    }

    async discover() {
        const config = this.getConfig();
        const cacheMs = 60 * 60 * 1000;

        if (this.discoveryCache && Date.now() - this.discoveryCache.fetchedAt < cacheMs) {
            return this.discoveryCache.document;
        }

        const issuer = config.issuer.replace(/\/$/, '');
        const response = await this.fetch(`${issuer}/.well-known/openid-configuration`, {
            signal: AbortSignal.timeout(config.requestTimeoutMs || 10000)
        });

        if (!response.ok) {
            throw new Error(`OIDC discovery failed with status ${response.status}`);
        }

        const document = await response.json();
        this.discoveryCache = { document, fetchedAt: Date.now() };

        return document;
    }

    /**
     * Build the provider authorization URL plus the transient values
     * (state, nonce, PKCE verifier) the callback needs to verify.
     */
    async createAuthRequest() {
        const config = this.getConfig();
        const discovery = await this.discover();

        const state = base64url(crypto.randomBytes(24));
        const nonce = base64url(crypto.randomBytes(24));
        const codeVerifier = base64url(crypto.randomBytes(32));
        const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());

        const params = new URLSearchParams({
            client_id: config.clientId,
            redirect_uri: config.redirectUri,
            response_type: 'code',
            scope: config.scopes || 'openid profile email',
            state: state,
            nonce: nonce,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256'
        });

        return {
            url: `${discovery.authorization_endpoint}?${params}`,
            state: state,
            nonce: nonce,
            codeVerifier: codeVerifier
        };
    }

    async getSigningKey(kid) {
        const config = this.getConfig();
        const cacheMs = 60 * 60 * 1000;

        if (!this.jwksCache || Date.now() - this.jwksCache.fetchedAt >= cacheMs) {
            const discovery = await this.discover();
            const response = await this.fetch(discovery.jwks_uri, {
                signal: AbortSignal.timeout(config.requestTimeoutMs || 10000)
            });

            if (!response.ok) {
                throw new Error(`JWKS fetch failed with status ${response.status}`);
            }

            this.jwksCache = { keys: (await response.json()).keys || [], fetchedAt: Date.now() };
        }

        const jwk = this.jwksCache.keys.find((key) => key.kid === kid);
        if (!jwk) {
            throw new Error('No matching signing key found for ID token');
        }

        return crypto.createPublicKey({ key: jwk, format: 'jwk' });
    }

    /**
     * Exchange the authorization code and return the validated ID token
     * claims. Throws on any validation failure.
     */
    async handleCallback({ code, codeVerifier, nonce }) {
        const config = this.getConfig();
        const discovery = await this.discover();

        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: config.redirectUri,
            client_id: config.clientId,
            code_verifier: codeVerifier
        });

        if (config.clientSecret) {
            body.set('client_secret', config.clientSecret);
        }

        const response = await this.fetch(discovery.token_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
            signal: AbortSignal.timeout(config.requestTimeoutMs || 10000)
        });

        if (!response.ok) {
            throw new Error(`Token exchange failed with status ${response.status}`);
        }

        const tokens = await response.json();
        if (!tokens.id_token) {
            throw new Error('Token response contained no id_token');
        }

        const decoded = jwt.decode(tokens.id_token, { complete: true });
        if (!decoded || !decoded.header || !decoded.header.kid) {
            throw new Error('Malformed id_token');
        }

        const key = await this.getSigningKey(decoded.header.kid);
        const claims = jwt.verify(tokens.id_token, key, {
            algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384'],
            issuer: config.issuer,
            audience: config.clientId
        });

        if (nonce && claims.nonce !== nonce) {
            throw new Error('ID token nonce mismatch');
        }

        return claims;
    }

    async getIdentity(provider, subject) {
        const rows = await this.db.query(
            'SELECT * FROM "UserOidcIdentities" WHERE "Provider" = $1 AND "Subject" = $2',
            [provider, subject]
        );

        return rows && rows[0];
    }

    async linkIdentity(userId, provider, subject, email) {
        await this.db.query(
            'INSERT INTO "UserOidcIdentities" ("UserId", "Provider", "Subject", "Email", "CreatedAt") ' +
                "VALUES ($1, $2, $3, $4, now() AT TIME ZONE 'utc') " +
                'ON CONFLICT ("Provider", "Subject") DO NOTHING',
            [userId, provider, subject, email || null]
        );
    }

    sanitizeUsername(raw) {
        const cleaned = (raw || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 15);

        return cleaned.length >= 3
            ? cleaned
            : `Archon${base64url(crypto.randomBytes(4))}`
                  .slice(0, 15)
                  .replace(/[^A-Za-z0-9_-]/g, '');
    }

    async findFreeUsername(base) {
        let candidate = this.sanitizeUsername(base);

        for (let attempt = 0; attempt < 10; attempt++) {
            if (!(await this.userService.doesUserExist(candidate))) {
                return candidate;
            }

            const suffix = String(crypto.randomInt(10, 9999));
            candidate = `${this.sanitizeUsername(base).slice(0, 15 - suffix.length)}${suffix}`;
        }

        throw new Error('Could not find a free username');
    }

    /**
     * Map validated ID token claims to a local user. Returns the username.
     *
     * Resolution order:
     *  1. Existing (provider, sub) link -> that user.
     *  2. Verified email matching a local account -> link and use it.
     *  3. Otherwise create a fresh, pre-verified account (SSO users never
     *     need email activation; the provider owns the email).
     */
    async resolveUser(claims, ip) {
        const config = this.getConfig();
        const provider = config.providerName || 'keybringer';

        const identity = await this.getIdentity(provider, claims.sub);
        if (identity) {
            const user = await this.userService.getUserById(identity.UserId);
            if (!user) {
                throw new Error(`OIDC identity ${identity.Id} references missing user`);
            }

            return user.username;
        }

        if (claims.email && claims.email_verified) {
            const existing = await this.userService.getUserByEmail(claims.email);
            if (existing) {
                await this.linkIdentity(existing.id, provider, claims.sub, claims.email);
                logger.info(
                    `Linked ${provider} identity ${claims.sub} to existing user ${existing.username}`
                );

                return existing.username;
            }
        }

        const username = await this.findFreeUsername(
            claims.preferred_username || (claims.email ? claims.email.split('@')[0] : 'Archon')
        );

        const newUser = await this.userService.addUser({
            username: username,
            // No local password: bcrypt.compare never matches an empty hash,
            // so password login is impossible until the user sets one.
            password: '',
            email: claims.email || null,
            registered: new Date(),
            registerIp: ip,
            avatar: username,
            verified: true
        });

        await this.linkIdentity(newUser.id, provider, claims.sub, claims.email);
        logger.info(`Created user ${username} from ${provider} identity ${claims.sub}`);

        return username;
    }
}

module.exports = OidcService;
