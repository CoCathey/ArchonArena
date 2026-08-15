const logger = require('../../log');
const { publicBadge, permissionsFromRoleNames } = require('./publicBadge');
const { membershipFromDbRow } = require('./mapRow');
const { TIER_IDS } = require('./tiers');

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
            rows = await this.db.query(
                'SELECT u."Username", ' +
                    // Roles and membership in one round trip. The role
                    // aggregate is filtered to the handful that produce a
                    // badge, so this never drags a user's whole permission set
                    // onto a public endpoint.
                    '  COALESCE(array_agg(r."Name") FILTER (WHERE r."Name" IS NOT NULL), ' +
                    '    \'{}\') AS "Roles", ' +
                    '  m."Tier", m."Status", m."ExpiresAt", m."GrantedTier", m."GrantedUntil" ' +
                    'FROM "Users" u ' +
                    'LEFT JOIN "UserRoles" ur ON ur."UserId" = u."Id" ' +
                    'LEFT JOIN "Roles" r ON r."Id" = ur."RoleId" AND r."Name" = ANY($2) ' +
                    'LEFT JOIN "Memberships" m ON m."UserId" = u."Id" ' +
                    'WHERE lower(u."Username") = ANY($1) ' +
                    '  AND u."Disabled" IS NOT TRUE AND u."Verified" IS TRUE ' +
                    'GROUP BY u."Username", m."Tier", m."Status", m."ExpiresAt", ' +
                    '  m."GrantedTier", m."GrantedUntil"',
                [wanted, BADGE_ROLE_NAMES]
            );
        } catch (err) {
            // A page of names with no badges is a page that still works. This
            // endpoint is decoration; it must never be the reason a roster
            // fails to load, and the Memberships table may not exist yet on a
            // deployment that has not run the migration.
            logger.warn('Failed to look up player badges', err);

            return {};
        }

        const badges = {};

        for (const row of rows || []) {
            const badge = publicBadge({
                permissions: permissionsFromRoleNames(row.Roles),
                membership: membershipFromDbRow({
                    Tier: row.Tier,
                    Status: row.Status,
                    ExpiresAt: row.ExpiresAt,
                    GrantedTier: row.GrantedTier,
                    GrantedUntil: row.GrantedUntil
                })
            });

            if (badge.role === 'user' && badge.tier === TIER_IDS.FREE) {
                continue;
            }

            badges[row.Username.toLowerCase()] = badge;
        }

        return badges;
    }
}

module.exports = BadgeService;
module.exports.MAX_USERNAMES = MAX_USERNAMES;
module.exports.BADGE_ROLE_NAMES = BADGE_ROLE_NAMES;
