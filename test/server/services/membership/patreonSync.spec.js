const MembershipService = require('../../../../server/services/membership/MembershipService');
const { resolveEntitlements } = require('../../../../server/services/membership/entitlements');
const {
    TIER_IDS,
    tierFromPatreonMembership
} = require('../../../../server/services/membership/tiers');
const { CAPABILITIES } = require('../../../../server/services/membership/capabilities');

/**
 * ARCHON (N12): what a Patreon membership becomes, and when it stops counting.
 *
 * The lapse case is the one that matters. Revoking the legacy Supporter ROLE
 * does not touch the Memberships row, and the row is what grants capabilities -
 * so before this sync ran on every auth refresh, a pledge that lapsed left the
 * player with their tier permanently. The roadmap's acceptance criterion is
 * that a lapsed pledge removes access; these tests are that criterion.
 */
describe('Patreon membership sync', function () {
    let rows;
    let db;
    let service;

    const row = (over = {}) => ({
        UserId: 1,
        Provider: 'patreon',
        ExternalId: null,
        Tier: TIER_IDS.ARCHON,
        Status: 'active',
        StartedAt: null,
        ExpiresAt: null,
        LastSyncedAt: new Date(),
        GrantedTier: null,
        GrantedUntil: null,
        GrantedBy: null,
        GrantedReason: null,
        ...over
    });

    beforeEach(function () {
        rows = [];
        db = {
            query: vi.fn(async (sql) => {
                if (/^SELECT \* FROM "Memberships"/.test(sql)) {
                    return rows;
                }

                return [];
            })
        };
        service = new MembershipService(db);
    });

    const writes = () =>
        db.query.mock.calls.filter(([sql]) => /INSERT INTO "Memberships"/.test(sql));

    describe('tier mapping', function () {
        it('maps a Patreon tier title onto ours', function () {
            expect(tierFromPatreonMembership({ tiers: [{ title: 'Archon' }] })).toBe(
                TIER_IDS.ARCHON
            );
            expect(tierFromPatreonMembership({ tiers: [{ title: 'vault master' }] })).toBe(
                TIER_IDS.VAULT_MASTER
            );
        });

        it('is case and spacing tolerant', function () {
            expect(tierFromPatreonMembership({ tiers: [{ title: '  VAULT MASTER ' }] })).toBe(
                TIER_IDS.VAULT_MASTER
            );
        });

        it('falls back to the pledge amount when the title is unrecognised', function () {
            // A creator who renamed their tiers on Patreon still lands people
            // in the right place.
            expect(
                tierFromPatreonMembership({ tiers: [{ title: 'Gold Chungus' }], amountCents: 1000 })
            ).toBe(TIER_IDS.ARCHON);
            expect(tierFromPatreonMembership({ tiers: [], amountCents: 2500 })).toBe(
                TIER_IDS.VAULT_MASTER
            );
        });

        it('takes the best of several entitled tiers', function () {
            expect(
                tierFromPatreonMembership({
                    tiers: [{ title: 'Supporter' }, { title: 'Archon' }]
                })
            ).toBe(TIER_IDS.ARCHON);
        });

        it('does not round a small pledge up to a paid tier', function () {
            expect(tierFromPatreonMembership({ tiers: [], amountCents: 100 })).toBe(TIER_IDS.FREE);
            expect(tierFromPatreonMembership({ tiers: [], amountCents: 0 })).toBe(TIER_IDS.FREE);
        });
    });

    describe('a lapsed pledge', function () {
        it('is written back as expired, not left active', async function () {
            rows = [row({ Tier: TIER_IDS.ARCHON, Status: 'active' })];

            await service.syncFromPatreon(1, { status: 'linked', tiers: [] });

            const [, params] = writes()[0];

            expect(params).toContain(TIER_IDS.FREE);
            expect(params).toContain('expired');
        });

        it('loses its capabilities once written back', function () {
            // The end-to-end consequence: this is what "a lapsed pledge removes
            // access" actually means.
            const stillPaying = resolveEntitlements({
                user: { permissions: {} },
                membership: { tier: TIER_IDS.ARCHON, status: 'active' }
            });
            const lapsed = resolveEntitlements({
                user: { permissions: {} },
                membership: { tier: TIER_IDS.FREE, status: 'expired' }
            });

            expect(stillPaying.capabilities).toContain(CAPABILITIES.ARCHON_INTELLIGENCE);
            expect(lapsed.capabilities).toEqual([]);
        });
    });

    describe('an upgraded pledge', function () {
        it('is written back at the new tier', async function () {
            rows = [row({ Tier: TIER_IDS.SUPPORTER, Status: 'active' })];

            await service.syncFromPatreon(1, {
                status: 'pledged',
                tiers: [{ title: 'Archon' }]
            });

            expect(writes()[0][1]).toContain(TIER_IDS.ARCHON);
        });
    });

    describe('write avoidance', function () {
        it('does not rewrite an unchanged, recently synced membership', async function () {
            // This runs on every auth refresh; an unconditional write would be
            // one per user per token refresh for a value that changes twice a
            // year.
            rows = [row({ Tier: TIER_IDS.ARCHON, Status: 'active', LastSyncedAt: new Date() })];

            await service.syncFromPatreon(1, {
                status: 'pledged',
                tiers: [{ title: 'Archon' }]
            });

            expect(writes()).toHaveLength(0);
        });

        it('does rewrite when the tier changed', async function () {
            rows = [row({ Tier: TIER_IDS.SUPPORTER, Status: 'active', LastSyncedAt: new Date() })];

            await service.syncFromPatreon(1, {
                status: 'pledged',
                tiers: [{ title: 'Archon' }]
            });

            expect(writes()).toHaveLength(1);
        });

        it('rewrites a stale row so LastSyncedAt keeps meaning something', async function () {
            rows = [
                row({
                    Tier: TIER_IDS.ARCHON,
                    Status: 'active',
                    LastSyncedAt: new Date(Date.now() - 3 * 60 * 60 * 1000)
                })
            ];

            await service.syncFromPatreon(1, {
                status: 'pledged',
                tiers: [{ title: 'Archon' }]
            });

            expect(writes()).toHaveLength(1);
        });

        it('writes the first time, when there is no row at all', async function () {
            rows = [];

            await service.syncFromPatreon(1, {
                status: 'pledged',
                tiers: [{ title: 'Supporter' }]
            });

            expect(writes()).toHaveLength(1);
        });
    });

    describe("manual grants are the site's, not the provider's", function () {
        it('a Patreon sync never writes the grant columns', async function () {
            rows = [row({ Tier: TIER_IDS.SUPPORTER, GrantedTier: TIER_IDS.VAULT_MASTER })];

            await service.syncFromPatreon(1, { status: 'linked', tiers: [] });

            const [sql] = writes()[0];

            // A lapsing pledge must not cancel a comp an admin gave someone.
            expect(sql).not.toContain('"GrantedTier"');
            expect(sql).not.toContain('"GrantedUntil"');
        });
    });
});
