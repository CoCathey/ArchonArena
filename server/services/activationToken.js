const crypto = require('crypto');
const moment = require('moment');

/**
 * ARCHON: minting and checking account-activation tokens.
 *
 * This lives on its own because the format is the whole problem. A token is an
 * HMAC over the username *and the expiry*, so minting and verification have to
 * agree exactly on how that expiry is rendered - and on what gets stored in
 * Users.ActivationTokenExpiry, which the verifier reads back out of the
 * database. When those three disagreed, activation was broken in three
 * separate ways at once (see the individual comments below). One module means
 * they cannot drift apart again, and means the round trip can actually be
 * tested.
 */

const ACTIVATION_VALID_DAYS = 7;

/**
 * The shortest gap between two activation emails to the same account.
 *
 * The per-IP rate limit on the resend endpoint bounds what one client can ask
 * for, but it does not bound what lands in a *victim's* inbox: an attacker who
 * knows an unverified username can rotate IPs and use the resend endpoint to
 * mail-bomb whoever owns that address. This caps it per account, which is the
 * thing that actually needs protecting.
 */
const ACTIVATION_RESEND_COOLDOWN_MINUTES = 5;

/**
 * The canonical rendering of an expiry, as it appears inside the HMAC.
 *
 * Deliberately to the second. The value makes a round trip through a
 * PostgreSQL `timestamp` column between minting and verification, and anything
 * finer than a second is not guaranteed to survive it unchanged - if it did
 * not, every token would fail to verify.
 */
const activationExpiryString = (value) => moment.utc(value).format('YYYYMMDD-HH:mm:ss');

/**
 * Mint a token for a username.
 *
 * Returns the expiry as a `Date`. It used to be stored as the formatted string
 * above, which PostgreSQL cannot parse as a timestamp - so the INSERT threw and
 * registration failed outright the moment activation was switched on.
 *
 * @param {string} username
 * @param {string} hmacSecret
 * @param {moment.Moment} [now] injectable clock, for tests
 * @returns {{ token: string, expiry: Date }}
 */
const buildActivationToken = (username, hmacSecret, now) => {
    // startOf('second') so the value written to the database is exactly the
    // value the token was derived from, with no milliseconds to lose.
    const expiry = (now ? now.clone() : moment().utc())
        .add(ACTIVATION_VALID_DAYS, 'days')
        .startOf('second');

    const token = crypto
        .createHmac('sha512', hmacSecret)
        .update(`ACTIVATE ${username} ${activationExpiryString(expiry)}`)
        .digest('hex');

    return { token, expiry: expiry.toDate() };
};

/**
 * Whether a stored expiry has passed.
 *
 * The caller used to do `user.activationTokenExpiry < moment()`. Relational
 * comparison coerces both sides to numbers; the stored value gave NaN, and
 * every comparison with NaN is false - so the check never fired once and
 * activation links never expired at all.
 *
 * An unparseable value counts as expired: a token whose expiry cannot be read
 * cannot be verified either, since the expiry is part of the HMAC.
 *
 * @param {Date|string} expiryValue
 * @param {moment.Moment} [now] injectable clock, for tests
 */
const isActivationExpired = (expiryValue, now) => {
    // Explicitly, before moment sees it: moment.utc(undefined) is *the current
    // time*, not an invalid date, so a row with no expiry at all would come
    // back "expires right now" and land either side of the comparison
    // depending on the clock. A missing expiry is not a valid one.
    if (expiryValue === null || expiryValue === undefined || expiryValue === '') {
        return true;
    }

    const expiry = moment.utc(expiryValue);

    if (!expiry.isValid()) {
        return true;
    }

    return expiry.isBefore(now || moment().utc());
};

/**
 * Recompute the token for a stored (username, expiry) pair and compare it in
 * constant time. A plain `!==` leaks how much of the token matched through the
 * response time, which is enough to forge one a byte at a time.
 *
 * @param {string} username
 * @param {Date|string} expiryValue the expiry as read back from the database
 * @param {string} providedToken
 * @param {string} hmacSecret
 */
const verifyActivationToken = (username, expiryValue, providedToken, hmacSecret) => {
    const expected = Buffer.from(
        crypto
            .createHmac('sha512', hmacSecret)
            .update(`ACTIVATE ${username} ${activationExpiryString(expiryValue)}`)
            .digest('hex')
    );
    const provided = Buffer.from(String(providedToken == null ? '' : providedToken));

    // Lengths first: timingSafeEqual throws on a length mismatch. The length of
    // a sha512 hex digest is fixed and public, so this leaks nothing.
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
};

/**
 * Minutes still to wait before this account may be sent another activation
 * mail, or 0 if it may be sent one now.
 *
 * Every token is minted as `now + ACTIVATION_VALID_DAYS`, so subtracting that
 * back off the stored expiry recovers when it was issued - no separate "last
 * sent" column needed.
 *
 * @param {Date|string} expiryValue
 * @param {moment.Moment} [now] injectable clock, for tests
 */
const resendCooldownRemaining = (expiryValue, now) => {
    const expiry = moment.utc(expiryValue);

    if (!expiry.isValid()) {
        // An unparseable expiry means the row predates the fix. Let the resend
        // through - it replaces the broken value with a good one.
        return 0;
    }

    const issuedAt = expiry.clone().subtract(ACTIVATION_VALID_DAYS, 'days');
    const elapsed = (now || moment().utc()).diff(issuedAt, 'minutes', true);

    return Math.max(0, ACTIVATION_RESEND_COOLDOWN_MINUTES - elapsed);
};

module.exports = {
    ACTIVATION_VALID_DAYS,
    ACTIVATION_RESEND_COOLDOWN_MINUTES,
    activationExpiryString,
    buildActivationToken,
    isActivationExpired,
    verifyActivationToken,
    resendCooldownRemaining
};
