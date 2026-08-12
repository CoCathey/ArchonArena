const logger = require('../../log');
const { membershipFromDbRow } = require('./mapRow');
const { TIER_IDS, tierFromPatreonMembership, tierById } = require('./tiers');
const { resolveEntitlements, anonymousEntitlements } = require('./entitlements');

/**
 * ARCHON (N12): reads and writes the Memberships table, and turns a provider's
 * answer into a stored membership.
 *
 * The split that matters: this service knows about Patreon, and
 * `entitlements.js` does not. Patreon says "this person is an active patron of
 * the Archon tier"; this service records that; the resolver decides what it
 * unlocks. Nothing downstream of here ever sees a Patreon response, which is
 * what keeps application permissions from being coupled to a third party's
 * schema.
 *
 * Every read is fail-open-to-free: if the table is missing or the query fails,
 * an account resolves to free rather than throwing. A database hiccup should
 * cost a paying member their premium panels for one request, not log them out
 * or 500 the site - and an admin still gets everything, because the override
 * runs before any of this is consulted.
 */
class MembershipService {
    constructor(db = require('../../db')) {
        this.db = db;
    }

    /**
     * The raw membership row for a user, or null.
     *
     * @param {number} userId
     * @returns {Promise<object|null>}
     */
    async getMembership(userId) {
        if (!userId) {
            return null;
        }

        let rows;

        try {
            rows = await this.db.query('SELECT * FROM "Memberships" WHERE "UserId" = $1', [userId]);
        } catch (err) {
            logger.error('Failed to read membership for user %s: %s', userId, err.message);

            return null;
        }

        return rows && rows.length ? this.mapRow(rows[0]) : null;
    }

    /** DB row -> the shape `resolveEntitlements` expects. Shared with UserService. */
    mapRow(row) {
        return membershipFromDbRow(row);
    }

    /**
     * What a user may use. The one call the rest of the server makes.
     *
     * @param {object} user a user with `.id` and `.permissions`
     * @returns {Promise<import('./entitlements').Entitlements>}
     */
    async getEntitlements(user) {
        if (!user) {
            return anonymousEntitlements();
        }

        // An admin needs no database round trip at all: the override does not
        // read the membership, so asking for it would be latency spent on a
        // value that cannot change the answer. This also means an admin still
        // has full access when the Memberships table is unreachable, or does
        // not exist yet because the migration has not been run.
        if (user.permissions && user.permissions.isAdmin) {
            return resolveEntitlements({ user });
        }

        const membership = await this.getMembership(user.id);

        return resolveEntitlements({ user, membership });
    }

    /**
     * Record what a provider told us about a member.
     *
     * Upsert rather than insert-or-update-by-hand so a first sync and a
     * hundredth are the same statement. Manual grant columns are deliberately
     * untouched: a comp is ours, not the provider's, and a Patreon sync must
     * never clear one.
     *
     * @param {number} userId
     * @param {object} params
     */
    async recordProviderMembership(
        userId,
        { provider, externalId, tier, status, startedAt, expiresAt }
    ) {
        if (!userId) {
            return null;
        }

        const safeTier = tierById(tier) ? tier : TIER_IDS.FREE;

        try {
            await this.db.query(
                'INSERT INTO "Memberships" ' +
                    '("UserId", "Provider", "ExternalId", "Tier", "Status", "StartedAt", "ExpiresAt", "LastSyncedAt", "UpdatedAt") ' +
                    "VALUES ($1, $2, $3, $4, $5, $6, $7, now() AT TIME ZONE 'utc', now() AT TIME ZONE 'utc') " +
                    'ON CONFLICT ("UserId") DO UPDATE SET ' +
                    '"Provider" = EXCLUDED."Provider", "ExternalId" = EXCLUDED."ExternalId", ' +
                    '"Tier" = EXCLUDED."Tier", "Status" = EXCLUDED."Status", ' +
                    '"StartedAt" = COALESCE(EXCLUDED."StartedAt", "Memberships"."StartedAt"), ' +
                    '"ExpiresAt" = EXCLUDED."ExpiresAt", ' +
                    '"LastSyncedAt" = EXCLUDED."LastSyncedAt", "UpdatedAt" = EXCLUDED."UpdatedAt"',
                [
                    userId,
                    provider || null,
                    externalId || null,
                    safeTier,
                    status || null,
                    startedAt || null,
                    expiresAt || null
                ]
            );
        } catch (err) {
            logger.error('Failed to record membership for user %s: %s', userId, err.message);

            return null;
        }

        return this.getMembership(userId);
    }

    /**
     * Translate a Patreon membership into a stored one.
     *
     * `membership` is what PatreonService.getMembershipForUser returns. The
     * mapping from Patreon's tier titles/amounts to ours lives in tiers.js;
     * this only decides what "still paying" means.
     *
     * @param {number} userId
     * @param {{status: string, tiers?: object[], amountCents?: number|null}} patreonMembership
     */
    async syncFromPatreon(userId, patreonMembership) {
        const pledged = patreonMembership && patreonMembership.status === 'pledged';
        const tier = pledged ? tierFromPatreonMembership(patreonMembership) : TIER_IDS.FREE;

        return this.recordProviderMembership(userId, {
            provider: 'patreon',
            externalId: (patreonMembership && patreonMembership.externalId) || null,
            tier,
            // 'linked' (connected, not pledging) and 'none' both mean not
            // paying. Recorded rather than deleted so the admin view can tell
            // "lapsed" from "never subscribed".
            status: pledged ? 'active' : 'expired',
            startedAt: null,
            expiresAt: (patreonMembership && patreonMembership.expiresAt) || null
        });
    }

    /**
     * Comp a tier to an account: contributors, beta testers, promotions,
     * apologies. `until` null means indefinite.
     *
     * @param {number} userId
     * @param {{tier: string|null, until?: Date|string|null, grantedBy?: number, reason?: string}} params
     */
    async grantComplimentary(userId, { tier, until = null, grantedBy = null, reason = null }) {
        // A null tier revokes the grant without touching the paid membership.
        const safeTier = tier && tierById(tier) ? tier : null;

        try {
            await this.db.query(
                'INSERT INTO "Memberships" ' +
                    '("UserId", "GrantedTier", "GrantedUntil", "GrantedBy", "GrantedReason", "UpdatedAt") ' +
                    "VALUES ($1, $2, $3, $4, $5, now() AT TIME ZONE 'utc') " +
                    'ON CONFLICT ("UserId") DO UPDATE SET ' +
                    '"GrantedTier" = EXCLUDED."GrantedTier", "GrantedUntil" = EXCLUDED."GrantedUntil", ' +
                    '"GrantedBy" = EXCLUDED."GrantedBy", "GrantedReason" = EXCLUDED."GrantedReason", ' +
                    '"UpdatedAt" = EXCLUDED."UpdatedAt"',
                [userId, safeTier, until || null, grantedBy || null, reason || null]
            );
        } catch (err) {
            logger.error('Failed to grant membership to user %s: %s', userId, err.message);

            throw new Error('Failed to grant membership');
        }

        return this.getMembership(userId);
    }

    /**
     * Members by effective tier, for the admin view.
     *
     * Resolution happens in code rather than SQL on purpose: the precedence
     * rules (grant vs provider, expiry, legacy role) live in one function, and
     * a second copy of them in a query is a second thing to keep correct.
     */
    async listMembers({ limit = 200 } = {}) {
        let rows;

        try {
            rows = await this.db.query(
                'SELECT m.*, u."Username" FROM "Memberships" m ' +
                    'JOIN "Users" u ON u."Id" = m."UserId" ' +
                    'ORDER BY m."UpdatedAt" DESC LIMIT $1',
                [Math.min(Number(limit) || 200, 1000)]
            );
        } catch (err) {
            logger.error('Failed to list members: %s', err.message);

            return [];
        }

        return (rows || []).map((row) => {
            const membership = this.mapRow(row);
            const entitlements = resolveEntitlements({ user: { permissions: {} }, membership });

            return {
                userId: row.UserId,
                username: row.Username,
                provider: membership.provider,
                tier: entitlements.tierId,
                tierName: entitlements.tierName,
                status: membership.status,
                complimentary: entitlements.complimentary,
                grantedTier: membership.grantedTier,
                grantedUntil: membership.grantedUntil,
                grantedReason: membership.grantedReason,
                expiresAt: membership.expiresAt,
                lastSyncedAt: membership.lastSyncedAt
            };
        });
    }
}

module.exports = MembershipService;
