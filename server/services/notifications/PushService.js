const logger = require('../../log');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Expo accepts at most 100 messages per request. A round of a 64-player Swiss
 * is 64 messages, so batching is not theoretical.
 */
const MAX_BATCH = 100;

/** Expo's own format check, applied before we spend a request finding out. */
function looksLikeExpoToken(token) {
    return (
        typeof token === 'string' &&
        (/^ExponentPushToken\[[^\]]+\]$/.test(token) || /^ExpoPushToken\[[^\]]+\]$/.test(token))
    );
}

/**
 * ARCHON: push notifications to the mobile app.
 *
 * The notification service decides *whether* a player hears about something;
 * this decides how it reaches a phone. Delivery goes through Expo's push
 * service, which fans out to APNs and FCM - the app is built with EAS, so its
 * tokens are Expo tokens and there are no Apple or Google credentials to hold
 * here.
 *
 * Three things shape this:
 *
 *  - **It must never block or break the thing that raised it.** Same contract
 *    as the rest of the notification path: every method resolves, nothing
 *    throws, failures are logged and dropped. A pairing must commit whether or
 *    not a phone was reachable.
 *  - **A dead token has to be removed, or it is retried forever.** Expo
 *    answers per-message; a `DeviceNotRegistered` error means the app was
 *    uninstalled or the token rotated, and that row is deleted on the spot.
 *  - **No credentials are required.** Expo accepts unauthenticated sends for
 *    tokens it issued. `accessToken` is supported for sites that have enabled
 *    Expo's stricter push security, and is simply absent otherwise.
 *
 * `fetch` and `db` are injectable so the whole thing is testable without a
 * network or a database.
 */
class PushService {
    constructor(db = require('../../db'), options = {}) {
        this.db = db;
        this.fetch = options.fetch || global.fetch;
        this.accessToken = options.accessToken || null;
        this.now = options.now || (() => new Date());
    }

    /** Whether pushes can be sent at all. */
    isConfigured() {
        return typeof this.fetch === 'function';
    }

    /**
     * Record (or move) a device token.
     *
     * Re-registering a token that belongs to another account reassigns it -
     * see the migration. That is what makes signing in as somebody else on a
     * shared phone stop delivering the previous account's notifications.
     */
    async registerToken(userId, token, { platform, deviceName } = {}) {
        if (!userId || !looksLikeExpoToken(token)) {
            return { success: false, message: 'A valid Expo push token is required' };
        }

        try {
            await this.db.query(
                'INSERT INTO "PushTokens" ("UserId", "Token", "Platform", "DeviceName") ' +
                    'VALUES ($1, $2, $3, $4) ' +
                    'ON CONFLICT ("Token") DO UPDATE SET ' +
                    '"UserId" = $1, "Platform" = $3, "DeviceName" = $4, ' +
                    '"LastSeenAt" = now() AT TIME ZONE \'utc\'',
                [userId, token, platform || null, deviceName || null]
            );
        } catch (err) {
            logger.error('Failed to register push token', err);

            return { success: false, message: 'Could not register this device' };
        }

        return { success: true };
    }

    /**
     * Forget a device token. Scoped to the caller so one account cannot
     * unregister another's phone, except on sign-out where the token is the
     * only thing we know - hence `any`.
     */
    async removeToken(userId, token, { any = false } = {}) {
        if (!token) {
            return { success: false, message: 'A token is required' };
        }

        try {
            await this.db.query(
                any
                    ? 'DELETE FROM "PushTokens" WHERE "Token" = $1'
                    : 'DELETE FROM "PushTokens" WHERE "Token" = $1 AND "UserId" = $2',
                any ? [token] : [token, userId]
            );
        } catch (err) {
            logger.error('Failed to remove push token', err);

            return { success: false, message: 'Could not remove this device' };
        }

        return { success: true };
    }

    async tokensFor(userId) {
        try {
            const rows = await this.db.query(
                'SELECT "Token" FROM "PushTokens" WHERE "UserId" = $1',
                [userId]
            );

            return (rows || []).map((row) => row.Token).filter(looksLikeExpoToken);
        } catch (err) {
            logger.warn(`Could not read push tokens for user ${userId}: ${err.message}`);

            return [];
        }
    }

    /**
     * Push one notification to every device an account has registered.
     *
     * @returns {Promise<{sent: number, failed: number, removed: number}>}
     */
    async send({ userId, title, body, url, data, category }) {
        if (!this.isConfigured() || !userId || !title) {
            return { sent: 0, failed: 0, removed: 0 };
        }

        const tokens = await this.tokensFor(userId);

        if (tokens.length === 0) {
            return { sent: 0, failed: 0, removed: 0 };
        }

        const messages = tokens.map((token) => ({
            to: token,
            title,
            body: body || undefined,
            sound: 'default',
            // What the app needs to open the right screen when the
            // notification is tapped.
            data: { url: url || null, category: category || null, ...(data || {}) },
            // Tournament notifications are time-critical by nature; the ones
            // that are not have already been filtered out by the category
            // preference before reaching here.
            priority: 'high',
            channelId: 'default'
        }));

        let sent = 0;
        let failed = 0;
        let removed = 0;

        for (let index = 0; index < messages.length; index += MAX_BATCH) {
            const batch = messages.slice(index, index + MAX_BATCH);
            const outcome = await this.postBatch(batch);

            sent += outcome.sent;
            failed += outcome.failed;
            removed += outcome.removed;
        }

        return { sent, failed, removed };
    }

    /** One request to Expo, and the bookkeeping its answer implies. */
    async postBatch(batch) {
        let payload;

        try {
            const headers = {
                Accept: 'application/json',
                'Content-Type': 'application/json'
            };

            if (this.accessToken) {
                headers.Authorization = `Bearer ${this.accessToken}`;
            }

            const response = await this.fetch(EXPO_PUSH_URL, {
                method: 'POST',
                headers,
                body: JSON.stringify(batch)
            });

            if (!response || !response.ok) {
                logger.warn(
                    `Expo push rejected a batch (HTTP ${
                        response ? response.status : 'no response'
                    })`
                );

                return { sent: 0, failed: batch.length, removed: 0 };
            }

            payload = await response.json();
        } catch (err) {
            // The phone not being reachable is not an error worth raising to
            // the caller - it raised a tournament pairing, not a push.
            logger.warn(`Expo push request failed: ${err.message}`);

            return { sent: 0, failed: batch.length, removed: 0 };
        }

        const tickets = (payload && payload.data) || [];
        let sent = 0;
        let failed = 0;
        const dead = [];

        // Expo answers positionally, one ticket per message in the batch.
        for (let index = 0; index < batch.length; index++) {
            const ticket = tickets[index];

            if (ticket && ticket.status === 'ok') {
                sent++;
                continue;
            }

            failed++;

            if (ticket && ticket.details && ticket.details.error === 'DeviceNotRegistered') {
                dead.push(batch[index].to);
            }
        }

        if (dead.length > 0) {
            await this.forgetTokens(dead);
        }

        return { sent, failed, removed: dead.length };
    }

    /**
     * Delete tokens Expo has told us are dead. Without this every send to a
     * uninstalled app repeats the same doomed request forever.
     */
    async forgetTokens(tokens) {
        try {
            await this.db.query('DELETE FROM "PushTokens" WHERE "Token" = ANY($1)', [tokens]);
        } catch (err) {
            logger.warn(`Could not drop ${tokens.length} dead push tokens: ${err.message}`);
        }
    }
}

module.exports = PushService;
module.exports.looksLikeExpoToken = looksLikeExpoToken;
