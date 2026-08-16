import type { MembershipCatalogResult } from '../api/types';

/**
 * ARCHON (N12): the tier catalogue, with every trace of buying removed.
 *
 * Where purchase links are not allowed — iOS, under App Store Review Guideline
 * 3.1.1 — the price and the checkout URL are stripped from the payload before
 * any screen sees them.
 *
 * The screens also guard on `canShowPurchaseLinks()`, and that guard stays. But
 * a guard is something a future edit has to remember, and an absent field is
 * something it cannot get wrong: `priceUsd` is optional in the type, so a
 * screen that forgets the guard does not compile a price block, and a `$`
 * cannot be rendered from a number that is not there.
 *
 * What survives is the description — `includes`, `adds`, taglines and the
 * capability copy. Saying what a membership gives you is not a call to action,
 * and Guideline 3.1.3(b) is precisely the provision that lets a multiplatform
 * service say it.
 *
 * Pure, and in its own module, so the rule can be tested against a real payload
 * without loading React Native.
 */
export function withoutPurchaseInfo(catalog: MembershipCatalogResult): MembershipCatalogResult {
    return {
        ...catalog,
        tiers: (catalog.tiers ?? []).map((tier) => {
            // Copied and deleted rather than mutated: the caller may hand the
            // same object to something else.
            const rest = { ...tier };

            delete rest.priceUsd;
            delete rest.checkoutUrl;

            return rest;
        })
    };
}
