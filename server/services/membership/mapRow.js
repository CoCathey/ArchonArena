/**
 * ARCHON (N12): the one translation from a Memberships row to the shape
 * `resolveEntitlements` reads.
 *
 * It exists as its own module because two callers need it - UserService, which
 * loads the row alongside roles so entitlements can resolve synchronously, and
 * MembershipService, which owns the table. Two copies of a PascalCase-to-
 * camelCase mapping is exactly the kind of duplication that ends with one of
 * them missing `GrantedUntil` and comped accounts never expiring.
 *
 * @param {object|null|undefined} row a row from "Memberships"
 * @returns {object|undefined}
 */
function membershipFromDbRow(row) {
    if (!row) {
        return undefined;
    }

    return {
        userId: row.UserId,
        provider: row.Provider,
        externalId: row.ExternalId,
        tier: row.Tier,
        status: row.Status,
        startedAt: row.StartedAt,
        expiresAt: row.ExpiresAt,
        lastSyncedAt: row.LastSyncedAt,
        grantedTier: row.GrantedTier,
        grantedUntil: row.GrantedUntil,
        grantedBy: row.GrantedBy,
        grantedReason: row.GrantedReason
    };
}

module.exports = { membershipFromDbRow };
