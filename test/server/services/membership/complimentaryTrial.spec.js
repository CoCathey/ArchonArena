const { resolveEntitlements } = require('../../../../server/services/membership/entitlements');
const { TIER_IDS } = require('../../../../server/services/membership/tiers');
const { CAPABILITIES } = require('../../../../server/services/membership/capabilities');

/**
 * ARCHON (N37): a seven-day Vault Master trial, as the admin screen makes one.
 *
 * The grant mechanism is older than the button - what these pin is that the
 * shape the button sends actually produces the tier, expires on its own, and
 * never damages a real membership underneath. The last one is the reason grants
 * live in their own columns, and it is the failure nobody would notice until a
 * paying member's tier vanished when a comp was revoked.
 */
const DAYS = 7;
const NOW = new Date('2026-08-17T12:00:00Z');

const inDays = (days, from = NOW) => {
    const date = new Date(from);

    date.setDate(date.getDate() + days);

    return date;
};

const trial = (overrides = {}) => ({
    grantedTier: TIER_IDS.VAULT_MASTER,
    grantedUntil: inDays(DAYS),
    ...overrides
});

const free = { permissions: {} };

describe('a complimentary Vault Master trial', function () {
    it('gives the tier and the Champion’s Challenge with it', function () {
        const entitlements = resolveEntitlements({ user: free, membership: trial(), now: NOW });

        expect(entitlements.tierId).toBe(TIER_IDS.VAULT_MASTER);
        expect(entitlements.capabilities).toContain(CAPABILITIES.CHAMPIONS_CHALLENGE);
        // Flagged as comped, so the member's own page can say where it came
        // from rather than implying they paid.
        expect(entitlements.complimentary).toBe(true);
        expect(entitlements.source).toBe('grant');
    });

    it('tells the member when it runs out', function () {
        const entitlements = resolveEntitlements({ user: free, membership: trial(), now: NOW });

        expect(entitlements.expiresAt).toBe(inDays(DAYS).toISOString());
    });

    it('lapses on its own, with nothing to clean up', function () {
        const entitlements = resolveEntitlements({
            user: free,
            membership: trial(),
            now: inDays(DAYS + 1)
        });

        expect(entitlements.tierId).toBe(TIER_IDS.FREE);
        expect(entitlements.capabilities).not.toContain(CAPABILITIES.CHAMPIONS_CHALLENGE);
    });

    it('is still live on its last day', function () {
        const entitlements = resolveEntitlements({
            user: free,
            membership: trial(),
            now: inDays(DAYS - 1)
        });

        expect(entitlements.tierId).toBe(TIER_IDS.VAULT_MASTER);
    });

    it('does not demote somebody who already pays for more', function () {
        // A comp is a floor, not an assignment. Handing a Vault Master a
        // Supporter comp must not cost them what they pay for.
        const entitlements = resolveEntitlements({
            user: free,
            membership: {
                grantedTier: TIER_IDS.SUPPORTER,
                grantedUntil: inDays(DAYS),
                tier: TIER_IDS.VAULT_MASTER,
                status: 'active',
                expiresAt: inDays(30)
            },
            now: NOW
        });

        expect(entitlements.tierId).toBe(TIER_IDS.VAULT_MASTER);
    });

    it('leaves the paid membership intact when the comp is revoked', function () {
        // What the Revoke button sends: tier null, everything else untouched.
        const entitlements = resolveEntitlements({
            user: free,
            membership: {
                grantedTier: null,
                grantedUntil: null,
                tier: TIER_IDS.ARCHON,
                status: 'active',
                expiresAt: inDays(30)
            },
            now: NOW
        });

        expect(entitlements.tierId).toBe(TIER_IDS.ARCHON);
        expect(entitlements.complimentary).toBe(false);
    });

    it('can be open-ended, for a contributor rather than a trial', function () {
        const entitlements = resolveEntitlements({
            user: free,
            membership: trial({ grantedUntil: null }),
            now: inDays(4000)
        });

        expect(entitlements.tierId).toBe(TIER_IDS.VAULT_MASTER);
        expect(entitlements.expiresAt).toBeNull();
    });

    it('outranks a lapsed provider membership rather than being masked by it', function () {
        const entitlements = resolveEntitlements({
            user: free,
            membership: trial({
                tier: TIER_IDS.ARCHON,
                status: 'none',
                expiresAt: inDays(-30)
            }),
            now: NOW
        });

        expect(entitlements.tierId).toBe(TIER_IDS.VAULT_MASTER);
    });
});
