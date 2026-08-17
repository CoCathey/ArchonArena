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
        // Only the slots that can be drawn beside a name - see PUBLIC_SLOTS
        // in cosmetics.js. A banner has nowhere to go in a list.
        const cosmeticColumns = withCosmetics
            ? ', pc."Accent", pc."Frame", pc."NameEffect", pc."BadgeFinish"'
            : '';
        const cosmeticJoin = withCosmetics
            ? 'LEFT JOIN "ProfileCosmetics" pc ON pc."UserId" = u."Id" '
            : '';
        const cosmeticGroup = cosmeticColumns;

        return this.db.query(
            'SELECT u."Username", u."Registered", u."Email", ' +
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
                'GROUP BY u."Username", u."Registered", u."Email", m."Tier", m."Status", m."ExpiresAt", ' +
                '  m."GrantedTier", m."GrantedUntil"' +
                cosmeticGroup,
            [wanted, BADGE_ROLE_NAMES]
        );
    }

    /**
     * The stored cosmetic choices on a row, in the shape the catalogue reads.
     *
     * Deliberately NOT resolved here: `publicBadge` resolves them against the
     * same entitlements it derives the tier from, so there is one place that
     * decides when a lapsed pledge stops rendering rather than two that can
     * disagree.
     */
    storedCosmetics(row) {
        if (!this.withCosmetics) {
            return null;
        }

        return {
            accent: row.Accent,
            frame: row.Frame,
            nameEffect: row.NameEffect,
            badgeFinish: row.BadgeFinish
        };
    }

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
            // ARCHON (N12): cosmetics ride along with the badge, so every list
            // that renders a name gets them without a second lookup. publicBadge
            // resolves them against what the account may currently use, which
            // is what stops a shimmer on the day the pledge does.
            const badge = publicBadge({
                permissions,
                membership,
                cosmetics: this.storedCosmetics(row),
                // ARCHON (N20): drives the New pill next to fresh accounts.
                registered: row.Registered,
                // ARCHON (F9): and the BOT pill next to a practice bot, which
                // is the one badge a name cannot be rendered without.
                email: row.Email
            });

            if (
                badge.role === 'user' &&
                badge.tier === TIER_IDS.FREE &&
                !badge.cosmetics &&
                !badge.isNew &&
                // A bot has nothing else to say and still must say this one:
                // dropping it here is what would leave a bot indistinguishable
                // from a person in every list on the site.
                !badge.isBot
            ) {
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
