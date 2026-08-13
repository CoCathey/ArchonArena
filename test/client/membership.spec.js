import {
    CAPABILITIES,
    TIERS,
    hasCapability,
    isAdminUser,
    isPaidMember,
    tierNameOf,
    tierOf
} from '../../client/membership';

/**
 * ARCHON (N12): the client-side gate.
 *
 * `hasCapability` is the single function every premium panel, nav item and
 * locked overlay calls, so what it does for an admin is what the whole client
 * does for an admin.
 *
 * The shapes below are not hypothetical. The redux account user is set from
 * several responses and rehydrated across reloads, so "a user object without
 * `capabilities`" is a state that really occurs - a session from before this
 * feature shipped, or any path that hands over a user built the old way. In
 * every one of them an admin previously saw everything locked, and a locked
 * panel looks like a product decision rather than a bug.
 */
describe('client membership helpers', function () {
    const admin = (over = {}) => ({
        username: 'admin',
        permissions: { isAdmin: true },
        ...over
    });

    const player = (over = {}) => ({ username: 'player', permissions: {}, ...over });

    describe('the admin floor', function () {
        it('grants every capability to an admin with NO capabilities array', function () {
            const user = admin();

            for (const capability of Object.values(CAPABILITIES)) {
                expect(hasCapability(user, capability), `admin denied ${capability}`).toBe(true);
            }
        });

        it('grants everything to an admin with an EMPTY capabilities array', function () {
            const user = admin({ capabilities: [] });

            expect(hasCapability(user, CAPABILITIES.ARCHON_INTELLIGENCE)).toBe(true);
            expect(hasCapability(user, CAPABILITIES.TOURNAMENT_LAB)).toBe(true);
        });

        it('grants everything when only the membership block says admin', function () {
            // A user object carrying membership but not permissions.
            const user = { username: 'a', membership: { isAdmin: true, tier: TIERS.FREE } };

            expect(hasCapability(user, CAPABILITIES.META_ANALYTICS)).toBe(true);
        });

        it('reads as the top tier even with no membership block', function () {
            const user = admin();

            expect(tierOf(user)).toBe(TIERS.VAULT_MASTER);
            expect(tierNameOf(user)).toBe('Vault Master');
            expect(isPaidMember(user)).toBe(true);
            expect(isAdminUser(user)).toBe(true);
        });

        it('does not override a membership the server did send', function () {
            // When the server has spoken, its answer stands - the floor is for
            // the case where it did not.
            const user = admin({
                membership: { tier: TIERS.VAULT_MASTER, tierName: 'Vault Master', rank: 3 }
            });

            expect(tierOf(user)).toBe(TIERS.VAULT_MASTER);
        });
    });

    describe('everyone else', function () {
        it('gives a free player nothing, with or without the array', function () {
            expect(hasCapability(player(), CAPABILITIES.ARCHON_INTELLIGENCE)).toBe(false);
            expect(hasCapability(player({ capabilities: [] }), CAPABILITIES.ELO_HISTORY)).toBe(
                false
            );
        });

        it('reads the resolved list for a paying member', function () {
            const supporter = player({
                capabilities: [CAPABILITIES.ELO_HISTORY, CAPABILITIES.ADVANCED_DECK_STATS],
                membership: { tier: TIERS.SUPPORTER, tierName: 'Supporter', rank: 1 }
            });

            expect(hasCapability(supporter, CAPABILITIES.ELO_HISTORY)).toBe(true);
            expect(hasCapability(supporter, CAPABILITIES.ARCHON_INTELLIGENCE)).toBe(false);
            expect(isPaidMember(supporter)).toBe(true);
            expect(tierNameOf(supporter)).toBe('Supporter');
        });

        it('gives a logged-out visitor nothing', function () {
            expect(hasCapability(undefined, CAPABILITIES.ELO_HISTORY)).toBe(false);
            expect(hasCapability(null, CAPABILITIES.ELO_HISTORY)).toBe(false);
            expect(isAdminUser(undefined)).toBe(false);
            expect(tierOf(undefined)).toBe(TIERS.FREE);
            expect(isPaidMember(undefined)).toBe(false);
        });

        it('does not let a forged empty permissions object grant anything', function () {
            expect(
                hasCapability({ permissions: { isAdmin: false } }, CAPABILITIES.TOURNAMENT_LAB)
            ).toBe(false);
        });
    });
});
