const PatreonService = require('../../../server/services/PatreonService');

describe('PatreonService', function () {
    let userService;
    let service;
    let fetchMock;

    beforeEach(function () {
        userService = {
            update: vi.fn().mockResolvedValue(undefined),
            getUserByUsername: vi.fn()
        };
        service = new PatreonService('client-id', 'secret', userService, 'https://site/callback');
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

    describe('pledge status', function () {
        it('reports an active patron as pledged', async function () {
            json({
                data: { id: '1', type: 'user' },
                included: [{ type: 'member', attributes: { patron_status: 'active_patron' } }]
            });

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

        it('sends the access token as a bearer credential', async function () {
            json({ data: {}, included: [] });

            await service.getPatreonStatusForUser(userWith({ access_token: 'abc123' }));

            const [url, options] = fetchMock.mock.calls[0];
            expect(url).toContain('/api/oauth2/v2/identity');
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
                redirect_uri: 'https://site/callback'
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
