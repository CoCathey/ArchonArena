const { resolveEntitlements } = require('./entitlements');
const { TIER_IDS } = require('./tiers');

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
 */

/**
 * @param {object} params
 * @param {object} [params.permissions] mapped permissions (UserService.mapPermissions shape)
 * @param {object} [params.membership] the Memberships row, already camelCased
 * @param {Date} [params.now]
 * @returns {PublicBadge}
 */
function publicBadge({ permissions = {}, membership = null, now = new Date() } = {}) {
    // eslint-disable-next-line no-unused-vars
    const { isAdmin, ...withoutAdmin } = permissions || {};
    const entitlements = resolveEntitlements({
        user: { permissions: withoutAdmin },
        membership,
        now
    });

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

    return {
        role,
        tier: paid ? entitlements.tierId : TIER_IDS.FREE,
        tierName: paid ? entitlements.tierName : null
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
