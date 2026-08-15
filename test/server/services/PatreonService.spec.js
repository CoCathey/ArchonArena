const PatreonService = require('../../../server/services/PatreonService');

describe('PatreonService', function () {
    let userService;
    let service;
    let config;
    let fetchMock;

    beforeEach(function () {
        config = {
            enabled: true,
            clientId: 'client-id',
            clientSecret: 'secret',
            callbackUrl: 'https://site/patreon',
            campaignId: '',
            campaignUrl: 'https://www.patreon.com/archonarena'
        };
        userService = {
            update: vi.fn().mockResolvedValue(undefined),
            getUserByUsername: vi.fn()
        };
        const configService = { getValue: (key) => (key === 'patreon' ? config : undefined) };
        service = new PatreonService(configService, userService);
        fetchMock = vi.spyOn(global, 'fetch');
    });

    afterEach(function () {
        fetchMock.mockRestore();
    });

    const json = (body, ok = true, status = 200) =>
        fetchMock.mockResolvedValue({
            ok,
            status,
            json: async () => body,
            text: async () => JSON.stringify(body)
        });

    const userWith = (patreon) => ({
        username: 'alice',
        patreon,
        getDetails: () => ({ username: 'alice', patreon })
    });

    // A v2 identity payload with one membership of the given campaign.
    const identity = ({ status = 'active_patron', campaignId = '42', tiers = [] } = {}) => ({
        data: { id: '1', type: 'user' },
        included: [
            {
                type: 'member',
                id: 'm1',
                attributes: {
                    patron_status: status,
                    currently_entitled_amount_cents: 500,
                    last_charge_status: 'Paid'
                },
                relationships: {
                    campaign: { data: { type: 'campaign', id: campaignId } },
                    currently_entitled_tiers: {
                        data: tiers.map((tier) => ({ type: 'tier', id: tier.id }))
                    }
                }
            },
            ...tiers.map((tier) => ({
                type: 'tier',
                id: tier.id,
                attributes: { title: tier.title, amount_cents: tier.amountCents }
            }))
        ]
    });

    describe('configuration', function () {
        it('is enabled only when the credentials are present', function () {
            expect(service.isEnabled()).toBe(true);

            config.clientSecret = '';
            expect(service.isEnabled()).toBe(false);
        });

        it('stays disabled when the kill switch is off despite credentials', function () {
            config.enabled = false;

            expect(service.isEnabled()).toBe(false);
        });

        it('is disabled when there is no callback url to redirect back to', function () {
            config.callbackUrl = '';

            expect(service.isEnabled()).toBe(false);
        });
    });

    describe('authorization request', function () {
        it('asks for the membership scope', function () {
            // Without identity.memberships Patreon returns an identity with no
            // member records, so nobody could ever reach 'pledged'.
            const params = new URL(service.createAuthRequest().url).searchParams;

            expect(params.get('scope')).toContain('identity.memberships');
        });

        it('separates the scopes with %20 rather than a bare +', function () {
            // A '+' only means a space under form-encoding rules; read
            // literally it silently drops identity.memberships.
            expect(service.createAuthRequest().url).toContain(
                'scope=identity%20identity.memberships'
            );
        });

        it('sends the configured client and callback', function () {
            const params = new URL(service.createAuthRequest().url).searchParams;

            expect(params.get('client_id')).toBe('client-id');
            expect(params.get('redirect_uri')).toBe('https://site/patreon');
            expect(params.get('response_type')).toBe('code');
        });

        it('mints a fresh unguessable state each time', function () {
            const first = service.createAuthRequest();
            const second = service.createAuthRequest();

            expect(first.state).not.toBe(second.state);
            expect(first.state.length).toBeGreaterThanOrEqual(24);
            expect(new URL(first.url).searchParams.get('state')).toBe(first.state);
        });

        /**
         * ARCHON (N12): the phone app cannot be redirected to.
         *
         * Patreon allows one registered redirect URI and it is the website, so
         * a link started in the app comes back to the browser. The marker on
         * the state is how the web callback page knows to forward it to the
         * app's deep link instead of trying to complete a link for a browser
         * session that is not signed in.
         */
        describe('a link started on a phone', function () {
            it('marks the state so the site forwards it to the app', function () {
                expect(service.createAuthRequest({ mobile: true }).state).toMatch(/^m\./);
            });

            it('does not mark a browser link', function () {
                expect(service.createAuthRequest().state).not.toMatch(/^m\./);
                expect(service.createAuthRequest({ mobile: false }).state).not.toMatch(/^m\./);
            });

            it('still sends the marked state to Patreon verbatim', function () {
                // The marker only survives the round trip if it is part of the
                // state Patreon echoes back.
                const request = service.createAuthRequest({ mobile: true });

                expect(new URL(request.url).searchParams.get('state')).toBe(request.state);
            });

            it('keeps the same registered redirect URI', function () {
                // The whole point of the marker is that no second URI has to be
                // registered; sending a custom scheme here would be rejected.
                const params = new URL(service.createAuthRequest({ mobile: true }).url)
                    .searchParams;

                expect(params.get('redirect_uri')).toBe('https://site/patreon');
            });

            it('is still unguessable', function () {
                const first = service.createAuthRequest({ mobile: true });
                const second = service.createAuthRequest({ mobile: true });

                expect(first.state).not.toBe(second.state);
                expect(first.state.length).toBeGreaterThanOrEqual(26);
            });
        });
    });

    describe('pledge status', function () {
        it('reports an active patron as pledged', async function () {
            json(identity());

            expect(await service.getPatreonStatusForUser(userWith({ access_token: 't' }))).toBe(
                'pledged'
            );
        });

        it('reports a linked account with no active membership as linked', async function () {
            json({ data: { id: '1' }, included: [] });

            expect(await service.getPatreonStatusForUser(userWith({ access_token: 't' }))).toBe(
                'linked'
            );
        });

        it('does not count a former or declined patron as pledged', async function () {
            // The distinction the supporter role depends on: a lapsed pledge
            // must lose the perks, not keep them.
            json({
                data: { id: '1' },
                included: [
                    { type: 'member', attributes: { patron_status: 'former_patron' } },
                    { type: 'member', attributes: { patron_status: 'declined_patron' } }
                ]
            });

            expect(await service.getPatreonStatusForUser(userWith({ access_token: 't' }))).toBe(
                'linked'
            );
        });

        it('asks for memberships with their campaign and tier linkage', async function () {
            json(identity());

            await service.getPatreonStatusForUser(userWith({ access_token: 't' }));

            const url = new URL(fetchMock.mock.calls[0][0]);
            expect(url.pathname).toContain('/api/oauth2/v2/identity');
            expect(url.searchParams.get('include')).toContain('memberships.campaign');
            expect(url.searchParams.get('include')).toContain(
                'memberships.currently_entitled_tiers'
            );
        });

        it('sends the access token as a bearer credential', async function () {
            json({ data: {}, included: [] });

            await service.getPatreonStatusForUser(userWith({ access_token: 'abc123' }));

            const [, options] = fetchMock.mock.calls[0];
            expect(options.headers.Authorization).toBe('Bearer abc123');
        });

        it('returns none for an account that has never linked', async function () {
            expect(await service.getPatreonStatusForUser(userWith(undefined))).toBe('none');
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('returns none rather than throwing when Patreon is down', async function () {
            fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

            expect(await service.getPatreonStatusForUser(userWith({ access_token: 't' }))).toBe(
                'none'
            );
        });

        it('returns none rather than throwing on an error response', async function () {
            fetchMock.mockResolvedValue({
                ok: false,
                status: 401,
                text: async () => 'unauthorized'
            });

            expect(await service.getPatreonStatusForUser(userWith({ access_token: 't' }))).toBe(
                'none'
            );
        });
    });

    describe('campaign scoping', function () {
        beforeEach(function () {
            config.campaignId = '42';
        });

        it('counts a pledge to the configured campaign', async function () {
            json(identity({ campaignId: '42' }));

            expect(await service.getPatreonStatusForUser(userWith({ access_token: 't' }))).toBe(
                'pledged'
            );
        });

        it('ignores an active pledge to somebody else', async function () {
            // Otherwise backing any unrelated creator on Patreon would grant
            // the supporter role here.
            json(identity({ campaignId: '999' }));

            expect(await service.getPatreonStatusForUser(userWith({ access_token: 't' }))).toBe(
                'linked'
            );
        });

        it('ignores a membership with no campaign linkage at all', async function () {
            json({
                data: { id: '1' },
                included: [{ type: 'member', attributes: { patron_status: 'active_patron' } }]
            });

            expect(await service.getPatreonStatusForUser(userWith({ access_token: 't' }))).toBe(
                'linked'
            );
        });

        it('counts every membership when no campaign is configured', async function () {
            config.campaignId = '';
            json(identity({ campaignId: '999' }));

            expect(await service.getPatreonStatusForUser(userWith({ access_token: 't' }))).toBe(
                'pledged'
            );
        });
    });

    describe('entitlements', function () {
        it('reports the tiers the pledge currently entitles', async function () {
            json(
                identity({
                    tiers: [{ id: 't1', title: 'Archon', amountCents: 500 }]
                })
            );

            const membership = await service.getMembershipForUser(userWith({ access_token: 't' }));

            expect(membership.status).toBe('pledged');
            expect(membership.tiers).toEqual([{ id: 't1', title: 'Archon', amountCents: 500 }]);
            expect(membership.amountCents).toBe(500);
            expect(membership.lastChargeStatus).toBe('Paid');
        });

        it('reports no tiers for a linked account that does not pledge', async function () {
            json(identity({ status: 'former_patron' }));

            const membership = await service.getMembershipForUser(userWith({ access_token: 't' }));

            expect(membership).toEqual({
                status: 'linked',
                tiers: [],
                amountCents: null,
                lastChargeStatus: null
            });
        });
    });

    describe('linking', function () {
        it('exchanges the code and stores the tokens against the account', async function () {
            json({ access_token: 'a', refresh_token: 'r' });
            const user = { username: 'alice', password: 'hashed' };
            userService.getUserByUsername.mockResolvedValue(user);

            const result = await service.linkAccount('alice', 'the-code');

            expect(result).toBe(user);
            expect(user.patreon.access_token).toBe('a');

            const [url, options] = fetchMock.mock.calls[0];
            expect(url).toContain('/api/oauth2/token');
            expect(options.method).toBe('POST');

            const body = Object.fromEntries(new URLSearchParams(options.body));
            expect(body).toMatchObject({
                grant_type: 'authorization_code',
                code: 'the-code',
                client_id: 'client-id',
                client_secret: 'secret',
                redirect_uri: 'https://site/patreon'
            });
        });

        it('never writes the password back when saving the link', async function () {
            // The account row is updated with the token; the hash must not ride
            // along and be re-saved.
            //
            // Snapshotted inside the mock rather than read from mock.calls
            // afterwards: the service passes the caller's own object and then
            // restores the password on it, so the recorded reference has the
            // hash back by the time the assertion runs. What matters is the
            // value at the moment update() was called.
            let seenAtCallTime;
            userService.update = vi.fn(async (details) => {
                seenAtCallTime = { ...details };
            });

            json({ access_token: 'a' });
            const user = { username: 'alice', password: 'hashed' };
            userService.getUserByUsername.mockResolvedValue(user);

            await service.linkAccount('alice', 'code');

            expect(seenAtCallTime.password).toBeUndefined();
            expect(seenAtCallTime.patreon.access_token).toBe('a');
            // ...and the caller's object still has its password afterwards.
            expect(user.password).toBe('hashed');
        });

        it('fails cleanly when the code exchange is rejected', async function () {
            fetchMock.mockResolvedValue({
                ok: false,
                status: 400,
                text: async () => 'invalid_grant'
            });

            expect(await service.linkAccount('alice', 'bad-code')).toBe(false);
            expect(userService.update).not.toHaveBeenCalled();
        });

        it('fails cleanly when the account does not exist', async function () {
            json({ access_token: 'a' });
            userService.getUserByUsername.mockResolvedValue(null);

            expect(await service.linkAccount('nobody', 'code')).toBe(false);
        });
    });

    describe('refresh', function () {
        it('uses the refresh grant and persists the new tokens', async function () {
            json({ access_token: 'new', refresh_token: 'newer' });
            const user = userWith({ access_token: 'old', refresh_token: 'r' });

            const result = await service.refreshTokenForUser(user);

            expect(result.access_token).toBe('new');
            expect(user.patreon.access_token).toBe('new');

            const body = Object.fromEntries(new URLSearchParams(fetchMock.mock.calls[0][1].body));
            expect(body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r' });
        });

        it('does nothing for an account with no refresh token', async function () {
            expect(await service.refreshTokenForUser(userWith({}))).toBeUndefined();
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('returns undefined rather than throwing when the refresh fails', async function () {
            fetchMock.mockRejectedValue(new Error('network'));

            expect(
                await service.refreshTokenForUser(userWith({ refresh_token: 'r' }))
            ).toBeUndefined();
        });
    });

    describe('unlinking', function () {
        it('clears the stored tokens', async function () {
            const user = { username: 'alice', patreon: { access_token: 'a' } };
            userService.getUserByUsername.mockResolvedValue(user);

            expect(await service.unlinkAccount('alice')).toBe(true);
            expect(user.patreon).toBeUndefined();
            expect(userService.update).toHaveBeenCalled();
        });

        it('fails cleanly for an unknown account', async function () {
            userService.getUserByUsername.mockResolvedValue(null);

            expect(await service.unlinkAccount('nobody')).toBe(false);
        });
    });
});
