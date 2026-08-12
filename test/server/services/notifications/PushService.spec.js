const PushService = require('../../../../server/services/notifications/PushService');
const { looksLikeExpoToken } = require('../../../../server/services/notifications/PushService');

const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TOKEN_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';

/** An Expo response with one ticket per message, in order. */
const expoReply = (tickets) => ({
    ok: true,
    status: 200,
    json: async () => ({ data: tickets })
});

describe('PushService', function () {
    let db;
    let fetch;
    let service;

    beforeEach(function () {
        db = { query: vi.fn().mockResolvedValue([]) };
        fetch = vi.fn().mockResolvedValue(expoReply([{ status: 'ok', id: 'x' }]));
        service = new PushService(db, { fetch });
    });

    describe('token format', function () {
        it('accepts the two shapes Expo issues', function () {
            expect(looksLikeExpoToken(TOKEN_A)).toBe(true);
            expect(looksLikeExpoToken('ExpoPushToken[abc]')).toBe(true);
        });

        it('rejects anything else, including an FCM key pasted by hand', function () {
            expect(looksLikeExpoToken('')).toBe(false);
            expect(looksLikeExpoToken(undefined)).toBe(false);
            expect(looksLikeExpoToken('fGx9:APA91bH_long_fcm_token')).toBe(false);
            expect(looksLikeExpoToken('ExponentPushToken[unclosed')).toBe(false);
        });

        it('refuses to store a token that is not one', async function () {
            const result = await service.registerToken(4, 'not-a-token');

            expect(result.success).toBe(false);
            expect(db.query).not.toHaveBeenCalled();
        });
    });

    describe('registration', function () {
        it('upserts on the token so re-registering moves it to the signed-in account', async function () {
            await service.registerToken(4, TOKEN_A, { platform: 'ios', deviceName: 'iPhone' });

            const [sql, params] = db.query.mock.calls[0];

            expect(sql).toContain('ON CONFLICT ("Token") DO UPDATE');
            expect(sql).toContain('"UserId" = $1');
            expect(params).toEqual([4, TOKEN_A, 'ios', 'iPhone']);
        });

        it('removes a token for anybody when signing out', async function () {
            await service.removeToken(4, TOKEN_A, { any: true });

            const [sql, params] = db.query.mock.calls[0];

            expect(sql).not.toContain('UserId');
            expect(params).toEqual([TOKEN_A]);
        });

        it('otherwise only removes the caller’s own row', async function () {
            await service.removeToken(4, TOKEN_A);

            const [sql, params] = db.query.mock.calls[0];

            expect(sql).toContain('"UserId" = $2');
            expect(params).toEqual([TOKEN_A, 4]);
        });
    });

    describe('sending', function () {
        it('sends nothing when the account has no devices', async function () {
            db.query.mockResolvedValueOnce([]);

            const result = await service.send({ userId: 4, title: 'Round 2 pairing' });

            expect(fetch).not.toHaveBeenCalled();
            expect(result).toEqual({ sent: 0, failed: 0, removed: 0 });
        });

        it('sends one message per registered device', async function () {
            db.query.mockResolvedValueOnce([{ Token: TOKEN_A }, { Token: TOKEN_B }]);
            fetch.mockResolvedValueOnce(expoReply([{ status: 'ok' }, { status: 'ok' }]));

            const result = await service.send({
                userId: 4,
                title: 'Round 2 pairing',
                body: 'You are playing bob.',
                url: '/tournaments/3',
                category: 'tournament.pairing',
                data: { tournamentId: 3 }
            });

            expect(result.sent).toBe(2);

            const body = JSON.parse(fetch.mock.calls[0][1].body);

            expect(body).toHaveLength(2);
            expect(body[0].to).toBe(TOKEN_A);
            expect(body[0].title).toBe('Round 2 pairing');
            // Everything the app needs to open the right screen on a tap.
            expect(body[0].data).toEqual(
                expect.objectContaining({
                    url: '/tournaments/3',
                    category: 'tournament.pairing',
                    tournamentId: 3
                })
            );
        });

        it('splits past Expo’s hundred-message limit', async function () {
            const many = Array.from({ length: 150 }, (_, index) => ({
                Token: `ExponentPushToken[${String(index).padStart(6, '0')}]`
            }));
            db.query.mockResolvedValueOnce(many);
            fetch
                .mockResolvedValueOnce(expoReply(Array(100).fill({ status: 'ok' })))
                .mockResolvedValueOnce(expoReply(Array(50).fill({ status: 'ok' })));

            const result = await service.send({ userId: 4, title: 'Round 2 pairing' });

            expect(fetch).toHaveBeenCalledTimes(2);
            expect(JSON.parse(fetch.mock.calls[0][1].body)).toHaveLength(100);
            expect(JSON.parse(fetch.mock.calls[1][1].body)).toHaveLength(50);
            expect(result.sent).toBe(150);
        });

        it('drops a token Expo reports as dead, so it is not retried forever', async function () {
            db.query.mockResolvedValueOnce([{ Token: TOKEN_A }, { Token: TOKEN_B }]);
            fetch.mockResolvedValueOnce(
                expoReply([
                    { status: 'ok' },
                    { status: 'error', details: { error: 'DeviceNotRegistered' } }
                ])
            );

            const result = await service.send({ userId: 4, title: 'Round 2 pairing' });

            expect(result).toEqual({ sent: 1, failed: 1, removed: 1 });

            const deletion = db.query.mock.calls.find(([sql]) => sql.includes('DELETE'));

            expect(deletion[1]).toEqual([[TOKEN_B]]);
        });

        it('keeps a token that failed for some other reason', async function () {
            db.query.mockResolvedValueOnce([{ Token: TOKEN_A }]);
            fetch.mockResolvedValueOnce(
                expoReply([{ status: 'error', details: { error: 'MessageRateExceeded' } }])
            );

            const result = await service.send({ userId: 4, title: 'Round 2 pairing' });

            expect(result).toEqual({ sent: 0, failed: 1, removed: 0 });
            expect(db.query.mock.calls.some(([sql]) => sql.includes('DELETE'))).toBe(false);
        });

        it('never throws when Expo is unreachable', async function () {
            db.query.mockResolvedValueOnce([{ Token: TOKEN_A }]);
            fetch.mockRejectedValueOnce(new Error('ENOTFOUND'));

            await expect(service.send({ userId: 4, title: 'Round 2' })).resolves.toEqual({
                sent: 0,
                failed: 1,
                removed: 0
            });
        });

        it('never throws when Expo answers with an HTTP error', async function () {
            db.query.mockResolvedValueOnce([{ Token: TOKEN_A }]);
            fetch.mockResolvedValueOnce({ ok: false, status: 502 });

            await expect(service.send({ userId: 4, title: 'Round 2' })).resolves.toEqual({
                sent: 0,
                failed: 1,
                removed: 0
            });
        });

        it('never throws when the token lookup fails', async function () {
            db.query.mockRejectedValueOnce(new Error('database down'));

            await expect(service.send({ userId: 4, title: 'Round 2' })).resolves.toEqual({
                sent: 0,
                failed: 0,
                removed: 0
            });
        });

        it('sends only to tokens still in Expo’s format', async function () {
            // A row written by an older build, or hand-edited.
            db.query.mockResolvedValueOnce([{ Token: 'legacy-fcm-key' }, { Token: TOKEN_A }]);
            fetch.mockResolvedValueOnce(expoReply([{ status: 'ok' }]));

            await service.send({ userId: 4, title: 'Round 2' });

            expect(JSON.parse(fetch.mock.calls[0][1].body)).toHaveLength(1);
        });

        it('authorizes the request only when an access token is configured', async function () {
            db.query.mockResolvedValueOnce([{ Token: TOKEN_A }]);
            await service.send({ userId: 4, title: 'Round 2' });
            expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();

            const secured = new PushService(db, { fetch, accessToken: 'secret' });
            db.query.mockResolvedValueOnce([{ Token: TOKEN_A }]);
            await secured.send({ userId: 4, title: 'Round 2' });

            expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer secret');
        });
    });
});
