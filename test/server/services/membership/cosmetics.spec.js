const {
    SLOT_IDS,
    bioMaxLength,
    defaultCosmetics,
    resolveCosmetics,
    sanitizeCosmetics,
    isDefaultCosmetics,
    cosmeticsCatalog,
    normalizeAccentHex
} = require('../../../../server/services/membership/cosmetics');
const { CAPABILITIES } = require('../../../../server/services/membership/capabilities');
const {
    TIER_IDS,
    capabilitiesForTier,
    tierCatalog
} = require('../../../../server/services/membership/tiers');

/**
 * ARCHON (N12): profile cosmetics.
 *
 * `profile_cosmetics` and `enhanced_cosmetics` were sold before either
 * existed - Supporter promised "customise how your profile looks" while the
 * only customisation on the site was the free game board background. These
 * tests are about the two rules that make the feature honest: you get exactly
 * what your tier includes, and you stop getting it when you stop paying,
 * without losing what you chose.
 */

const SUPPORTER = capabilitiesForTier(TIER_IDS.SUPPORTER);
const VAULT_MASTER = capabilitiesForTier(TIER_IDS.VAULT_MASTER);

const everything = {
    accent: 'sanctum',
    banner: 'logos',
    frame: 'brass',
    title: 'vault_diver',
    nameEffect: 'glow'
};

describe('profile cosmetics', function () {
    describe('resolveCosmetics', function () {
        it('gives a free account the defaults, whatever it has stored', function () {
            // Nothing is deleted when a membership lapses, so a free account
            // can legitimately have a full selection on file.
            expect(resolveCosmetics(everything, [])).toMatchObject(defaultCosmetics());
        });

        it('gives a supporter what Supporter includes', function () {
            expect(resolveCosmetics(everything, SUPPORTER)).toMatchObject(everything);
        });

        it('does not give a supporter a Vault Master option', function () {
            const resolved = resolveCosmetics(
                { ...everything, frame: 'prismatic', nameEffect: 'shimmer' },
                SUPPORTER
            );

            // Only the two locked slots fall back; the rest of the selection
            // is untouched.
            expect(resolved.frame).toBe('none');
            expect(resolved.nameEffect).toBe('none');
            expect(resolved.accent).toBe('sanctum');
            expect(resolved.banner).toBe('logos');
        });

        it('stops rendering the moment a pledge lapses, and restores it after', function () {
            const stored = { ...everything, frame: 'prismatic' };

            expect(resolveCosmetics(stored, []).frame).toBe('none');
            // The same stored row, with the membership back.
            expect(resolveCosmetics(stored, VAULT_MASTER).frame).toBe('prismatic');
        });

        it('resolves the accent to a colour so a payload carries one', function () {
            expect(resolveCosmetics({ accent: 'logos' }, SUPPORTER).accentHex).toMatch(
                /^#[0-9a-f]{6}$/i
            );
            // Free accounts get the site amber rather than nothing.
            expect(resolveCosmetics({ accent: 'logos' }, []).accentHex).toMatch(/^#[0-9a-f]{6}$/i);
        });

        it('resolves a title to its label, so nothing renders a raw id', function () {
            expect(resolveCosmetics({ title: 'chain_breaker' }, SUPPORTER).titleLabel).toBe(
                'Chain Breaker'
            );
            expect(resolveCosmetics({ title: 'chain_breaker' }, []).titleLabel).toBeNull();
        });

        it('falls back for an id this build no longer knows about', function () {
            // The catalogue is code, so an option can be retired. A stored
            // value that no longer exists must not render as itself.
            expect(resolveCosmetics({ frame: 'retired-in-2027' }, VAULT_MASTER).frame).toBe('none');
        });

        it('takes a custom accent only from Vault Master', function () {
            expect(resolveCosmetics({ accent: '#7fd3f0' }, SUPPORTER).accent).toBe('default');
            expect(resolveCosmetics({ accent: '#7fd3f0' }, VAULT_MASTER).accent).toBe('#7fd3f0');
        });
    });

    describe('sanitizeCosmetics', function () {
        it('rejects rather than silently defaulting, and names the slot', function () {
            // The save path is not the render path: quietly storing something
            // other than what was sent is how a settings page ends up lying
            // about its own state.
            const result = sanitizeCosmetics(
                { frame: 'prismatic', title: 'vault_diver' },
                SUPPORTER
            );

            expect(result.rejected).toEqual(['frame']);
            expect(result.cosmetics).toEqual({ title: 'vault_diver' });
        });

        it('only touches the slots it was sent', function () {
            const result = sanitizeCosmetics({ banner: 'mars' }, SUPPORTER);

            expect(result.cosmetics).toEqual({ banner: 'mars' });
            expect(result.rejected).toEqual([]);
        });

        it('treats null and empty string as "None"', function () {
            const result = sanitizeCosmetics({ frame: null, title: '' }, SUPPORTER);

            expect(result.cosmetics).toEqual({ frame: 'none', title: 'none' });
            expect(result.rejected).toEqual([]);
        });

        it('refuses an unknown option even from the top tier', function () {
            expect(sanitizeCosmetics({ banner: 'not-a-banner' }, VAULT_MASTER).rejected).toEqual([
                'banner'
            ]);
        });

        it('refuses anything that is not a colour in the custom accent', function () {
            // The one field whose value is data rather than an id, so the one
            // that has to be validated as data.
            for (const bad of ['red', 'javascript:alert(1)', '#12', 'url(x)', '#ggghhh']) {
                expect(sanitizeCosmetics({ accent: bad }, VAULT_MASTER).rejected).toEqual([
                    'accent'
                ]);
            }
        });

        it('ignores keys that are not cosmetic slots', function () {
            const result = sanitizeCosmetics(
                { banner: 'mars', tier: 'vault_master', isAdmin: true },
                SUPPORTER
            );

            expect(result.cosmetics).toEqual({ banner: 'mars' });
        });
    });

    describe('normalizeAccentHex', function () {
        it('keeps a colour that already reads on a dark board', function () {
            expect(normalizeAccentHex('#7FD3F0')).toBe('#7fd3f0');
        });

        it('lightens one that does not, rather than refusing it', function () {
            // A colour picker that rejects a third of its own range is a bug
            // report; an invisible name the player cannot see is worse.
            const lightened = normalizeAccentHex('#101020');

            expect(lightened).not.toBe('#101020');
            expect(parseInt(lightened.slice(1, 3), 16)).toBeGreaterThan(0x10);
        });

        it('is null for anything that is not a hex colour', function () {
            expect(normalizeAccentHex('rebeccapurple')).toBeNull();
            expect(normalizeAccentHex('#fff')).toBeNull();
            expect(normalizeAccentHex('')).toBeNull();
        });
    });

    describe('the catalogue', function () {
        it('marks locked options rather than hiding them', function () {
            const accents = cosmeticsCatalog([]).find((slot) => slot.id === 'accent');
            const sanctum = accents.options.find((option) => option.id === 'sanctum');

            expect(sanctum.locked).toBe(true);
            expect(sanctum.capability).toBe(CAPABILITIES.PROFILE_COSMETICS);
            // The default is never locked - it is what everybody already has.
            expect(accents.options.find((option) => option.id === 'default').locked).toBe(false);
        });

        it('unlocks per capability, not per tier name', function () {
            const catalog = cosmeticsCatalog(SUPPORTER);
            const frames = catalog.find((slot) => slot.id === 'frame');

            expect(frames.options.find((option) => option.id === 'brass').locked).toBe(false);
            expect(frames.options.find((option) => option.id === 'prismatic').locked).toBe(true);
        });

        it('covers every slot, so the editor cannot miss one', function () {
            expect(cosmeticsCatalog([]).map((slot) => slot.id)).toEqual(SLOT_IDS);
        });
    });

    describe('bio length', function () {
        it('is the free limit without the capability and longer with it', function () {
            expect(bioMaxLength([])).toBe(280);
            expect(bioMaxLength(SUPPORTER)).toBeGreaterThan(280);
        });
    });

    describe('isDefaultCosmetics', function () {
        it('is true for an untouched selection, so lists can omit it', function () {
            expect(isDefaultCosmetics(defaultCosmetics())).toBe(true);
            expect(isDefaultCosmetics(null)).toBe(true);
            expect(isDefaultCosmetics({ ...defaultCosmetics(), frame: 'brass' })).toBe(false);
        });
    });

    /**
     * `isTierPurchasable` refuses to sell a tier that delivers nothing its
     * predecessor does not already include. Vault Master failed that check
     * from the day it was written - all five of its capabilities were unbuilt,
     * so $20 a month bought nothing over Archon's $10 - and enhanced cosmetics
     * is the first of them to actually ship.
     */
    describe('what shipping this changes about the tiers', function () {
        it('makes Vault Master purchasable, because it now delivers something', function () {
            const vaultMaster = tierCatalog().find((tier) => tier.id === TIER_IDS.VAULT_MASTER);

            expect(vaultMaster.purchasable).toBe(true);
            expect(vaultMaster.liveCapabilities).toContain(CAPABILITIES.ENHANCED_COSMETICS);
        });

        it('counts both cosmetics capabilities as live rather than planned', function () {
            const supporter = tierCatalog().find((tier) => tier.id === TIER_IDS.SUPPORTER);

            expect(supporter.liveCapabilities).toContain(CAPABILITIES.PROFILE_COSMETICS);
        });
    });
});
