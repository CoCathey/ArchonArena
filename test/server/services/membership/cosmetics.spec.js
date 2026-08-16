const {
    COSMETIC_SLOTS,
    COSMETICS,
    SLOT_IDS,
    defaultChoice,
    isAllowed,
    sanitiseCosmetics,
    publicCosmetics,
    cosmeticCatalog
} = require('../../../../server/services/membership/cosmetics');
const { CAPABILITIES } = require('../../../../server/services/membership/capabilities');
const { TIER_IDS, capabilitiesForTier } = require('../../../../server/services/membership/tiers');
const { publicBadge } = require('../../../../server/services/membership/publicBadge');

/**
 * ARCHON (N12): cosmetics are the one membership benefit that is visible to
 * strangers, which makes them the one where getting entitlement wrong is
 * visible to strangers too.
 *
 * Two failures matter and both are tested here:
 *
 *   - storing something that was never paid for (a hand-edited client);
 *   - still showing something after the membership that bought it has lapsed.
 *
 * The second is the one a sweep job would get wrong. It is checked at read
 * time, so it needs no sweep and cannot be late.
 */
describe('membership cosmetics', function () {
    const FREE = capabilitiesForTier(TIER_IDS.FREE);
    const ARCHON = capabilitiesForTier(TIER_IDS.ARCHON);
    const VAULT_MASTER = capabilitiesForTier(TIER_IDS.VAULT_MASTER);

    describe('the catalogue', function () {
        it('starts every slot with a free option', function () {
            // A slot whose default is paid for would render as locked for the
            // whole free tier, which is a downgrade wearing a feature's clothes.
            for (const slot of SLOT_IDS) {
                const first = COSMETICS[slot].options[0];

                expect(first.capability, `${slot} defaults to a paid option`).toBeFalsy();
                expect(defaultChoice(slot)).toBe(first.id);
            }
        });

        it('labels every option and gives unique ids inside a slot', function () {
            for (const slot of SLOT_IDS) {
                const ids = COSMETICS[slot].options.map((option) => option.id);

                expect(new Set(ids).size, `${slot} has duplicate option ids`).toBe(ids.length);

                for (const option of COSMETICS[slot].options) {
                    expect(option.label, `${slot}/${option.id} has no label`).toBeTruthy();
                }
            }
        });

        it('marks locked options rather than hiding them', function () {
            const free = cosmeticCatalog(FREE);
            const master = cosmeticCatalog(VAULT_MASTER);

            expect(free.length).toBe(master.length);

            for (let index = 0; index < free.length; index += 1) {
                expect(free[index].options.length).toBe(master[index].options.length);
            }

            const anyLockedForFree = free.some((slot) =>
                slot.options.some((option) => option.locked)
            );
            const anyLockedForMaster = master.some((slot) =>
                slot.options.some((option) => option.locked)
            );

            expect(anyLockedForFree).toBe(true);
            expect(anyLockedForMaster).toBe(false);
        });

        it('gates every non-default option on the Vault Master capability', function () {
            for (const slot of SLOT_IDS) {
                for (const option of COSMETICS[slot].options.slice(1)) {
                    expect(option.capability, `${slot}/${option.id} is free by accident`).toBe(
                        CAPABILITIES.ENHANCED_COSMETICS
                    );
                }
            }
        });
    });

    describe('what may be stored', function () {
        const paidOption = COSMETICS[COSMETIC_SLOTS.NAMEPLATE].options[1].id;

        it('keeps a choice the account is entitled to', function () {
            expect(
                sanitiseCosmetics({ [COSMETIC_SLOTS.NAMEPLATE]: paidOption }, VAULT_MASTER)
            ).toEqual({ [COSMETIC_SLOTS.NAMEPLATE]: paidOption });
        });

        it('drops a choice the account is not entitled to', function () {
            expect(sanitiseCosmetics({ [COSMETIC_SLOTS.NAMEPLATE]: paidOption }, ARCHON)).toEqual(
                {}
            );
            expect(sanitiseCosmetics({ [COSMETIC_SLOTS.NAMEPLATE]: paidOption }, FREE)).toEqual({});
        });

        it('drops unknown slots and unknown options', function () {
            expect(
                sanitiseCosmetics(
                    { notASlot: 'whatever', [COSMETIC_SLOTS.NAMEPLATE]: 'not-an-option' },
                    VAULT_MASTER
                )
            ).toEqual({});
        });

        it('reads the default and null both as "back to default"', function () {
            // Explicitly null rather than absent, so the storage layer can tell
            // "clear this" from "not mentioned".
            expect(
                sanitiseCosmetics(
                    {
                        [COSMETIC_SLOTS.NAMEPLATE]: defaultChoice(COSMETIC_SLOTS.NAMEPLATE),
                        [COSMETIC_SLOTS.BADGE_FINISH]: null
                    },
                    FREE
                )
            ).toEqual({
                [COSMETIC_SLOTS.NAMEPLATE]: null,
                [COSMETIC_SLOTS.BADGE_FINISH]: null
            });
        });

        it('keeps the valid half of a request that also contains a stale one', function () {
            // A tab left open across a downgrade sends both. Refusing the whole
            // request would lose the change the player actually just made.
            const result = sanitiseCosmetics(
                {
                    [COSMETIC_SLOTS.NAMEPLATE]: paidOption,
                    [COSMETIC_SLOTS.BADGE_FINISH]: null
                },
                ARCHON
            );

            expect(result).toEqual({ [COSMETIC_SLOTS.BADGE_FINISH]: null });
        });

        it('accepts an entitlements object as well as a capability list', function () {
            expect(
                sanitiseCosmetics(
                    { [COSMETIC_SLOTS.NAMEPLATE]: paidOption },
                    { capabilities: VAULT_MASTER }
                )
            ).toEqual({ [COSMETIC_SLOTS.NAMEPLATE]: paidOption });
        });
    });

    describe('what other people see', function () {
        const stored = {
            [COSMETIC_SLOTS.NAMEPLATE]: COSMETICS[COSMETIC_SLOTS.NAMEPLATE].options[1].id,
            [COSMETIC_SLOTS.BADGE_FINISH]: COSMETICS[COSMETIC_SLOTS.BADGE_FINISH].options[1].id
        };

        it('shows a paid-up member their choices', function () {
            expect(publicCosmetics(stored, VAULT_MASTER)).toEqual(stored);
        });

        it('shows nothing once the membership has lapsed', function () {
            // The row is untouched - they get it all back if they come back -
            // but nobody sees it in the meantime.
            expect(publicCosmetics(stored, ARCHON)).toBeNull();
            expect(publicCosmetics(stored, FREE)).toBeNull();
        });

        it('omits a slot left at its default', function () {
            expect(
                publicCosmetics(
                    { [COSMETIC_SLOTS.NAMEPLATE]: defaultChoice(COSMETIC_SLOTS.NAMEPLATE) },
                    VAULT_MASTER
                )
            ).toBeNull();
        });

        it('is null rather than an empty object when there is nothing to say', function () {
            expect(publicCosmetics(null, VAULT_MASTER)).toBeNull();
            expect(publicCosmetics({}, VAULT_MASTER)).toBeNull();
        });
    });

    describe('isAllowed', function () {
        it('is false for anything the catalogue does not contain', function () {
            expect(isAllowed('nope', 'ember', VAULT_MASTER)).toBe(false);
            expect(isAllowed(COSMETIC_SLOTS.NAMEPLATE, 'chartreuse', VAULT_MASTER)).toBe(false);
        });

        it('is true for a free option at every tier', function () {
            expect(
                isAllowed(COSMETIC_SLOTS.NAMEPLATE, defaultChoice(COSMETIC_SLOTS.NAMEPLATE), FREE)
            ).toBe(true);
        });
    });

    /**
     * The badge is where a cosmetic actually reaches another player, so the
     * lapsing rule is checked through it as well as in isolation - these are the
     * two places it could be got wrong independently.
     */
    describe('through the public badge', function () {
        const chosen = {
            [COSMETIC_SLOTS.NAMEPLATE]: COSMETICS[COSMETIC_SLOTS.NAMEPLATE].options[1].id
        };
        const active = (tier) => ({ tier, status: 'active' });

        it('carries a paying Vault Master their nameplate', function () {
            const badge = publicBadge({
                membership: active(TIER_IDS.VAULT_MASTER),
                cosmetics: chosen
            });

            expect(badge.tier).toBe(TIER_IDS.VAULT_MASTER);
            expect(badge.cosmetics).toEqual(chosen);
        });

        it('drops it the moment the membership lapses', function () {
            const badge = publicBadge({
                membership: { tier: TIER_IDS.VAULT_MASTER, status: 'cancelled' },
                cosmetics: chosen
            });

            expect(badge.tier).toBe(TIER_IDS.FREE);
            expect(badge.cosmetics).toBeUndefined();
        });

        it('drops it for a lower tier that somehow has a row stored', function () {
            const badge = publicBadge({
                membership: active(TIER_IDS.ARCHON),
                cosmetics: chosen
            });

            expect(badge.tier).toBe(TIER_IDS.ARCHON);
            expect(badge.cosmetics).toBeUndefined();
        });

        it('does not give an admin cosmetics they have not bought', function () {
            // Same reason publicBadge does not give an admin a tier: this is
            // what the public sees, and it must not assert something about
            // money that is not true.
            const badge = publicBadge({
                permissions: { isAdmin: true },
                membership: null,
                cosmetics: chosen
            });

            expect(badge.role).toBe('admin');
            expect(badge.cosmetics).toBeUndefined();
        });

        it('omits the key entirely when there is nothing chosen', function () {
            const badge = publicBadge({ membership: active(TIER_IDS.VAULT_MASTER) });

            expect(Object.prototype.hasOwnProperty.call(badge, 'cosmetics')).toBe(false);
        });
    });
});
