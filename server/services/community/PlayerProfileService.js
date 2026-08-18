/**
 * ARCHON: public player profile (`/players/:username`).
 *
 * A competitive platform is built on players looking each other up, and until
 * now no username anywhere on the site was clickable - there was no player page
 * to click through to.
 *
 * This service deliberately covers only the parts of a profile that nothing
 * else already serves: the header (avatar, location, joined date) and the
 * player's recent games. Amber, statistics and tournament trophies already have
 * their own public endpoints (/api/ratings/:username, /api/stats/player/:username,
 * /api/tournaments/history/:username) and the profile page composes those rather
 * than this service reaching across into four other domains.
 *
 * Privacy: only fields that are already public site behaviour - never email,
 * IP, password state or linked-identity data. Disabled accounts do not resolve,
 * matching the member directory and the leaderboards.
 */
const logger = require('../../log');
const { publicBadge, permissionsFromRoleNames } = require('../membership/publicBadge');
const { membershipFromDbRow } = require('../membership/mapRow');
const { resolveEntitlements } = require('../membership/entitlements');
// ARCHON (N12): profile cosmetics - what profile_cosmetics actually buys.
const { resolveCosmetics, bioMaxLength } = require('../membership/cosmetics');
const ProfileCosmeticsService = require('./ProfileCosmeticsService');

class PlayerProfileService {
    constructor(db = require('../../db'), cosmeticsService = new ProfileCosmeticsService(db)) {
        this.db = db;
        this.cosmeticsService = cosmeticsService;
    }

    /**
     * Profile header + clubs + recent games, or null when the account does not
     * exist, is disabled, or is unverified (the same population the member
     * directory lists).
     */
    async getProfile(username) {
        if (!username) {
            return null;
        }

        const rows = await this.db.query(
            'SELECT "Id", "Username", "Settings_Avatar", "Country", "State", "Bio", "Registered" ' +
                'FROM "Users" WHERE lower("Username") = lower($1) ' +
                'AND "Disabled" IS NOT TRUE AND "Verified" IS TRUE',
            [username]
        );

        const user = rows && rows[0];

        if (!user) {
            return null;
        }

        const [clubs, recentGames, identity] = await Promise.all([
            this.getClubs(user.Id),
            this.getRecentGames(user.Id),
            this.getIdentity(user.Id)
        ]);
        const badge = identity.badge;

        return {
            username: user.Username,
            avatar: user.Settings_Avatar,
            country: user.Country,
            state: user.State,
            bio: user.Bio || null,
            joined: user.Registered,
            role: badge.role,
            tier: badge.tier,
            tierName: badge.tierName,
            // ARCHON (N12): already filtered against what this account may
            // currently use, so a lapsed pledge renders a plain profile.
            cosmetics: identity.cosmetics,
            clubs,
            recentGames
        };
    }

    /**
     * ARCHON (N12): the badge shown next to this player's name.
     *
     * The Supporter tier sells "show your support next to your name in the
     * lobby and on your profile". The lobby half worked through User.role; the
     * profile half did not exist, because this payload carried no role at all -
     * so half of a live paid promise was unkept.
     *
     * Two sources, because there are two ways to be a supporter: the granted
     * Roles-table row, and a Patreon membership that carries the badge
     * capability. Both land on the same string, and the same colours the lobby
     * uses.
     *
     * @returns {Promise<{role: string, tier: string, tierName: string|null}>}
     */
    async getBadge(userId) {
        const { permissions, membership, registered, email } = await this.loadMembershipState(
            userId
        );

        return publicBadge({ permissions, membership, registered, email });
    }

    /**
     * ARCHON (N12): the badge AND the cosmetics, from one load.
     *
     * Both answers come out of the same two rows - roles and membership - so
     * asking for them separately would double the queries on the one page that
     * always wants both.
     *
     * ## Why cosmetics resolve differently from the badge
     *
     * `publicBadge` deliberately strips the admin override: an admin resolves
     * to the highest tier internally, and rendering that publicly would label
     * every administrator a paying Vault Master, which is a claim about money.
     *
     * Cosmetics make no claim about money - an accent colour says nothing about
     * anybody's billing - so they resolve against the account's real
     * entitlements, admin override included. Doing it the other way round
     * produces the genuinely confusing outcome: an admin picks a frame in an
     * editor that offers it to them, saves successfully, and then cannot find
     * it on their own profile.
     *
     * @returns {Promise<{badge: object, cosmetics: object}>}
     */
    async getIdentity(userId) {
        const { permissions, membership, registered, email } = await this.loadMembershipState(
            userId
        );
        const entitlements = resolveEntitlements({ user: { permissions }, membership });
        const stored = await this.cosmeticsService.get(userId);

        return {
            badge: publicBadge({ permissions, membership, registered, email }),
            cosmetics: resolveCosmetics(stored, entitlements.capabilities)
        };
    }

    /**
     * Roles and membership for one account, as the permissions shape the
     * membership code reads.
     *
     * Both lookups are best-effort: a profile that renders without a badge is
     * fine, one that 500s is not, and the Memberships migration may not have
     * run on this deployment.
     */
    async loadMembershipState(userId) {
        let roleNames = [];
        let membership;
        let registered = null;
        let email = null;

        try {
            const rows = await this.db.query(
                'SELECT r."Name" FROM "UserRoles" ur JOIN "Roles" r ON r."Id" = ur."RoleId" ' +
                    'WHERE ur."UserId" = $1',
                [userId]
            );

            roleNames = (rows || []).map((row) => row.Name);
        } catch (err) {
            logger.warn('Failed to look up roles for player profile', err);
        }

        try {
            const rows = await this.db.query('SELECT * FROM "Memberships" WHERE "UserId" = $1', [
                userId
            ]);

            membership = membershipFromDbRow(rows && rows[0]);
        } catch (err) {
            logger.warn('Failed to look up membership for player profile', err);
        }

        // ARCHON (N20): when the account was created, for the New pill. Same
        // fail-soft posture as the rest: a profile with no pill still works.
        // ARCHON (F9): the email rides along for the BOT pill - one row read,
        // two things a badge needs.
        try {
            const rows = await this.db.query(
                'SELECT "Registered", "Email" FROM "Users" WHERE "Id" = $1',
                [userId]
            );

            registered = rows && rows[0] ? rows[0].Registered : null;
            email = rows && rows[0] ? rows[0].Email : null;
        } catch (err) {
            logger.warn('Failed to look up registration date for player profile', err);
        }

        return {
            permissions: permissionsFromRoleNames(roleNames),
            membership: membership || null,
            registered,
            email
        };
    }

    /** @deprecated use getBadge - kept so the role alone is still one call. */
    async getRole(userId) {
        return (await this.getBadge(userId)).role;
    }

    /** The bio as the account owner would edit it (no public/disabled gating). */
    async getBio(userId) {
        const rows = await this.db.query('SELECT "Bio" FROM "Users" WHERE "Id" = $1', [userId]);

        return (rows && rows[0] && rows[0].Bio) || null;
    }

    /**
     * @param {number} userId
     * @param {string|null} bio
     * @param {string[]} [capabilities] the author's entitlements. A member gets
     *        a longer bio (profile_cosmetics); omitted means the free limit,
     *        which is what every caller predating memberships wants.
     */
    async setBio(userId, bio, capabilities = []) {
        const limit = bioMaxLength(capabilities);
        const normalizedBio = bio ? String(bio).trim().slice(0, limit) || null : null;

        await this.db.query('UPDATE "Users" SET "Bio" = $1 WHERE "Id" = $2', [
            normalizedBio,
            userId
        ]);

        return { success: true, bio: normalizedBio };
    }

    async getClubs(userId) {
        const rows = await this.db.query(
            'SELECT c."Id", c."Name", m."Role" FROM "ClubMembers" m ' +
                'JOIN "Clubs" c ON c."Id" = m."ClubId" WHERE m."UserId" = $1 ORDER BY c."Name"',
            [userId]
        );

        return (rows || []).map((row) => ({
            id: row.Id,
            name: row.Name,
            role: row.Role
        }));
    }

    /**
     * The player's last finished games, from their side: who they played, what
     * they played, whether they won, and the game id so the row can link
     * through to the replay.
     */
    async getRecentGames(userId, limit = 10) {
        const rows = await this.db.query(
            'SELECT g."GameId", g."GameFormat", g."FinishedAt", g."WinReason", ' +
                '(g."WinnerId" = $1) AS "Won", ' +
                'me."Keys" AS "OwnKeys", opp."Keys" AS "OpponentKeys", ' +
                'ou."Username" AS "Opponent", d."Name" AS "DeckName" ' +
                'FROM "Games" g ' +
                'JOIN "GamePlayers" me ON me."GameId" = g."Id" AND me."PlayerId" = $1 ' +
                'LEFT JOIN "GamePlayers" opp ON opp."GameId" = g."Id" AND opp."PlayerId" <> $1 ' +
                'LEFT JOIN "Users" ou ON ou."Id" = opp."PlayerId" ' +
                'LEFT JOIN "Decks" d ON d."Id" = me."DeckId" ' +
                'WHERE g."FinishedAt" IS NOT NULL AND g."WinnerId" IS NOT NULL ' +
                'ORDER BY g."FinishedAt" DESC LIMIT $2',
            [userId, limit]
        );

        return (rows || []).map((row) => ({
            gameId: row.GameId,
            format: row.GameFormat,
            finishedAt: row.FinishedAt,
            winReason: row.WinReason,
            won: row.Won,
            keys: row.OwnKeys,
            opponentKeys: row.OpponentKeys,
            opponent: row.Opponent,
            deckName: row.DeckName
        }));
    }
}

module.exports = PlayerProfileService;
