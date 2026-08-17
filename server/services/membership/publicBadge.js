const { resolveEntitlements, newPlayerTrialEndsAt } = require('./entitlements');
const { TIER_IDS } = require('./tiers');
const { publicCosmetics } = require('./cosmetics');
// ARCHON (F9): the practice bots are ordinary accounts, so the one place that
// decides what shows next to a name is also the place that says which of them
// is a bot.
const { isBotEmail } = require('../botgames/roster');

/**
 * ARCHON (N12): what other people may see about someone's membership.
 *
 * Distinct from `resolveEntitlements`, which answers "what may THIS account
 * use" and is private to that account. This answers "what does the rest of the
 * site get to display next to their name", and the difference is not cosmetic:
 *
 *   - The admin override is deliberately NOT applied. An admin resolves to the
 *     highest tier so that every feature opens for them; rendering that
 *     publicly would label every administrator a Vault Master patron, which is
 *     a claim about money that is not true. Admins get the admin badge, which
 *     they have earned, and a tier only if they actually pay for one.
 *   - Expiry, provider, external id and whether access was comped are all
 *     private. A badge says "this person supports the site"; it is not a
 *     public readout of somebody's billing.
 *
 * Everything else - manual grants, provider status, expiry, the legacy
 * Supporter role - is resolved by the same function the rest of the system
 * uses, with `isAdmin` stripped. That matters: a lapsed pledge has to stop
 * showing a badge on exactly the day it stops unlocking features, and the only
 * way to guarantee that is to ask the same code.
 */

/**
 * Site roles, highest first. This is the same order `User.role` applies, and
 * the badge and the name colour are both keyed off the result.
 */
const ROLE_BY_PRIORITY = [
    ['isAdmin', 'admin', 'Admin'],
    ['isWinner', 'winner', 'TournamentWinner'],
    ['isPreviousWinner', 'previouswinner', 'PreviousTournamentWinner'],
    ['isContributor', 'contributor', 'Contributor']
];

/**
 * @typedef PublicBadge
 * @property {string} role     admin | winner | previouswinner | contributor | supporter | user
 * @property {string} tier     the tier id, 'free' when there is nothing to show
 * @property {string|null} tierName its display name, or null at free
 * @property {boolean} [isNew] ARCHON (N20): within the new-player window
 * @property {object} [cosmetics] chosen cosmetic slots the account may still use
 */

/**
 * @param {object} params
 * @param {object} [params.permissions] mapped permissions (UserService.mapPermissions shape)
 * @param {object} [params.membership] the Memberships row, already camelCased
 * @param {object} [params.cosmetics] the account's stored cosmetic choices
 * @param {string|Date} [params.registered] when the account was created
 * @param {Date} [params.now]
 * @returns {PublicBadge}
 */
function publicBadge({
    permissions = {},
    membership = null,
    cosmetics = null,
    registered = null,
    email = null,
    now = new Date()
} = {}) {
    // eslint-disable-next-line no-unused-vars
    const { isAdmin, ...withoutAdmin } = permissions || {};
    // ARCHON (N20): registered is deliberately NOT passed into this
    // resolution. The trial unlocks Archon's tools, but the TIER badge is a
    // claim about money - same doctrine as the admin strip above - so a
    // trial account wears the New pill below, never a patron's key.
    const entitlements = resolveEntitlements({
        user: { permissions: withoutAdmin },
        membership,
        now
    });

    /**
     * ARCHON (F9): a practice bot says so, and says nothing else.
     *
     * The New pill means "be nice, they just got here" - advice about a
     * person, addressed to people. A bot account is created the day the
     * feature is switched on and would wear it for its first fortnight,
     * which is both untrue and the opposite of useful: what a player needs
     * to know before they sit down is that the opponent is a computer.
     */
    const isBot = isBotEmail(email);

    // The pill is about being new, not about the trial's tools: a new player
    // who pays on day one is still new, and still gets the welcome.
    const trialEndsAt = newPlayerTrialEndsAt(registered);
    const isNew = !isBot && !!(trialEndsAt && trialEndsAt.getTime() > now.getTime());

    const paid = entitlements.tierId && entitlements.tierId !== TIER_IDS.FREE;

    let role = 'user';

    for (const [permission, name] of ROLE_BY_PRIORITY) {
        if (permissions && permissions[permission]) {
            role = name;
            break;
        }
    }

    if (role === 'user' && paid) {
        role = 'supporter';
    }

    // Resolved against live entitlements, which is what makes a cosmetic stop
    // the day the membership that bought it lapses, without anybody sweeping
    // the table. The stored choice survives; only its visibility ends.
    //
    // Note these are NOT the admin-stripped entitlements the tier came from.
    // The tier is a claim about money and must not be asserted for an admin who
    // does not pay; a frame or a key finish asserts nothing of the kind, and
    // resolving it without the override produces the genuinely confusing
    // outcome instead - an admin picks a finish in an editor that offers it,
    // saves successfully, and then cannot find it next to their own name. Same
    // rule the profile page follows (PlayerProfileService.getIdentity).
    const visible = publicCosmetics(
        cosmetics,
        resolveEntitlements({ user: { permissions }, membership, now })
    );

    return {
        role,
        tier: paid ? entitlements.tierId : TIER_IDS.FREE,
        tierName: paid ? entitlements.tierName : null,
        // All omitted rather than sent as false/empty: this rides on a
        // batched public lookup that already drops accounts with nothing to
        // say.
        ...(isBot ? { isBot: true } : {}),
        ...(isNew ? { isNew: true } : {}),
        ...(visible ? { cosmetics: visible } : {})
    };
}

/**
 * The same thing from raw `Roles.Name` values, for callers reading the table
 * directly rather than holding a mapped permissions object.
 *
 * Only the role names that produce a badge are mapped. This is a display
 * concern - nothing is granted from it - so a role missing here costs a colour,
 * not access.
 *
 * @param {Iterable<string>} roleNames
 * @returns {object} permissions-shaped
 */
function permissionsFromRoleNames(roleNames) {
    const names = new Set(roleNames || []);
    const permissions = {};

    for (const [permission, , roleName] of ROLE_BY_PRIORITY) {
        permissions[permission] = names.has(roleName);
    }

    permissions.isSupporter = names.has('Supporter');
    permissions.keepsSupporterWithNoPatreon = names.has('KeepSupporterStatus');

    return permissions;
}

module.exports = { publicBadge, permissionsFromRoleNames, ROLE_BY_PRIORITY };
