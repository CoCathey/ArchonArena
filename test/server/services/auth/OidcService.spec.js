const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const OidcService = require('../../../../server/services/auth/OidcService');

describe('OidcService', function () {
    const ISSUER = 'https://account.keybringer.com/realms/keybringer';
    const CLIENT_ID = 'archon-arena';

    let config;
    let service;
    let db;
    let userService;
    let fetchMock;
    const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

    const discoveryDocument = {
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`
    };

    const configService = () => ({
        getValue: (key) => (key === 'auth' ? { oidc: config } : undefined)
    });

    const jsonResponse = (body) => ({ ok: true, json: async () => body });

    const publicJwk = () => {
        const jwk = keyPair.publicKey.export({ format: 'jwk' });

        return { ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' };
    };

    const signIdToken = (claims, options = {}) =>
        jwt.sign(
            {
                iss: ISSUER,
                aud: CLIENT_ID,
                sub: 'subject-1',
                nonce: 'nonce-1',
                ...claims
            },
            keyPair.privateKey,
            { algorithm: 'RS256', keyid: options.kid || 'test-key', expiresIn: '5m' }
        );

    const mockProvider = (idToken) => {
        fetchMock.mockImplementation(async (url, options = {}) => {
            if (url.includes('openid-configuration')) {
                return jsonResponse(discoveryDocument);
            }

            if (url === discoveryDocument.jwks_uri) {
                return jsonResponse({ keys: [publicJwk()] });
            }

            if (url === discoveryDocument.token_endpoint) {
                mockProvider.lastTokenRequest = options;

                return jsonResponse({ id_token: idToken });
            }

            throw new Error(`Unexpected fetch: ${url}`);
        });
    };

    beforeEach(function () {
        config = {
            enabled: true,
            providerName: 'keybringer',
            issuer: ISSUER,
            clientId: CLIENT_ID,
            clientSecret: 'shhh',
            redirectUri: 'https://archonarena.com/api/account/oidc/callback',
            scopes: 'openid profile email'
        };
        db = { query: vi.fn().mockResolvedValue([]) };
        userService = {
            getUserById: vi.fn(),
            getUserByEmail: vi.fn().mockResolvedValue(undefined),
            doesUserExist: vi.fn().mockResolvedValue(false),
            addUser: vi.fn().mockImplementation(async (user) => ({ ...user, id: 42 }))
        };
        fetchMock = vi.fn();
        service = new OidcService(configService(), userService, db, fetchMock);
    });

    describe('isEnabled', function () {
        it('requires the enabled flag, issuer and client id', function () {
            expect(service.isEnabled()).toBe(true);

            config.enabled = false;
            expect(service.isEnabled()).toBe(false);

            config.enabled = true;
            config.clientId = '';
            expect(service.isEnabled()).toBe(false);
        });
    });

    describe('createAuthRequest', function () {
        it('builds a PKCE authorization request', async function () {
            mockProvider();

            const request = await service.createAuthRequest();
            const url = new URL(request.url);

            expect(request.url.startsWith(discoveryDocument.authorization_endpoint)).toBe(true);
            expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
            expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
            expect(url.searchParams.get('response_type')).toBe('code');
            expect(url.searchParams.get('code_challenge_method')).toBe('S256');
            expect(url.searchParams.get('state')).toBe(request.state);
            expect(url.searchParams.get('nonce')).toBe(request.nonce);

            const expectedChallenge = crypto
                .createHash('sha256')
                .update(request.codeVerifier)
                .digest('base64url');
            expect(url.searchParams.get('code_challenge')).toBe(expectedChallenge);
        });

        it('caches the discovery document', async function () {
            mockProvider();

            await service.createAuthRequest();
            await service.createAuthRequest();

            const discoveryCalls = fetchMock.mock.calls.filter(([url]) =>
                url.includes('openid-configuration')
            );
            expect(discoveryCalls.length).toBe(1);
        });
    });

    describe('handleCallback', function () {
        it('exchanges the code and returns validated claims', async function () {
            mockProvider(signIdToken({ email: 'player@example.com' }));

            const claims = await service.handleCallback({
                code: 'auth-code',
                codeVerifier: 'verifier',
                nonce: 'nonce-1'
            });

            expect(claims.sub).toBe('subject-1');
            expect(claims.email).toBe('player@example.com');

            const body = mockProvider.lastTokenRequest.body;
            expect(body).toContain('grant_type=authorization_code');
            expect(body).toContain('code=auth-code');
            expect(body).toContain('code_verifier=verifier');
            expect(body).toContain('client_secret=shhh');
        });

        it('rejects an id token with the wrong nonce', async function () {
            mockProvider(signIdToken({ nonce: 'evil' }));

            await expect(
                service.handleCallback({ code: 'c', codeVerifier: 'v', nonce: 'nonce-1' })
            ).rejects.toThrow(/nonce/);
        });

        it('rejects an id token from the wrong issuer', async function () {
            mockProvider(signIdToken({ iss: 'https://evil.example' }));

            await expect(
                service.handleCallback({ code: 'c', codeVerifier: 'v', nonce: 'nonce-1' })
            ).rejects.toThrow();
        });

        it('rejects an id token signed by an unknown key', async function () {
            mockProvider(signIdToken({}, { kid: 'unknown-key' }));

            await expect(
                service.handleCallback({ code: 'c', codeVerifier: 'v', nonce: 'nonce-1' })
            ).rejects.toThrow(/signing key/);
        });

        it('propagates token endpoint failures', async function () {
            fetchMock.mockImplementation(async (url) => {
                if (url.includes('openid-configuration')) {
                    return jsonResponse(discoveryDocument);
                }

                return { ok: false, status: 400 };
            });

            await expect(
                service.handleCallback({ code: 'bad', codeVerifier: 'v', nonce: 'n' })
            ).rejects.toThrow(/status 400/);
        });
    });

    describe('resolveUser', function () {
        it('returns the linked user for a known identity', async function () {
            db.query.mockResolvedValueOnce([{ Id: 1, UserId: 7 }]);
            userService.getUserById.mockResolvedValue({ username: 'Existing' });

            const username = await service.resolveUser({ sub: 'subject-1' }, '1.2.3.4');

            expect(username).toBe('Existing');
            expect(userService.getUserById).toHaveBeenCalledWith(7);
            expect(userService.addUser).not.toHaveBeenCalled();
        });

        it('links a verified email to an existing local account', async function () {
            db.query.mockResolvedValueOnce([]); // no identity yet
            userService.getUserByEmail.mockResolvedValue({ id: 9, username: 'MailUser' });

            const username = await service.resolveUser(
                { sub: 'subject-1', email: 'known@example.com', email_verified: true },
                '1.2.3.4'
            );

            expect(username).toBe('MailUser');
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO "UserOidcIdentities"'),
                expect.arrayContaining([9, 'keybringer', 'subject-1'])
            );
        });

        it('never links by unverified email', async function () {
            db.query.mockResolvedValueOnce([]);

            await service.resolveUser(
                {
                    sub: 'subject-1',
                    email: 'known@example.com',
                    email_verified: false,
                    preferred_username: 'NewPlayer'
                },
                '1.2.3.4'
            );

            expect(userService.getUserByEmail).not.toHaveBeenCalled();
            expect(userService.addUser).toHaveBeenCalled();
        });

        it('creates a pre-verified user with no usable password', async function () {
            db.query.mockResolvedValueOnce([]);

            const username = await service.resolveUser(
                { sub: 'subject-1', preferred_username: 'NewPlayer' },
                '1.2.3.4'
            );

            expect(username).toBe('NewPlayer');
            const created = userService.addUser.mock.calls[0][0];
            expect(created.verified).toBe(true);
            expect(created.password).toBe('');
        });

        it('sanitizes and deduplicates usernames', async function () {
            db.query.mockResolvedValueOnce([]);
            userService.doesUserExist.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

            const username = await service.resolveUser(
                { sub: 'subject-1', preferred_username: 'bad name!with@chars$here' },
                '1.2.3.4'
            );

            expect(username).toMatch(/^[A-Za-z0-9_-]{3,15}$/);
        });
    });

    describe('linkClaimsToUser', function () {
        it('links a fresh identity to the requesting user', async function () {
            db.query.mockResolvedValueOnce([]); // no existing identity

            await service.linkClaimsToUser(5, { sub: 'subject-1', email: 'p@example.com' });

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO "UserOidcIdentities"'),
                expect.arrayContaining([5, 'keybringer', 'subject-1'])
            );
        });

        it('is a no-op when the identity is already linked to this user', async function () {
            db.query.mockResolvedValueOnce([{ Id: 1, UserId: 5 }]);

            await service.linkClaimsToUser(5, { sub: 'subject-1' });

            const inserts = db.query.mock.calls.filter(([sql]) => sql.includes('INSERT'));
            expect(inserts.length).toBe(0);
        });

        it('refuses an identity already linked to a different account', async function () {
            db.query.mockResolvedValueOnce([{ Id: 1, UserId: 99 }]);

            await expect(service.linkClaimsToUser(5, { sub: 'subject-1' })).rejects.toThrow(
                /already linked/
            );
        });
    });

    describe('unlinkIdentity', function () {
        const identityRow = { Provider: 'keybringer', Email: 'p@example.com', CreatedAt: null };

        it('unlinks when the user has a usable password', async function () {
            db.query.mockResolvedValueOnce([identityRow]);

            const result = await service.unlinkIdentity(5, 'keybringer', true);

            expect(result.success).toBe(true);
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('DELETE FROM "UserOidcIdentities"'),
                [5, 'keybringer']
            );
        });

        it('refuses to orphan a passwordless account with a single identity', async function () {
            db.query.mockResolvedValueOnce([identityRow]);

            const result = await service.unlinkIdentity(5, 'keybringer', false);

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/password/i);
            const deletes = db.query.mock.calls.filter(([sql]) => sql.includes('DELETE'));
            expect(deletes.length).toBe(0);
        });

        it('reports an error for a provider that is not linked', async function () {
            db.query.mockResolvedValueOnce([]);

            const result = await service.unlinkIdentity(5, 'keybringer', true);

            expect(result.success).toBe(false);
        });
    });
});
