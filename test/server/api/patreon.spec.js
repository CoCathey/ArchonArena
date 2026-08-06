const jwt = require('jsonwebtoken');

const { verifyLinkState, syncSupporterRole } = require('../../../server/api/patreon');

describe('patreon api', function () {
    const SECRET = 'test-secret';

    const stateCookie = (payload, options = {}) =>
        jwt.sign(payload, options.secret || SECRET, { expiresIn: options.expiresIn || '10m' });

    describe('link state verification', function () {
        it('accepts the state it minted for this user', function () {
            const token = stateCookie({ state: 'abc', linkUserId: 7 });

            expect(
                verifyLinkState({
                    stateToken: token,
                    providedState: 'abc',
                    userId: 7,
                    secret: SECRET
                })
            ).toBe(true);
        });

        it('rejects a state that does not match the cookie', function () {
            // The CSRF case: an attacker walks a logged-in player through a
            // link of the attacker's Patreon account.
            const token = stateCookie({ state: 'abc', linkUserId: 7 });

            expect(
                verifyLinkState({
                    stateToken: token,
                    providedState: 'somebody-elses',
                    userId: 7,
                    secret: SECRET
                })
            ).toBe(false);
        });

        it('rejects a cookie minted for a different account', function () {
            const token = stateCookie({ state: 'abc', linkUserId: 7 });

            expect(
                verifyLinkState({
                    stateToken: token,
                    providedState: 'abc',
                    userId: 8,
                    secret: SECRET
                })
            ).toBe(false);
        });

        it('rejects a cookie signed with another secret', function () {
            const token = stateCookie({ state: 'abc', linkUserId: 7 }, { secret: 'forged' });

            expect(
                verifyLinkState({
                    stateToken: token,
                    providedState: 'abc',
                    userId: 7,
                    secret: SECRET
                })
            ).toBe(false);
        });

        it('rejects an expired cookie', function () {
            const token = jwt.sign({ state: 'abc', linkUserId: 7 }, SECRET, { expiresIn: '-1s' });

            expect(
                verifyLinkState({
                    stateToken: token,
                    providedState: 'abc',
                    userId: 7,
                    secret: SECRET
                })
            ).toBe(false);
        });

        it('rejects a callback with no cookie or no state at all', function () {
            const token = stateCookie({ state: 'abc', linkUserId: 7 });

            expect(verifyLinkState({ providedState: 'abc', userId: 7, secret: SECRET })).toBe(
                false
            );
            expect(verifyLinkState({ stateToken: token, userId: 7, secret: SECRET })).toBe(false);
        });
    });

    describe('supporter role sync', function () {
        let users;

        beforeEach(function () {
            users = { setSupporterStatus: vi.fn().mockResolvedValue(undefined) };
        });

        it('grants the role for an active pledge', async function () {
            const user = { id: 3, username: 'alice', permissions: {} };

            await syncSupporterRole(user, true, users);

            expect(users.setSupporterStatus).toHaveBeenCalledWith(3, true);
            expect(user.permissions.isSupporter).toBe(true);
        });

        it('revokes the role when the pledge is gone', async function () {
            const user = { id: 3, username: 'alice', permissions: { isSupporter: true } };

            await syncSupporterRole(user, false, users);

            expect(users.setSupporterStatus).toHaveBeenCalledWith(3, false);
            expect(user.permissions.isSupporter).toBe(false);
        });

        it('leaves an admin-granted lifetime supporter alone', async function () {
            const user = {
                id: 3,
                username: 'alice',
                permissions: { isSupporter: true, keepsSupporterWithNoPatreon: true }
            };

            await syncSupporterRole(user, false, users);

            expect(users.setSupporterStatus).not.toHaveBeenCalled();
            expect(user.permissions.isSupporter).toBe(true);
        });

        it('does not throw when the role update fails', async function () {
            // The account is already linked by this point; a role write that
            // fails must not turn a successful link into an error.
            users.setSupporterStatus.mockRejectedValue(new Error('db down'));

            await expect(
                syncSupporterRole({ id: 3, username: 'alice', permissions: {} }, true, users)
            ).resolves.toBeUndefined();
        });
    });
});
