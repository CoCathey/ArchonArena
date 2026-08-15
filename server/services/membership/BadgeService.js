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
                'SELECT u."Id", u."Username", ' +
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
                    'GROUP BY u."Id", u."Username", m."Tier", m."Status", m."ExpiresAt", ' +
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

        const cosmeticsByUser = await this.getCosmetics((rows || []).map((row) => row.Id));
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
                }),
                cosmetics: cosmeticsByUser[row.Id]
            });

            if (badge.role === 'user' && badge.tier === TIER_IDS.FREE) {
                continue;
            }

            badges[row.Username.toLowerCase()] = badge;
        }

        return badges;
    }

    /**
     * ARCHON (N12): the cosmetic choices for a set of user ids.
     *
     * A second query rather than a third join: the badge query already
     * aggregates roles, and joining a second one-to-many table to it would
     * multiply the rows under that aggregate. Two small indexed reads are
     * cheaper than getting that wrong.
     *
     * Its own try/catch, and its own failure mode: a deployment that has run
     * the Memberships migration but not this one still gets badges, just
     * without cosmetics.
     *
     * @param {number[]} userIds
     * @returns {Promise<Object<number, Object<string,string>>>}
     */
    async getCosmetics(userIds) {
        const ids = [...new Set((userIds || []).filter((id) => Number.isFinite(id)))];

        if (!ids.length) {
            return {};
        }

        let rows;

        try {
            rows = await this.db.query(
                'SELECT "UserId", "Slot", "Choice" FROM "MembershipCosmetics" ' +
                    'WHERE "UserId" = ANY($1)',
                [ids]
            );
        } catch (err) {
            logger.warn('Failed to look up player cosmetics', err);

            return {};
        }

        const byUser = {};

        for (const row of rows || []) {
            (byUser[row.UserId] = byUser[row.UserId] || {})[row.Slot] = row.Choice;
        }

        return byUser;
    }
}

module.exports = BadgeService;
module.exports.MAX_USERNAMES = MAX_USERNAMES;
module.exports.BADGE_ROLE_NAMES = BADGE_ROLE_NAMES;
