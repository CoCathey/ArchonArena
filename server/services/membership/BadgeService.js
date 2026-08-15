const logger = require('../../log');
const { publicBadge, permissionsFromRoleNames } = require('./publicBadge');
const { membershipFromDbRow } = require('./mapRow');
const { TIER_IDS } = require('./tiers');
const { resolveEntitlements } = require('./entitlements');
// ARCHON (N12): name effects travel with the badge, so every list that renders
// a name gets them without a second lookup.
const { resolveCosmetics } = require('./cosmetics');

/**
 * ARCHON (N12): badges for a list of players, in one query.
 *
 * Every page that lists people - the member directory, the leaderboards, club
 * and team rosters, tournament standings, match history, friends, chat - wants
 * the same small thing next to each name, and none of their payloads carried
 * it. Threading a badge through fifteen unrelated services and their SQL would
 * have meant fifteen chances to get the tier logic subtly different, and a
 * sixteenth page shipping later with no badge at all.
 *
 * So it is one lookup keyed by username, and the client asks for the names it
 * is about to render. A page gets badges by rendering <PlayerName>; it does not
 * have to know this exists.
 *
 * Only non-default badges come back. Most players are on the free tier with no
 * role, and sending `{role: 'user', tier: 'free'}` for each of them would be
 * most of the payload.
 */

/** Nobody needs a thousand badges to draw one page. */
const MAX_USERNAMES = 300;

/** The only roles that show up next to a name. */
const BADGE_ROLE_NAMES = [
    'Admin',
    'TournamentWinner',
    'PreviousTournamentWinner',
    'Contributor',
    'Supporter',
    'KeepSupporterStatus'
];

class BadgeService {
    constructor(db = require('../../db')) {
        this.db = db;
        // Flipped off permanently for this process the first time the
        // cosmetics join fails, so a deployment without that table pays for
        // one failed query rather than one per page.
        this.withCosmetics = true;
    }

    /**
     * Roles, membership and (optionally) cosmetics for a batch of names, in one
     * round trip.
     *
     * The role aggregate is filtered to the handful that produce a badge, so
     * this never drags a user's whole permission set onto a public endpoint.
     */
    async query(withCosmetics, wanted) {
        const cosmeticColumns = withCosmetics ? ', pc."Accent", pc."NameEffect"' : '';
        const cosmeticJoin = withCosmetics
            ? 'LEFT JOIN "ProfileCosmetics" pc ON pc."UserId" = u."Id" '
            : '';
        const cosmeticGroup = withCosmetics ? ', pc."Accent", pc."NameEffect"' : '';

        return this.db.query(
            'SELECT u."Username", ' +
                '  COALESCE(array_agg(r."Name") FILTER (WHERE r."Name" IS NOT NULL), ' +
                '    \'{}\') AS "Roles", ' +
                '  m."Tier", m."Status", m."ExpiresAt", m."GrantedTier", m."GrantedUntil"' +
                cosmeticColumns +
                ' FROM "Users" u ' +
                'LEFT JOIN "UserRoles" ur ON ur."UserId" = u."Id" ' +
                'LEFT JOIN "Roles" r ON r."Id" = ur."RoleId" AND r."Name" = ANY($2) ' +
                'LEFT JOIN "Memberships" m ON m."UserId" = u."Id" ' +
                cosmeticJoin +
                'WHERE lower(u."Username") = ANY($1) ' +
                '  AND u."Disabled" IS NOT TRUE AND u."Verified" IS TRUE ' +
                'GROUP BY u."Username", m."Tier", m."Status", m."ExpiresAt", ' +
                '  m."GrantedTier", m."GrantedUntil"' +
                cosmeticGroup,
            [wanted, BADGE_ROLE_NAMES]
        );
    }

    /**
     * The list-sized part of a player's cosmetics, or null when there is
     * nothing to send.
     *
     * Resolved against the owner's entitlements rather than trusted from the
     * row: the stored selection outlives a membership on purpose, so this is
     * the point at which a lapsed pledge stops rendering.
     *
     * @returns {{accentHex: string, nameEffect: string}|null}
     */
    cosmeticsFor(row, permissions, membership) {
        if (!this.withCosmetics || (!row.NameEffect && !row.Accent)) {
            return null;
        }

        const entitlements = resolveEntitlements({ user: { permissions }, membership });
        const resolved = resolveCosmetics(
            { accent: row.Accent, nameEffect: row.NameEffect },
            entitlements.capabilities
        );

        // The accent only travels with an effect that uses it. On its own it
        // would colour nothing in a list, and this payload is one row per name.
        if (resolved.nameEffect === 'none') {
            return null;
        }

        return { accentHex: resolved.accentHex, nameEffect: resolved.nameEffect };
    }

    /**
     * @param {string[]} usernames
     * @returns {Promise<Object<string, {role: string, tier: string, tierName: string|null}>>}
     *          keyed by lowercased username; players with nothing to show are omitted
     */
    async getBadges(usernames) {
        const wanted = [
            ...new Set(
                (usernames || [])
                    .filter((name) => typeof name === 'string' && name.trim())
                    .map((name) => name.trim().toLowerCase())
            )
        ].slice(0, MAX_USERNAMES);

        if (!wanted.length) {
            return {};
        }

        let rows;

        try {
            rows = await this.query(this.withCosmetics, wanted);
        } catch (err) {
            // A page of names with no badges is a page that still works. This
            // endpoint is decoration; it must never be the reason a roster
            // fails to load, and the Memberships table may not exist yet on a
            // deployment that has not run the migration.
            logger.warn('Failed to look up player badges', err);

            if (!this.withCosmetics) {
                return {};
            }

            // ARCHON (N12): cosmetics are the newest join here, so on a
            // deployment that has not run that migration they are the likely
            // cause - and losing every badge on the site because a decoration
            // table is missing is a far worse outcome than losing the
            // decoration. Retry without them, once, and stop asking.
            this.withCosmetics = false;

            try {
                rows = await this.query(false, wanted);
            } catch (retryErr) {
                logger.warn('Failed to look up player badges without cosmetics', retryErr);

                return {};
            }
        }

        const badges = {};

        for (const row of rows || []) {
            const permissions = permissionsFromRoleNames(row.Roles);
            const membership = membershipFromDbRow({
                Tier: row.Tier,
                Status: row.Status,
                ExpiresAt: row.ExpiresAt,
                GrantedTier: row.GrantedTier,
                GrantedUntil: row.GrantedUntil
            });
            const badge = publicBadge({ permissions, membership });
            // ARCHON (N12): the name effect, resolved against what the account
            // may currently use - the same lapse rule as the badge itself, so a
            // shimmer stops on the day the pledge does. Only the two fields a
            // *list* can use: a leaderboard has nowhere to put a banner.
            const cosmetics = this.cosmeticsFor(row, permissions, membership);

            if (badge.role === 'user' && badge.tier === TIER_IDS.FREE && !cosmetics) {
                continue;
            }

            badges[row.Username.toLowerCase()] = cosmetics ? { ...badge, cosmetics } : badge;
        }

        return badges;
    }
}

module.exports = BadgeService;
module.exports.MAX_USERNAMES = MAX_USERNAMES;
module.exports.BADGE_ROLE_NAMES = BADGE_ROLE_NAMES;
