const {
    publicBadge,
    permissionsFromRoleNames
} = require('../../../../server/services/membership/publicBadge');
const BadgeService = require('../../../../server/services/membership/BadgeService');
const { TIER_IDS } = require('../../../../server/services/membership/tiers');

/**
 * ARCHON (N12): what other people are allowed to see.
 *
 * The badge is the one part of the membership system that is deliberately
 * public, so the boundary matters more here than anywhere else: it must show
 * enough that supporting the site is visible, and nothing that turns a name
 * into a readout of somebody's billing.
 */
describe('publicBadge', function () {
    const active = (tier) => ({ tier, status: 'active' });

    it('shows nothing for an ordinary free account', function () {
        expect(publicBadge({})).toEqual({ role: 'user', tier: TIER_IDS.FREE, tierName: null });
    });

    it('shows the tier a member actually pays for', function () {
        expect(publicBadge({ membership: active(TIER_IDS.ARCHON) })).toEqual({
            role: 'supporter',
            tier: TIER_IDS.ARCHON,
            tierName: 'Archon'
        });
    });

    it('does NOT give an admin a tier they have not paid for', function () {
        // resolveEntitlements deliberately resolves an admin to the highest
        // tier so every feature opens for them. Rendering that publicly would
        // announce every administrator as a Vault Master patron, which is a
        // claim about money that is not true.
        const badge = publicBadge({ permissions: { isAdmin: true } });

        expect(badge.role).toBe('admin');
        expect(badge.tier).toBe(TIER_IDS.FREE);
        expect(badge.tierName).toBeNull();
    });

    it('shows an admin who does pay as the tier they pay for', function () {
        const badge = publicBadge({
            permissions: { isAdmin: true },
            membership: active(TIER_IDS.SUPPORTER)
        });

        expect(badge.role).toBe('admin');
        expect(badge.tier).toBe(TIER_IDS.SUPPORTER);
    });

    it('drops the badge the moment a pledge lapses', function () {
        const badge = publicBadge({
            membership: { tier: TIER_IDS.ARCHON, status: 'former_patron' }
        });

        expect(badge).toEqual({ role: 'user', tier: TIER_IDS.FREE, tierName: null });
    });

    it('drops the badge when a comped grant expires', function () {
        const expired = {
            grantedTier: TIER_IDS.VAULT_MASTER,
            grantedUntil: new Date('2020-01-01T00:00:00Z')
        };

        expect(publicBadge({ membership: expired }).tier).toBe(TIER_IDS.FREE);
    });

    it('honours the legacy hand-granted Supporter role', function () {
        expect(publicBadge({ permissions: { isSupporter: true } }).tier).toBe(TIER_IDS.SUPPORTER);
    });

    it('lets a site role outrank a tier for the name colour', function () {
        const badge = publicBadge({
            permissions: { isWinner: true },
            membership: active(TIER_IDS.VAULT_MASTER)
        });

        // Winner for the colour, Vault Master for the key: both are true, and
        // one does not hide the other.
        expect(badge.role).toBe('winner');
        expect(badge.tier).toBe(TIER_IDS.VAULT_MASTER);
    });

    it('exposes nothing beyond the role and the tier name', function () {
        const badge = publicBadge({
            membership: {
                tier: TIER_IDS.ARCHON,
                status: 'active',
                provider: 'patreon',
                externalId: 'patreon-user-99',
                expiresAt: new Date('2030-01-01T00:00:00Z')
            }
        });

        expect(Object.keys(badge).sort()).toEqual(['role', 'tier', 'tierName']);
        expect(JSON.stringify(badge)).not.toContain('patreon');
        expect(JSON.stringify(badge)).not.toContain('2030');
    });

    describe('permissionsFromRoleNames', function () {
        it('maps the role names that produce a badge', function () {
            const permissions = permissionsFromRoleNames(['Admin', 'Supporter']);

            expect(permissions.isAdmin).toBe(true);
            expect(permissions.isSupporter).toBe(true);
            expect(permissions.isContributor).toBe(false);
        });

        it('ignores roles that are not badges', function () {
            // A moderator is not a membership, and must not become one.
            const permissions = permissionsFromRoleNames(['ChatManager', 'NewsManager']);

            expect(Object.values(permissions).every((value) => value === false)).toBe(true);
        });
    });
});

describe('BadgeService', function () {
    const service = (rows) => new BadgeService({ query: vi.fn(async () => rows) });

    it('omits players with nothing to show', async function () {
        const badges = await service([
            { Username: 'nobody', Roles: [], Tier: null, Status: null },
            { Username: 'patron', Roles: [], Tier: TIER_IDS.SUPPORTER, Status: 'active' }
        ]).getBadges(['nobody', 'patron']);

        expect(badges.nobody).toBeUndefined();
        expect(badges.patron.tier).toBe(TIER_IDS.SUPPORTER);
    });

    it('keys on the lowercased name, so lookups do not depend on casing', async function () {
        const badges = await service([
            { Username: 'MixedCase', Roles: ['Supporter'], Tier: null, Status: null }
        ]).getBadges(['MIXEDCASE']);

        expect(badges.mixedcase).toBeDefined();
    });

    it('asks for nothing when given no names', async function () {
        const db = { query: vi.fn(async () => []) };

        await expect(new BadgeService(db).getBadges([])).resolves.toEqual({});
        expect(db.query).not.toHaveBeenCalled();
    });

    it('caps how many names one request can ask about', async function () {
        const db = { query: vi.fn(async () => []) };
        const names = Array.from({ length: BadgeService.MAX_USERNAMES + 50 }, (_, i) => `p${i}`);

        await new BadgeService(db).getBadges(names);

        expect(db.query.mock.calls[0][1][0]).toHaveLength(BadgeService.MAX_USERNAMES);
    });

    it('returns no badges rather than failing when the query does', async function () {
        // Decoration must never be the reason a roster fails to load, and the
        // Memberships migration may not have run.
        const db = {
            query: vi.fn(async () => {
                throw new Error('relation "Memberships" does not exist');
            })
        };

        await expect(new BadgeService(db).getBadges(['alice'])).resolves.toEqual({});
    });
});
