/**
 * ARCHON (N12): what the app is allowed to say about paying for Archon+.
 *
 * The one place the store rules are encoded, so no screen has to remember them
 * and a review rejection is a one-line change here rather than a hunt through
 * the UI. Pure and platform-agnostic on purpose — `storefront.ts` binds it to
 * `Platform.OS`, and the rules can be tested without a device.
 *
 * ## Why iOS shows no prices and no links
 *
 * App Store Review Guideline 3.1.1 forbids "buttons, external links, or other
 * calls to action that direct customers to purchasing mechanisms other than
 * in-app purchase". Archon+ is sold through Patreon on the website, which is
 * not in-app purchase, so a "Choose Archon — $10/mo" button or a link to
 * patreon.com is precisely what gets an app rejected. A price counts as a call
 * to action even with no link attached to it.
 *
 * What IS allowed is Guideline 3.1.3(b), the multiplatform-services provision:
 * an app may let a player use content or subscriptions they acquired elsewhere.
 * That is exactly this case — the membership is bought on the web and the app
 * unlocks what was already bought. So on iOS the app:
 *
 *   - describes what membership includes, with no prices;
 *   - shows the tier the account is already on;
 *   - offers "Connect Patreon", which is an OAuth SIGN-IN, not a purchase;
 *   - never links to a checkout, a campaign page, or anything that reads as
 *     "buy it over here instead".
 *
 * Account linking is not a grey area: signing in to an existing account with an
 * identity provider is ordinary, and the app must not collect Patreon
 * credentials itself (Guideline 4.0 / 5.1.1) — which is why the flow uses the
 * system browser via ASWebAuthenticationSession rather than a WebView.
 *
 * ## Why Android does show them
 *
 * Google Play's rules on external links for a multiplatform service are looser
 * than Apple's. If Play review ever objects, flip android to `false` and the
 * Android build gets the same treatment iOS has — every screen already handles
 * it, because iOS forced them to.
 */
const PURCHASE_LINKS_BY_PLATFORM: Record<string, boolean> = {
    ios: false,
    android: true,
    // Expo web is the same codebase served from the site, where the web
    // membership page already sells openly.
    web: true
};

/**
 * May this platform show prices, tier checkout links, and "subscribe" wording?
 *
 * Unknown platforms get `false`. A new target that nobody has checked the rules
 * for should behave like the strictest one, not the loosest.
 */
export function allowsPurchaseLinks(platform: string): boolean {
    return PURCHASE_LINKS_BY_PLATFORM[platform] ?? false;
}

/**
 * The line shown on a locked panel.
 *
 * Two versions, and the difference is deliberate rather than cosmetic. Where
 * purchase links are allowed it points at the tiers. Where they are not, it
 * says what to do with a membership they already have and stops — no price, no
 * destination, nothing that reads as "buy it elsewhere".
 */
export function upgradePromptFor(platform: string): string {
    return allowsPurchaseLinks(platform)
        ? 'Archon+ members get this. See what each tier includes.'
        : 'Archon+ members get this. Already a member? Connect your Patreon account to unlock it here.';
}
