const moment = require('moment');

const {
    ACTIVATION_VALID_DAYS,
    ACTIVATION_RESEND_COOLDOWN_MINUTES,
    activationExpiryString,
    buildActivationToken,
    isActivationExpired,
    verifyActivationToken,
    resendCooldownRemaining
} = require('../../../server/services/activationToken');

const SECRET = 'test-hmac-secret';

/**
 * Every account created before this was fixed was already marked verified, so
 * none of this code had ever run against a real database. Each block below is
 * a regression for a distinct way it was broken.
 */
describe('activationToken', function () {
    describe('buildActivationToken', function () {
        it('returns an expiry that PostgreSQL can store in a timestamp column', function () {
            const { expiry } = buildActivationToken('Someone', SECRET);

            // The bug: this used to be the string '20260808-16:07:57', which
            // PostgreSQL rejects with 'invalid input syntax for type
            // timestamp'. The INSERT threw, so registration failed outright
            // the moment activation was switched on.
            expect(expiry).toBeInstanceOf(Date);
            expect(Number.isNaN(expiry.getTime())).toBe(false);
        });

        it('expires the token ACTIVATION_VALID_DAYS out', function () {
            const now = moment.utc('2026-08-01T12:00:00Z');
            const { expiry } = buildActivationToken('Someone', SECRET, now);

            expect(moment.utc(expiry).diff(now, 'days')).toBe(ACTIVATION_VALID_DAYS);
        });

        it('drops sub-second precision, which would not survive the round trip', function () {
            const now = moment.utc('2026-08-01T12:00:00.837Z');
            const { expiry } = buildActivationToken('Someone', SECRET, now);

            expect(expiry.getUTCMilliseconds()).toBe(0);
        });

        // Why the resend cooldown is load-bearing for more than abuse: the
        // token is an HMAC over an expiry truncated to the second, so re-minting
        // inside the same second reproduces the same token and the old link
        // would keep working. The cooldown is what makes a resend actually
        // invalidate the previous link.
        it('reproduces the same token when re-minted within the same second', function () {
            const now = moment.utc('2026-08-01T12:00:00.100Z');
            const later = moment.utc('2026-08-01T12:00:00.900Z');

            expect(buildActivationToken('Someone', SECRET, now).token).toBe(
                buildActivationToken('Someone', SECRET, later).token
            );
        });

        it('produces a new token once a second has passed', function () {
            const now = moment.utc('2026-08-01T12:00:00Z');
            const later = moment.utc('2026-08-01T12:00:01Z');

            expect(buildActivationToken('Someone', SECRET, now).token).not.toBe(
                buildActivationToken('Someone', SECRET, later).token
            );
        });

        it('gives different users different tokens', function () {
            const now = moment.utc('2026-08-01T12:00:00Z');

            expect(buildActivationToken('Alice', SECRET, now).token).not.toBe(
                buildActivationToken('Bob', SECRET, now).token
            );
        });

        it('gives different secrets different tokens', function () {
            const now = moment.utc('2026-08-01T12:00:00Z');

            expect(buildActivationToken('Alice', SECRET, now).token).not.toBe(
                buildActivationToken('Alice', 'another-secret', now).token
            );
        });
    });

    describe('verifyActivationToken', function () {
        it('accepts a token it just minted', function () {
            const { token, expiry } = buildActivationToken('Someone', SECRET);

            expect(verifyActivationToken('Someone', expiry, token, SECRET)).toBe(true);
        });

        // The important one: the verifier reads the expiry back out of the
        // database, so the token has to survive whatever the driver hands
        // back. node-postgres returns a local-zone Date for `timestamp`.
        it('accepts a token after the expiry has round-tripped through a Date', function () {
            const { token, expiry } = buildActivationToken('Someone', SECRET);
            const asStoredAndRead = new Date(expiry.getTime());

            expect(verifyActivationToken('Someone', asStoredAndRead, token, SECRET)).toBe(true);
        });

        it('accepts a token when the expiry comes back as an ISO string', function () {
            const { token, expiry } = buildActivationToken('Someone', SECRET);

            expect(verifyActivationToken('Someone', expiry.toISOString(), token, SECRET)).toBe(
                true
            );
        });

        it('rejects a token minted for a different username', function () {
            const now = moment.utc('2026-08-01T12:00:00Z');
            const alice = buildActivationToken('Alice', SECRET, now);

            expect(verifyActivationToken('Bob', alice.expiry, alice.token, SECRET)).toBe(false);
        });

        it('rejects a token bound to a different expiry', function () {
            const { token } = buildActivationToken('Someone', SECRET);
            const otherExpiry = moment.utc().add(3, 'days').startOf('second').toDate();

            expect(verifyActivationToken('Someone', otherExpiry, token, SECRET)).toBe(false);
        });

        it('rejects a token minted under a different secret', function () {
            const { token, expiry } = buildActivationToken('Someone', 'old-secret');

            expect(verifyActivationToken('Someone', expiry, token, SECRET)).toBe(false);
        });

        it('rejects a tampered token of the right length', function () {
            const { token, expiry } = buildActivationToken('Someone', SECRET);
            const flipped = (token[0] === 'a' ? 'b' : 'a') + token.slice(1);

            expect(flipped.length).toBe(token.length);
            expect(verifyActivationToken('Someone', expiry, flipped, SECRET)).toBe(false);
        });

        // timingSafeEqual throws on a length mismatch, so a short or missing
        // token must be handled before it gets there or the endpoint 500s.
        it('rejects a short, empty, missing or non-string token without throwing', function () {
            const { expiry } = buildActivationToken('Someone', SECRET);

            for (const bad of ['', 'abc', undefined, null, 12345, {}]) {
                expect(verifyActivationToken('Someone', expiry, bad, SECRET)).toBe(false);
            }
        });
    });

    describe('isActivationExpired', function () {
        const expiry = moment.utc('2026-08-08T12:00:00Z').toDate();

        it('is false before the expiry', function () {
            expect(isActivationExpired(expiry, moment.utc('2026-08-08T11:59:59Z'))).toBe(false);
        });

        // The bug: the caller compared the stored value to a moment with `<`.
        // Both sides coerce to numbers, the stored format gave NaN, and every
        // comparison with NaN is false - so no token ever expired.
        it('is true after the expiry', function () {
            expect(isActivationExpired(expiry, moment.utc('2026-08-08T12:00:01Z'))).toBe(true);
        });

        it('treats an unparseable expiry as expired', function () {
            expect(isActivationExpired('20260808-16:07:57')).toBe(true);
            expect(isActivationExpired(null)).toBe(true);
            expect(isActivationExpired(undefined)).toBe(true);
        });
    });

    describe('resendCooldownRemaining', function () {
        it('is the full cooldown for a token minted just now', function () {
            const now = moment.utc('2026-08-01T12:00:00Z');
            const { expiry } = buildActivationToken('Someone', SECRET, now);

            expect(resendCooldownRemaining(expiry, now)).toBeCloseTo(
                ACTIVATION_RESEND_COOLDOWN_MINUTES,
                5
            );
        });

        it('counts down as time passes', function () {
            const now = moment.utc('2026-08-01T12:00:00Z');
            const { expiry } = buildActivationToken('Someone', SECRET, now);

            expect(resendCooldownRemaining(expiry, now.clone().add(2, 'minutes'))).toBeCloseTo(
                ACTIVATION_RESEND_COOLDOWN_MINUTES - 2,
                5
            );
        });

        it('is zero once the cooldown has elapsed', function () {
            const now = moment.utc('2026-08-01T12:00:00Z');
            const { expiry } = buildActivationToken('Someone', SECRET, now);
            const later = now.clone().add(ACTIVATION_RESEND_COOLDOWN_MINUTES + 1, 'minutes');

            expect(resendCooldownRemaining(expiry, later)).toBe(0);
        });

        it('never reports a negative wait', function () {
            const now = moment.utc('2026-08-01T12:00:00Z');
            const { expiry } = buildActivationToken('Someone', SECRET, now);

            expect(resendCooldownRemaining(expiry, now.clone().add(6, 'days'))).toBe(0);
        });

        // A row written before the fix has an unparseable expiry. Blocking the
        // resend would leave that account permanently stuck, which is the exact
        // failure the resend endpoint exists to prevent.
        it('lets a resend through when the stored expiry cannot be parsed', function () {
            expect(resendCooldownRemaining('20260808-16:07:57')).toBe(0);
            expect(resendCooldownRemaining(null)).toBe(0);
        });
    });

    describe('activationExpiryString', function () {
        it('renders UTC to the second', function () {
            expect(activationExpiryString(moment.utc('2026-08-08T16:07:57.123Z'))).toBe(
                '20260808-16:07:57'
            );
        });

        it('normalises a zoned input to UTC, so the zone cannot change the token', function () {
            expect(activationExpiryString('2026-08-08T18:07:57+02:00')).toBe('20260808-16:07:57');
        });
    });
});
