const {
    resolveEntitlements,
    can,
    anonymousEntitlements
} = require('../../../../server/services/membership/entitlements');
const {
    CAPABILITIES,
    ALL_CAPABILITIES
} = require('../../../../server/services/membership/capabilities');
const { TIER_IDS, HIGHEST_TIER } = require('../../../../server/services/membership/tiers');

describe('entitlements', function () {
    const NOW = new Date('2026-06-01T00:00:00Z');
    const later = (days) => new Date(NOW.getTime() + days * 86400000);
    const earlier = (days) => new Date(NOW.getTime() - days * 86400000);

    const user = (permissions = {}) => ({ username: 'alice', permissions });

    describe('the admin override', function () {
        // The stated requirement: admins have everything, always, whatever the
        // membership data says. Each of these is a way that could break.
        const adminCases = {
            'with no membership row at all': undefined,
            'with no Patreon connected': { provider: null, tier: null, status: null },
            'with an explicitly free membership': { tier: TIER_IDS.FREE, status: 'active' },
            'with an expired membership': {
                tier: TIER_IDS.ARCHON,
                status: 'expired',
                expiresAt: earlier(30)
            },
            'with a cancelled membership': { tier: TIER_IDS.VAULT_MASTER, status: 'cancelled' },
            'with garbage in the tier column': { tier: 'not-a-real-tier', status: 'active' },
            'with garbage in the status column': { tier: TIER_IDS.ARCHON, status: '???' },
            'with a null tier and active status': { tier: null, status: 'active' },
            'with an expiry in the past on a grant': {
                grantedTier: TIER_IDS.SUPPORTER,
                grantedUntil: earlier(1)
            }
        };

        for (const [description, membership] of Object.entries(adminCases)) {
            it(`grants every capability to an admin ${description}`, function () {
                const result = resolveEntitlements({
                    user: user({ isAdmin: true }),
                    membership,
                    now: NOW
                });

                expect(result.isAdmin).toBe(true);
                expect(result.tierId).toBe(HIGHEST_TIER.id);
                // Every capability, not a list that has to be kept in sync.
                expect(result.capabilities.sort()).toEqual([...ALL_CAPABILITIES].sort());

                for (const capability of ALL_CAPABILITIES) {
                    expect(can(result, capability)).toBe(true);
                }
            });
        }

        it('covers a capability added in future without touching this file', function () {
            // The override returns ALL_CAPABILITIES by reference to the
            // catalogue, so anything added there is admin-accessible on the
            // day it is added. This asserts the derivation, not a snapshot.
            const result = resolveEntitlements({ user: user({ isAdmin: true }), now: NOW });

            expect(result.capabilities).toHaveLength(ALL_CAPABILITIES.length);
        });
    });

    describe('free accounts', function () {
        it('gives a logged-out visitor nothing', function () {
            const result = anonymousEntitlements();

            expect(result.tierId).toBe(TIER_IDS.FREE);
            expect(result.capabilities).toEqual([]);
            expect(can(result, CAPABILITIES.ARCHON_INTELLIGENCE)).toBe(false);
        });

        it('gives a registered free player nothing premium', function () {
            const result = resolveEntitlements({ user: user(), now: NOW });

            expect(result.tierId).toBe(TIER_IDS.FREE);
            expect(can(result, CAPABILITIES.ELO_HISTORY)).toBe(false);
            expect(can(result, CAPABILITIES.ARCHON_INTELLIGENCE)).toBe(false);
        });
    });

    describe('paid tiers', function () {
        const active = (tier) => ({
            provider: 'patreon',
            tier,
            status: 'active',
            expiresAt: later(30)
        });

        it('gives Supporter the supporter capabilities but not Archon ones', function () {
            const result = resolveEntitlements({
                user: user(),
                membership: active(TIER_IDS.SUPPORTER),
                now: NOW
            });

            expect(result.tierId).toBe(TIER_IDS.SUPPORTER);
            expect(can(result, CAPABILITIES.ELO_HISTORY)).toBe(true);
            expect(can(result, CAPABILITIES.ADVANCED_DECK_STATS)).toBe(true);
            expect(can(result, CAPABILITIES.ARCHON_INTELLIGENCE)).toBe(false);
            expect(can(result, CAPABILITIES.TOURNAMENT_LAB)).toBe(false);
        });

        it('gives Archon everything Supporter has, plus its own', function () {
            const result = resolveEntitlements({
                user: user(),
                membership: active(TIER_IDS.ARCHON),
                now: NOW
            });

            // Cumulative: the lower tier's capabilities come along.
            expect(can(result, CAPABILITIES.ELO_HISTORY)).toBe(true);
            expect(can(result, CAPABILITIES.ARCHON_INTELLIGENCE)).toBe(true);
            expect(can(result, CAPABILITIES.TOURNAMENT_LAB)).toBe(true);
            expect(can(result, CAPABILITIES.EXPERIMENTAL_FEATURES)).toBe(false);
        });

        it('gives Vault Master everything', function () {
            const result = resolveEntitlements({
                user: user(),
                membership: active(TIER_IDS.VAULT_MASTER),
                now: NOW
            });

            expect(result.capabilities.sort()).toEqual([...ALL_CAPABILITIES].sort());
            expect(result.isAdmin).toBe(false);
        });
    });

    describe('expiry and status', function () {
        it('drops a membership whose expiry has passed', function () {
            const result = resolveEntitlements({
                user: user(),
                membership: {
                    provider: 'patreon',
                    tier: TIER_IDS.ARCHON,
                    status: 'active',
                    expiresAt: earlier(1)
                },
                now: NOW
            });

            expect(result.tierId).toBe(TIER_IDS.FREE);
        });

        it('drops a membership whose status is no longer active', function () {
            const result = resolveEntitlements({
                user: user(),
                membership: { provider: 'patreon', tier: TIER_IDS.ARCHON, status: 'declined' },
                now: NOW
            });

            expect(result.tierId).toBe(TIER_IDS.FREE);
        });

        it('keeps a membership with no expiry recorded', function () {
            // Patreon does not always give a next-charge date; absent must not
            // read as expired or every such member loses access.
            const result = resolveEntitlements({
                user: user(),
                membership: { provider: 'patreon', tier: TIER_IDS.ARCHON, status: 'active' },
                now: NOW
            });

            expect(result.tierId).toBe(TIER_IDS.ARCHON);
        });
    });

    describe('manual grants', function () {
        it('comps access with no provider membership at all', function () {
            const result = resolveEntitlements({
                user: user(),
                membership: { grantedTier: TIER_IDS.ARCHON, grantedUntil: later(30) },
                now: NOW
            });

            expect(result.tierId).toBe(TIER_IDS.ARCHON);
            expect(result.complimentary).toBe(true);
            expect(result.source).toBe('grant');
        });

        it('never demotes someone who pays for more than they were comped', function () {
            const result = resolveEntitlements({
                user: user(),
                membership: {
                    provider: 'patreon',
                    tier: TIER_IDS.VAULT_MASTER,
                    status: 'active',
                    grantedTier: TIER_IDS.SUPPORTER,
                    grantedUntil: later(30)
                },
                now: NOW
            });

            expect(result.tierId).toBe(TIER_IDS.VAULT_MASTER);
        });

        it('keeps the comp when it beats the paid tier', function () {
            const result = resolveEntitlements({
                user: user(),
                membership: {
                    provider: 'patreon',
                    tier: TIER_IDS.SUPPORTER,
                    status: 'active',
                    grantedTier: TIER_IDS.VAULT_MASTER,
                    grantedUntil: later(30)
                },
                now: NOW
            });

            expect(result.tierId).toBe(TIER_IDS.VAULT_MASTER);
        });

        it('lets a time-boxed beta grant lapse', function () {
            const result = resolveEntitlements({
                user: user(),
                membership: { grantedTier: TIER_IDS.VAULT_MASTER, grantedUntil: earlier(1) },
                now: NOW
            });

            expect(result.tierId).toBe(TIER_IDS.FREE);
        });
    });

    describe('accounts predating the membership system', function () {
        it('treats the legacy Supporter role as Supporter', function () {
            // Turning this system on must not silently downgrade the people who
            // were already supporting the site.
            const result = resolveEntitlements({
                user: user({ isSupporter: true }),
                now: NOW
            });

            expect(result.tierId).toBe(TIER_IDS.SUPPORTER);
            expect(can(result, CAPABILITIES.ELO_HISTORY)).toBe(true);
        });

        it('honours keepsSupporterWithNoPatreon', function () {
            const result = resolveEntitlements({
                user: user({ keepsSupporterWithNoPatreon: true }),
                now: NOW
            });

            expect(result.tierId).toBe(TIER_IDS.SUPPORTER);
            expect(result.complimentary).toBe(true);
        });

        it('does not let the legacy role downgrade a higher paid tier', function () {
            const result = resolveEntitlements({
                user: user({ isSupporter: true }),
                membership: { provider: 'patreon', tier: TIER_IDS.ARCHON, status: 'active' },
                now: NOW
            });

            expect(result.tierId).toBe(TIER_IDS.ARCHON);
        });
    });

    // ARCHON (N20): every new account's first fortnight runs on the Archon
    // tier's tools. The trial is resolved, never stored, so these pin the
    // date arithmetic that IS the feature.
    describe('the new-player trial', function () {
        const newPlayer = (daysSinceRegistering, permissions = {}) => ({
            username: 'alice',
            permissions,
            registered: earlier(daysSinceRegistering)
        });

        it('gives a fresh account the Archon tier, marked as the trial', function () {
            const result = resolveEntitlements({ user: newPlayer(3), now: NOW });

            expect(result.tierId).toBe(TIER_IDS.ARCHON);
            expect(result.source).toBe('new-player-trial');
            expect(result.complimentary).toBe(true);
            // Ends exactly 15 days after registration, not 15 days from now.
            expect(result.expiresAt).toBe(later(12).toISOString());
            expect(can(result, CAPABILITIES.ARCHON_INTELLIGENCE)).toBe(true);
            // Archon, not Vault Master: the trial stops one tier short.
            expect(can(result, CAPABILITIES.CHAMPIONS_CHALLENGE)).toBe(false);
        });

        it('ends on day fifteen, to the millisecond', function () {
            const result = resolveEntitlements({ user: newPlayer(15), now: NOW });

            expect(result.tierId).toBe(TIER_IDS.FREE);
            expect(can(result, CAPABILITIES.ARCHON_INTELLIGENCE)).toBe(false);
        });

        it('never downgrades a new player who already pays for more', function () {
            const result = resolveEntitlements({
                user: newPlayer(2),
                membership: {
                    provider: 'patreon',
                    tier: TIER_IDS.VAULT_MASTER,
                    status: 'active',
                    expiresAt: later(30)
                },
                now: NOW
            });

            expect(result.tierId).toBe(TIER_IDS.VAULT_MASTER);
            expect(result.source).toBe('patreon');
        });

        it('outranks a paid Supporter until it lapses back to what they pay for', function () {
            const supporter = {
                provider: 'patreon',
                tier: TIER_IDS.SUPPORTER,
                status: 'active',
                expiresAt: later(90)
            };

            const during = resolveEntitlements({
                user: newPlayer(5),
                membership: supporter,
                now: NOW
            });

            expect(during.tierId).toBe(TIER_IDS.ARCHON);
            expect(during.source).toBe('new-player-trial');

            const after = resolveEntitlements({
                user: newPlayer(20),
                membership: supporter,
                now: NOW
            });

            expect(after.tierId).toBe(TIER_IDS.SUPPORTER);
            expect(after.source).toBe('patreon');
        });

        it('grants nothing from a registration date it cannot read', function () {
            const result = resolveEntitlements({
                user: { username: 'alice', permissions: {}, registered: 'not a date' },
                now: NOW
            });

            expect(result.tierId).toBe(TIER_IDS.FREE);
        });
    });

    describe('can()', function () {
        it('refuses an unknown capability loudly outside production', function () {
            // A mistyped gate would otherwise lock a feature for everyone and
            // look like a product decision rather than a bug.
            const result = resolveEntitlements({ user: user({ isAdmin: true }), now: NOW });

            expect(() => can(result, 'archon_inteligence')).toThrow(/Unknown capability/);
        });

        it('returns false for a null entitlement set', function () {
            expect(can(null, CAPABILITIES.ELO_HISTORY)).toBe(false);
        });
    });
});
