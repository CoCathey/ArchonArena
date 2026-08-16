const moment = require('moment');
const crypto = require('crypto');
const EventEmitter = require('events');

const logger = require('../log');
const { membershipFromDbRow } = require('./membership/mapRow');
// ARCHON (N12): profile cosmetics, loaded with the user so a lobby seat can
// render them without a lookup per player.
const { cosmeticsFromDbRow } = require('./community/ProfileCosmeticsService');
const User = require('../models/User');
const db = require('../db');
const { expand } = require('../Array');
const SecretBox = require('./crypto/secretBox');

class UserService extends EventEmitter {
    constructor(configService) {
        super();

        this.configService = configService;
        // ARCHON: the same seal the DoK key uses, applied to the Patreon token
        // as well. It is the same kind of value - a live credential for
        // somebody else's account that has to come back out in plaintext - and
        // leaving two standards in one table was the wrong half of a decision.
        // SecretBox passes unrecognised values straight through, so tokens
        // stored before this are read exactly as before and are sealed the next
        // time they are written. No rewrite migration, and nothing to undo if
        // the site secret ever changes: an unreadable token relinks.
        // Tolerant of a config service that is a stub or absent: this class is
        // constructed in a lot of places, and a missing secret already means
        // "decline to seal anything", which is the correct answer here too.
        this.secretBox = new SecretBox(
            typeof configService?.getValue === 'function' ? configService.getValue('secret') : null
        );
    }

    /**
     * ARCHON: the stored Patreon token, sealed or legacy plaintext.
     *
     * Returns undefined rather than throwing on anything unreadable - a token
     * written under a site secret that has since been rotated, or a row damaged
     * some other way. This is on the path that builds every user object, so a
     * throw here would be a login failure rather than a lost supporter badge,
     * and relinking Patreon is a button. Losing the badge is the recoverable
     * outcome; losing the account is not.
     */
    readPatreonToken(stored) {
        if (!stored) {
            return undefined;
        }

        const token = this.secretBox.decrypt(stored);

        if (!token) {
            return undefined;
        }

        try {
            return JSON.parse(token);
        } catch {
            return undefined;
        }
    }

    async doesUserExist(username) {
        let rows;

        try {
            rows = await db.query('SELECT 1 FROM "Users" WHERE Lower("Username") = Lower($1)', [
                username
            ]);
        } catch (err) {
            logger.error('Failed to lookup user', err);
            return null;
        }

        return rows && rows.length > 0;
    }

    async doesEmailExist(email) {
        let rows;

        try {
            rows = await db.query('SELECT 1 FROM "Users" WHERE Lower("Email") = Lower($1)', [
                email
            ]);
        } catch (err) {
            logger.error('Failed to lookup email', err);
            return null;
        }

        return rows && rows.length > 0;
    }

    async getUserByUsername(username) {
        let rows;

        try {
            rows = await db.query('SELECT * FROM "Users" WHERE Lower("Username") = Lower($1)', [
                username
            ]);
        } catch (err) {
            logger.error('Failed to lookup user', err);
            return null;
        }

        if (rows === null || rows.length === 0) {
            return null;
        }

        return this.getUserFromDbUser(rows[0]);
    }

    async getFullUserByUsername(username) {
        let user = await this.getUserByUsername(username);

        if (!user) {
            return user;
        }

        await this.populatedLinkedUserDetails(user);

        return new User(user);
    }

    async getUserByEmail(email) {
        let rows;

        try {
            rows = await db.query('SELECT * FROM "Users" WHERE Lower("Email") = Lower($1)', [
                email
            ]);
        } catch (err) {
            logger.error('Failed to lookup user', err);
            return null;
        }

        if (rows === null || rows.length === 0) {
            return null;
        }

        return this.getUserFromDbUser(rows[0]);
    }

    async getUserById(id) {
        let rows;

        try {
            rows = await db.query('SELECT * FROM "Users" WHERE "Id" = $1', [id]);
        } catch (err) {
            logger.error('Failed to lookup user', err);
            return null;
        }

        if (rows === null || rows.length === 0) {
            return null;
        }

        let user = this.getUserFromDbUser(rows[0]);

        if (!user) {
            return user;
        }

        await this.populatedLinkedUserDetails(user);

        return new User(user);
    }

    async getPossiblyLinkedAccounts(user) {
        let users = [];
        try {
            const query =
                'SELECT DISTINCT u."Username" FROM "RefreshToken" rt ' +
                'JOIN "RefreshToken" rt2 ON rt."Ip" = rt2."Ip" ' +
                'JOIN "Users" u ON u."Id" = rt2."UserId" ' +
                'WHERE rt."UserId" = $1 and rt2."UserId" != $1';
            users = await db.query(query, [user.id]);
        } catch (err) {
            logger.error('Error finding related ips', err, user.username);
        }

        return users.map((u) => ({ username: u.Username }));
    }

    async addUser(user) {
        let ret = await db.query(
            'INSERT INTO "Users" ' +
                '("Username", "Password", "Email", "Registered", "RegisterIp", "Settings_Avatar", ' +
                // ARCHON: TermsAcceptedAt records that this account agreed to
                // the Terms of Service at sign-up. Stamped here rather than
                // trusting a client-supplied flag.
                '"Verified", "ActivationToken", "ActivationTokenExpiry", "TermsAcceptedAt") VALUES ' +
                '($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING "Id"',
            [
                user.username,
                user.password,
                user.email,
                user.registered,
                user.registerIp,
                user.avatar,
                user.verified,
                user.activationToken,
                user.activationTokenExpiry,
                user.termsAcceptedAt || user.registered
            ]
        );

        user.id = ret[0].Id;

        return user;
    }

    async update(user) {
        let client = await db.startTransaction();

        let query =
            'UPDATE "Users" SET "Username" = $1, "Email" = $2, "Verified" = $3, "Disabled" = $4, "Settings_Avatar" = $5, ' +
            '"Settings_CardSize" = $6, "Settings_Background" = $7, "Settings_OrderAbilities" = $8, "Settings_ConfirmOneClick" = $9, "Settings_UseHalfSizedCards" = $10, ' +
            '"Settings_ShowAccolades" = $11, "PatreonToken" = $12, "Settings_CustomBackground" = $13, ' +
            '"Settings_HideHandOnOpponentTurn" = $14 WHERE "Id" = $15';

        try {
            await db.queryTran(client, query, [
                user.username,
                user.email,
                user.verified,
                user.disabled,
                user.settings.avatar,
                user.settings.cardSize,
                user.settings.background,
                user.settings.optionSettings.orderForcedAbilities,
                user.settings.optionSettings.confirmOneClick,
                user.settings.optionSettings.useHalfSizedCards,
                user.settings.optionSettings.showAccolades !== undefined
                    ? user.settings.optionSettings.showAccolades
                    : true,
                user.patreon ? this.secretBox.encrypt(JSON.stringify(user.patreon)) : null,
                user.settings.customBackground,
                // ARCHON: hide your own hand on the opponent's turn. Defaults
                // off, so an account that has never touched it keeps the
                // behaviour it has always had.
                !!user.settings.optionSettings.hideHandOnOpponentTurn,
                user.id
            ]);
        } catch (err) {
            logger.error('Failed to update user', err);

            await db.queryTran(client, 'ROLLBACK');
        }

        if (user.password && user.password !== '') {
            try {
                this.setPassword(user, user.password);
            } catch (err) {
                logger.error('Failed to update user password', err);

                await db.queryTran(client, 'ROLLBACK');
            }
        }

        let permissions;
        let existingPermissions;
        try {
            permissions = await db.queryTran(
                client,
                'SELECT r."Name" FROM "UserRoles" ur JOIN "Roles" r ON r."Id" = ur."RoleId" WHERE ur."UserId" = $1',
                [user.id]
            );
        } catch (err) {
            logger.error('Failed to lookup permissions for user', err);
        }

        if (permissions) {
            // Diff against the roles actually present in UserRoles (no Admin
            // cascade), so that demoting/removing roles on a superuser account
            // computes the correct add/remove set instead of treating every
            // implied permission as a phantom existing row.
            existingPermissions = this.mapPermissions(permissions, { cascade: false });
        } else {
            existingPermissions = {};
        }

        let existing = [];

        for (let permission of Object.keys(existingPermissions)) {
            if (existingPermissions[permission]) {
                existing.push(permission);
            }
        }

        let newPerms = [];
        for (let permission of Object.keys(user.permissions || {})) {
            if (user.permissions[permission]) {
                newPerms.push(permission);
            }
        }

        let toRemove = new Set([...existing].filter((x) => !new Set([...newPerms]).has(x)));
        let toAdd = new Set([...newPerms].filter((x) => !new Set([...existing]).has(x)));

        let params = [];
        for (let permission of toAdd) {
            params.push(user.id);
            params.push(this.permissionToRole(permission));
        }

        if (toAdd.size > 0) {
            try {
                await db.queryTran(
                    client,
                    `INSERT INTO "UserRoles" ("UserId", "RoleId") VALUES ${expand(toAdd.size, 2)}`,
                    params
                );
            } catch (err) {
                logger.error('Failed to set permissions', err);

                await db.queryTran(client, 'ROLLBACK');

                throw new Error('Failed to set permissions');
            }
        }

        if (toRemove.size > 0) {
            const deleteStr = Array.from(toRemove)
                .map((perm) => this.permissionToRole(perm))
                .join(', ');
            try {
                await db.queryTran(
                    client,
                    `DELETE FROM "UserRoles" WHERE "UserId" = $1 AND "RoleId" IN (${deleteStr})`,
                    [user.id]
                );
            } catch (err) {
                logger.error('Failed to set permissions', err);

                await db.queryTran(client, 'ROLLBACK');

                throw new Error('Failed to set permissions');
            }
        }

        await db.queryTran(client, 'COMMIT');
        await client.release();
    }

    async addBlocklistEntry(user, entry) {
        try {
            await db.query('INSERT INTO "BlockList" ("UserId", "Entry") VALUES ($1, $2)', [
                user.id,
                entry
            ]);
        } catch (err) {
            logger.warn('Failed to add blocklist entry', err);

            throw new Error('Error adding blocklist entry');
        }
    }

    async deleteBlocklistEntry(user, entry) {
        try {
            await db.query('DELETE FROM "BlockList" WHERE "UserId" = $1 AND "Entry" = $2', [
                user.id,
                entry
            ]);
        } catch (err) {
            logger.warn('Failed to remove blocklist entry', err);

            throw new Error('Error removing blocklist entry');
        }
    }

    async setResetToken(user, token, tokenExpiration) {
        try {
            await db.query(
                'UPDATE "Users" SET "ResetToken" = $1, "TokenExpires" = $2 WHERE "Id" = $3',
                [token, tokenExpiration, user.id]
            );
        } catch (err) {
            logger.error('Failed to set reset token', err);

            throw new Error('Error setting reset token');
        }
    }

    async clearResetToken(user) {
        try {
            await db.query(
                'UPDATE "Users" SET "ResetToken" = NULL, "TokenExpires" = NULL WHERE "Id" = $1',
                [user.id]
            );
        } catch (err) {
            logger.error('Failed to clear reset token', err);

            throw new Error('Error clearing reset token');
        }
    }

    setPassword(user, password) {
        try {
            return db.query('UPDATE "Users" SET "Password" = $1 WHERE "Id" = $2', [
                password,
                user.id
            ]);
        } catch (err) {
            logger.error('Failed to update user password', err);

            throw new Error('failed to update user password');
        }
    }

    async activateUser(user) {
        try {
            await db.query(
                // ARCHON: this named "ActivationExpiry", which is not a column
                // on Users - the column is "ActivationTokenExpiry". Every
                // activation therefore threw and reported a generic failure.
                'UPDATE "Users" SET "ActivationToken" = NULL, "ActivationTokenExpiry" = NULL, ' +
                    '"Verified" = true WHERE "Id" = $1',
                [user.id]
            );
        } catch (err) {
            logger.error('Failed to activate user', err);

            throw new Error('Error activating user');
        }
    }

    /**
     * ARCHON: re-issue an activation token, for the resend endpoint.
     *
     * Guarded on "Verified" = false so a resend can never reopen an account
     * that is already activated, however stale the caller's view of the user
     * is. Returns whether a row was actually updated.
     */
    async setActivationToken(userId, token, tokenExpiry) {
        try {
            const rows = await db.query(
                'UPDATE "Users" SET "ActivationToken" = $1, "ActivationTokenExpiry" = $2 ' +
                    'WHERE "Id" = $3 AND "Verified" = false RETURNING "Id"',
                [token, tokenExpiry, userId]
            );

            return !!(rows && rows.length > 0);
        } catch (err) {
            logger.error('Failed to set activation token', err);

            throw new Error('Error setting activation token');
        }
    }

    /**
     * ARCHON: undo a registration whose activation email could not be sent.
     *
     * Deliberately narrow: it will only remove an account that is still
     * unverified and has an activation token outstanding, so it can never be
     * turned into a way to delete a real player. A brand-new account has no
     * decks, games or ratings attached, so there is nothing to cascade.
     */
    async deleteUnverifiedUser(userId) {
        try {
            const rows = await db.query(
                'DELETE FROM "Users" WHERE "Id" = $1 AND "Verified" = false ' +
                    'AND "ActivationToken" IS NOT NULL RETURNING "Id"',
                [userId]
            );

            return !!(rows && rows.length > 0);
        } catch (err) {
            logger.error('Failed to roll back an unverified registration', err);

            return false;
        }
    }

    async clearUserSessions(username) {
        let user = await this.getFullUserByUsername(username);

        if (!user) {
            throw 'User not found';
        }

        try {
            await db.query('DELETE FROM "RefreshToken" WHERE "UserId" = $1', [user.id]);
        } catch (err) {
            logger.error('Failed to clear user sessions', err);
        }
    }

    async addRefreshToken(user, token, ip) {
        let expiration = moment().utc().add(1, 'months');
        let hmac = crypto.createHmac(
            'sha512',
            this.configService.getValueForSection('lobby', 'hmacSecret')
        );

        let tokenId = crypto.randomUUID();

        let encodedToken = hmac.update(`REFRESH ${user.username} ${tokenId}`).digest('hex');
        let res = await db.query(
            'INSERT INTO "RefreshToken" ("UserId", "Token", "TokenId", "Expiry", "Ip", "LastUsed") VALUES ($1, $2, $3, $4, $5, $6) RETURNING "Id"',
            [user.id, encodedToken, tokenId, expiration, ip, new Date()]
        );

        return {
            id: res[0].Id,
            username: user.username,
            token: encodedToken
        };
    }

    /**
     * Verify a refresh token presented on POST /api/account/token.
     *
     * @param {string} username the account the caller claims to be
     * @param {object} refreshToken the stored token row for that account
     *        (from mapTokens: { id, token, tokenId, expiry, ... })
     * @param {string} providedToken the secret token value the caller sends
     *        back (the `token` string they received at login)
     *
     * SECURITY: the caller MUST prove possession of the secret token value.
     * Previously this only recomputed the HMAC from the stored row's own
     * fields and compared it to that same row - a tautology that always
     * passed - so anyone who knew a username and a (sequential, guessable)
     * token id could mint a session for that account. We now constant-time
     * compare the caller-supplied secret against the stored token, and we
     * enforce expiry against the correct field (`expiry`; the old `exp`
     * lookup was always undefined, so tokens never expired).
     */
    verifyRefreshToken(username, refreshToken, providedToken) {
        if (!refreshToken || typeof refreshToken.token !== 'string') {
            return false;
        }

        let hmac = crypto.createHmac(
            'sha512',
            this.configService.getValueForSection('lobby', 'hmacSecret')
        );
        let encodedToken = hmac.update(`REFRESH ${username} ${refreshToken.tokenId}`).digest('hex');

        // Integrity: the stored token must be the HMAC of (username, tokenId).
        if (!this.constantTimeEquals(encodedToken, refreshToken.token)) {
            return false;
        }

        // Possession: the caller must present the same secret value they were
        // issued at login. This is the check that actually gates the refresh.
        if (!this.constantTimeEquals(String(providedToken || ''), refreshToken.token)) {
            return false;
        }

        // Expiry. mapTokens exposes the column as `expiry`; keep `exp` as a
        // fallback for any legacy caller shape.
        const expiry = refreshToken.expiry || refreshToken.exp;
        if (!expiry || moment(expiry).utc().isBefore(moment().utc())) {
            return false;
        }

        return true;
    }

    /**
     * Constant-time string comparison that never throws on length mismatch.
     */
    constantTimeEquals(a, b) {
        const bufferA = Buffer.from(String(a), 'utf8');
        const bufferB = Buffer.from(String(b), 'utf8');

        if (bufferA.length !== bufferB.length) {
            return false;
        }

        return crypto.timingSafeEqual(bufferA, bufferB);
    }

    async updateRefreshTokenUsage(tokenId, ip) {
        try {
            await db.query(
                'UPDATE "RefreshToken" SET "Ip" = $1, "LastUsed" = $2 WHERE "TokenId" = $3',
                [ip, new Date(), tokenId]
            );
        } catch (err) {
            logger.error('Error saving token usage', err);
        }
    }

    async getRefreshTokenById(userId, tokenId) {
        let tokens;

        try {
            tokens = await db.query(
                'SELECT * FROM "RefreshToken" WHERE "Id" = $1 AND "UserId" = $2',
                [tokenId, userId]
            );
        } catch (err) {
            logger.error('Failed to get refresh token by id');
        }

        if (!tokens || tokens.length === 0) {
            return undefined;
        }

        const token = tokens[0];

        return {
            id: token.Id,
            tokenId: token.TokenId,
            expiry: token.Expiry,
            lastUsed: token.LastUsed,
            ip: token.Ip
        };
    }

    async removeRefreshToken(userId, tokenId) {
        try {
            await db.query('DELETE FROM "RefreshToken" WHERE "Id" = $1 AND "UserId" = $2', [
                tokenId,
                userId
            ]);
        } catch (err) {
            logger.error('Failed to remove refresh token');
        }
    }

    async setSupporterStatus(userId, isSupporter) {
        let supporterRoles = await db.query(
            'SELECT 1 FROM "UserRoles" ur JOIN "Roles" r ON r."Id" = ur."RoleId" WHERE "UserId" = $1 AND r."Name" = \'Supporter\'',
            [userId]
        );
        let isExistingSupporter = supporterRoles && supporterRoles.length > 0;

        if (isExistingSupporter && !isSupporter) {
            try {
                await db.query(
                    'DELETE FROM "UserRoles" ur USING "Roles" r WHERE r."Id" = ur."RoleId" AND "UserId" = $1 AND r."Name" = ' +
                        "'Supporter'",
                    [userId]
                );
            } catch (err) {
                logger.error('Failed to remove supporter status', err);

                throw new Error('Failed to remove supporter status');
            }
        } else if (!isExistingSupporter && isSupporter) {
            try {
                await db.query(
                    'INSERT INTO "UserRoles" ("UserId", "RoleId") VALUES ($1, (SELECT "Id" FROM "Roles" WHERE "Name" = \'Supporter\'))',
                    [userId]
                );
            } catch (err) {
                logger.error('Failed to add supporter status', err);

                throw new Error('Failed to add supporter status');
            }
        }
    }

    async cleanupRefreshTokens() {
        await db.query('DELETE FROM "RefreshToken" WHERE "Expiry" < current_date');
    }

    // ARCHON: first-run wizard (Phase 9 onboarding). Idempotent: only the
    // first completion stamps the timestamp.
    async setOnboarded(userId) {
        await db.query(
            'UPDATE "Users" SET "OnboardedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1 AND "OnboardedAt" IS NULL',
            [userId]
        );
    }

    // ARCHON: remember the Decks of KeyForge account a user imported from so
    // they can re-sync new decks later.
    async setDokUsername(userId, dokUsername) {
        await db.query('UPDATE "Users" SET "DokUsername" = $1 WHERE "Id" = $2', [
            dokUsername || null,
            userId
        ]);
    }

    /**
     * ARCHON: the player's stored Decks of KeyForge link (docs/design/dok-import.md).
     *
     * The key arrives already sealed - this service writes what it is given and
     * never sees a plaintext credential, so there is exactly one place that
     * decides how the secret is protected. Storing a key clears any previous
     * rejection: a new key is the answer to "the old one stopped working", and
     * leaving the flag set would keep the schedule stopped for a key that is
     * fine.
     */
    async setDokLink(userId, { sealedApiKey, autoSync }) {
        await db.query(
            'UPDATE "Users" SET "DokApiKey" = $1, "DokAutoSync" = $2, ' +
                '"DokKeyRejectedAt" = NULL WHERE "Id" = $3',
            [sealedApiKey || null, !!autoSync, userId]
        );
    }

    async getDokLink(userId) {
        const rows = await db.query(
            'SELECT "DokApiKey", "DokAutoSync", "DokLastSyncAt", "DokKeyRejectedAt" ' +
                'FROM "Users" WHERE "Id" = $1',
            [userId]
        );
        const row = rows && rows[0];

        if (!row) {
            return null;
        }

        return {
            sealedApiKey: row.DokApiKey || null,
            hasKey: !!row.DokApiKey,
            autoSync: !!row.DokAutoSync,
            lastSyncAt: row.DokLastSyncAt,
            keyRejectedAt: row.DokKeyRejectedAt
        };
    }

    /** Forget the key entirely. Turning the schedule off is not enough - a
     *  player asking us to forget their credential means remove it. */
    async clearDokLink(userId) {
        await db.query(
            'UPDATE "Users" SET "DokApiKey" = NULL, "DokAutoSync" = false, ' +
                '"DokKeyRejectedAt" = NULL WHERE "Id" = $1',
            [userId]
        );
    }

    async markDokSynced(userId) {
        await db.query(
            'UPDATE "Users" SET "DokLastSyncAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
            [userId]
        );
    }

    /**
     * DoK has refused this key. The key is dropped as well as flagged: it can
     * never start working again (DoK voided it the moment a new one was
     * generated), so keeping it only risks it being tried again by some later
     * code path. The timestamp is what the UI reads to ask for a new one.
     */
    async markDokKeyRejected(userId) {
        await db.query(
            'UPDATE "Users" SET "DokApiKey" = NULL, ' +
                '"DokKeyRejectedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
            [userId]
        );
    }

    /**
     * Players whose collection is due a refresh, least recently synced first.
     * Never-synced accounts sort ahead of everyone (NULLS FIRST), so linking an
     * account gets you a sync rather than a wait.
     */
    async findDokAutoSyncDue(olderThan, limit) {
        const rows = await db.query(
            'SELECT "Id", "Username", "DokApiKey" FROM "Users" ' +
                'WHERE "DokAutoSync" AND "DokApiKey" IS NOT NULL AND "DokKeyRejectedAt" IS NULL ' +
                'AND ("DokLastSyncAt" IS NULL OR "DokLastSyncAt" <= $1) ' +
                'ORDER BY "DokLastSyncAt" ASC NULLS FIRST LIMIT $2',
            [olderThan, limit]
        );

        return (rows || []).map((row) => ({
            id: row.Id,
            username: row.Username,
            sealedApiKey: row.DokApiKey
        }));
    }

    async anonymizeUser(user, options = {}) {
        const client = await db.startTransaction();
        const anonymizedUsername = options.username || `deleted-user-${user.id}`;
        const anonymizedEmail = options.email || `deleted-user-${user.id}@example.invalid`;

        try {
            await db.queryTran(
                client,
                // DokApiKey belongs on this list for the same reason PatreonToken
                // does: it is a live credential for somebody else's account, and
                // a deleted user's must not outlive them.
                //
                // ARCHON: Bio, Country, State and DokUsername were missing, and
                // the first three are exactly what PlayerProfileService selects
                // for the PUBLIC profile - so a deleted account kept showing the
                // biography and location its owner had written, under the name
                // `deleted-user-N`. DokUsername is a third party's handle for
                // the same person and goes with the rest of their identity.
                'UPDATE "Users" SET "Username" = $1, "Email" = $2, "Password" = NULL, "Verified" = false, "Disabled" = true, "Settings_Avatar" = NULL, "Settings_CustomBackground" = NULL, "Bio" = NULL, "Country" = NULL, "State" = NULL, "DokUsername" = NULL, "PatreonToken" = NULL, "DokApiKey" = NULL, "DokAutoSync" = false, "ResetToken" = NULL, "TokenExpires" = NULL, "ActivationToken" = NULL, "ActivationTokenExpiry" = NULL, "RegisterIp" = NULL, "DeletedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $3',
                [anonymizedUsername, anonymizedEmail, user.id]
            );

            await db.queryTran(client, 'DELETE FROM "UserRoles" WHERE "UserId" = $1', [user.id]);
            await db.queryTran(client, 'DELETE FROM "RefreshToken" WHERE "UserId" = $1', [user.id]);
            await db.queryTran(client, 'DELETE FROM "BlockList" WHERE "UserId" = $1', [user.id]);

            // ARCHON: a linked SSO identity is both personal data and a live way
            // back in. The OIDC callback refuses a disabled account, so leaving
            // the row was not a takeover - it was worse in a quieter way: the
            // identity stayed bound to the dead account forever (linkIdentity
            // does ON CONFLICT DO NOTHING), so somebody who deleted their
            // account and signed up again could never use SSO again. They got
            // "This account is disabled" for an account they no longer had.
            await db.queryTran(client, 'DELETE FROM "UserOidcIdentities" WHERE "UserId" = $1', [
                user.id
            ]);

            // Their devices must stop ringing. The FK cascades on a real row
            // delete, but this anonymises rather than deletes, so nothing was
            // firing and a deleted account's phone kept receiving its pairings.
            await db.queryTran(client, 'DELETE FROM "PushTokens" WHERE "UserId" = $1', [user.id]);

            // The in-app notification centre holds opponent names, event names
            // and match times - other people's business as much as theirs.
            await db.queryTran(client, 'DELETE FROM "Notifications" WHERE "UserId" = $1', [
                user.id
            ]);

            // ARCHON: the membership row. The delete screen tells the player
            // their linked Patreon is erased, and PatreonToken above is - but
            // the resolved tier lived on separately, so a deleted account still
            // resolved to Archon and its capabilities. Note this ends the
            // ENTITLEMENT, not the pledge: only Patreon can cancel the billing,
            // which is why the app says so before asking for a password.
            await db.queryTran(client, 'DELETE FROM "Memberships" WHERE "UserId" = $1', [user.id]);

            // Their chosen banner, accent, frame and title. Cosmetic, but it
            // is a choice they made about how they appear, and a tombstone
            // wearing somebody's old colours is not anonymous.
            await db.queryTran(client, 'DELETE FROM "ProfileCosmetics" WHERE "UserId" = $1', [
                user.id
            ]);

            // A deleted player should leave everyone's friends list rather than
            // sit in it as `deleted-user-N`, and the edge says who they knew.
            await db.queryTran(
                client,
                'DELETE FROM "Friendships" WHERE "RequesterId" = $1 OR "AddresseeId" = $1',
                [user.id]
            );

            await db.queryTran(client, 'COMMIT');
            await client.release();
        } catch (err) {
            logger.error('Failed to anonymize user', err);
            await db.queryTran(client, 'ROLLBACK');
            await client.release();
            throw new Error('Failed to anonymize user');
        }

        return { username: anonymizedUsername, email: anonymizedEmail };
    }

    async populatedLinkedUserDetails(user) {
        let tokens;
        try {
            tokens = await db.query('SELECT * FROM "RefreshToken" WHERE "UserId" = $1', [user.id]);
        } catch (err) {
            logger.error('Failed to lookup tokens for user', err);
        }

        if (tokens) {
            user.tokens = this.mapTokens(tokens);
        } else {
            user.tokens = [];
        }

        let blockList;
        try {
            blockList = await db.query('SELECT * FROM "BlockList" WHERE "UserId" = $1', [user.id]);
        } catch (err) {
            logger.error('Failed to lookup blocklist for user', err);
        }

        if (blockList) {
            user.blockList = blockList.map((bl) => bl.Entry);
        } else {
            user.blockList = [];
        }

        let permissions;
        try {
            permissions = await db.query(
                'SELECT r."Name" FROM "UserRoles" ur JOIN "Roles" r ON r."Id" = ur."RoleId" WHERE ur."UserId" = $1',
                [user.id]
            );
        } catch (err) {
            logger.error('Failed to lookup permissions for user', err);
        }

        if (permissions) {
            user.permissions = this.mapPermissions(permissions);
        } else {
            user.permissions = {};
        }

        // ARCHON (N12): the premium membership, loaded here so that
        // User.getWireSafeDetails can resolve entitlements synchronously and
        // every path to the client agrees about them.
        //
        // Best-effort: a missing table (the migration has not run yet) or a
        // failed query leaves membership undefined, which resolves to the free
        // tier. Losing premium panels for one request is an acceptable failure;
        // failing to load the user is not. Admins are unaffected either way -
        // their override never reads this.
        try {
            const membership = await db.query('SELECT * FROM "Memberships" WHERE "UserId" = $1', [
                user.id
            ]);

            user.membership = membershipFromDbRow(membership && membership[0]);
        } catch (err) {
            logger.warn('Failed to lookup membership for user', err);
            user.membership = undefined;
        }

        // ARCHON (N12): the account's cosmetic choices, loaded next to the
        // membership because the two are only meaningful together - whether a
        // stored choice is honoured is decided against the entitlements the row
        // above resolves to, so a lapsed member's frame stops rendering without
        // anything being rewritten. Loading it here also keeps
        // User.getShortSummary synchronous, which matters because it runs for
        // every player in every lobby broadcast.
        //
        // Same best-effort contract: a missing table or a failed query leaves
        // the account looking like every other account, which is exactly what
        // the free tier looks like.
        try {
            const cosmetics = await db.query(
                'SELECT * FROM "ProfileCosmetics" WHERE "UserId" = $1',
                [user.id]
            );

            user.cosmetics = cosmeticsFromDbRow(cosmetics && cosmetics[0]);
        } catch (err) {
            logger.warn('Failed to lookup profile cosmetics for user', err);
            user.cosmetics = undefined;
        }
    }

    getUserFromDbUser(dbUser) {
        const user = {
            id: dbUser.Id,
            password: dbUser.Password,
            registered: dbUser.Registered,
            username: dbUser.Username,
            email: dbUser.Email,
            emailHash: dbUser.EmailHash,
            settings: {
                avatar: dbUser.Settings_Avatar,
                background: dbUser.Settings_Background,
                cardSize: dbUser.Settings_CardSize,
                customBackground: dbUser.Settings_CustomBackground,
                optionSettings: {
                    orderForcedAbilities: dbUser.Settings_OrderAbilities,
                    confirmOneClick: dbUser.Settings_ConfirmOneClick,
                    useHalfSizedCards: dbUser.Settings_UseHalfSizedCards,
                    showAccolades:
                        dbUser.Settings_ShowAccolades !== undefined
                            ? dbUser.Settings_ShowAccolades
                            : true,
                    hideHandOnOpponentTurn: !!dbUser.Settings_HideHandOnOpponentTurn
                }
            },
            verified: dbUser.Verified,
            disabled: dbUser.Disabled,
            patreon: this.readPatreonToken(dbUser.PatreonToken),
            resetToken: dbUser.ResetToken,
            tokenExpires: dbUser.TokenExpires,
            activationToken: dbUser.ActivationToken,
            activationTokenExpiry: dbUser.ActivationTokenExpiry,
            registerIp: dbUser.RegisterIp,
            // ARCHON: first-run wizard flag (Phase 9 onboarding)
            onboarded: !!dbUser.OnboardedAt,
            // ARCHON: linked Decks of KeyForge account for bulk deck import
            dokUsername: dbUser.DokUsername || null
        };

        return user;
    }

    mapTokens(dbTokens) {
        return dbTokens.map((token) => ({
            id: token.Id,
            token: token.Token,
            expiry: token.Expiry,
            ip: token.Ip,
            tokenId: token.TokenId,
            lastUsed: token.LastUsed
        }));
    }

    permissionToRole(permission) {
        switch (permission) {
            case 'canManageUsers':
                return 1; //'UserManager';
            case 'canManageBanlist':
                return 2; // 'BanListManager';
            case 'canEditNews':
                return 3; //'NewsManager';
            case 'canManageGames':
                return 4; // 'GameManager';
            case 'canManageMotd':
                return 5; // 'MotdManager';
            case 'canManagePermissions':
                return 6; // 'PermissionsManager';
            case 'canManageNodes':
                return 7; // 'NodeManager';
            case 'canModerateChat':
                return 8; // 'ChatManager';
            case 'canVerifyDecks':
                return 9; // 'DeckVerifier';
            case 'isAdmin':
                return 10; // 'Admin';
            case 'isSupporter':
                return 11; // 'Supporter';
            case 'isContributor':
                return 12; // 'Contributor';
            case 'canManageTournaments':
                return 13; // 'TournamentManager'
            case 'isWinner':
                return 14; // 'TournamentWinner'
            case 'isPreviousWinner':
                return 15; // 'TournamentPreviousWinner'
            case 'keepsSupporterWithNoPatreon':
                return 16; // 'KeepSupporterStatus'
        }
    }

    mapPermissions(permissions, { cascade = true } = {}) {
        let ret = {
            canEditNews: false,
            canManageUsers: false,
            canManagePermissions: false,
            canManageGames: false,
            canManageNodes: false,
            canModerateChat: false,
            canVerifyDecks: false,
            canManageBanlist: false,
            canManageMotd: false,
            canManageTournaments: false,
            isAdmin: false,
            isContributor: false,
            isSupporter: false,
            isWinner: false,
            isPreviousWinner: false,
            keepsSupporterWithNoPatreon: false
        };

        for (let permission of permissions) {
            switch (permission.Name) {
                case 'NewsManager':
                    ret.canEditNews = true;
                    break;
                case 'UserManager':
                    ret.canManageUsers = true;
                    break;
                case 'PermissionsManager':
                    ret.canManagePermissions = true;
                    break;
                case 'GameManager':
                    ret.canManageGames = true;
                    break;
                case 'NodeManager':
                    ret.canManageNodes = true;
                    break;
                case 'ChatManager':
                    ret.canModerateChat = true;
                    break;
                case 'DeckVerifier':
                    ret.canVerifyDecks = true;
                    break;
                case 'BanListManager':
                    ret.canManageBanlist = true;
                    break;
                case 'MotdManager':
                    ret.canManageMotd = true;
                    break;
                case 'Admin':
                    ret.isAdmin = true;
                    break;
                case 'Supporter':
                    ret.isSupporter = true;
                    break;
                case 'Contributor':
                    ret.isContributor = true;
                    break;
                case 'TournamentManager':
                    ret.canManageTournaments = true;
                    break;
                case 'TournamentWinner':
                    ret.isWinner = true;
                    break;
                case 'PreviousTournamentWinner':
                    ret.isPreviousWinner = true;
                    break;
                case 'KeepSupporterStatus':
                    ret.keepsSupporterWithNoPatreon = true;
                    break;
            }
        }

        // ARCHON: the Admin role is a superuser - it implies every management
        // permission, so a single "Admin" grant gives full access without
        // also needing UserManager, NewsManager, etc. individually. This
        // cascade is for runtime authorization only; callers that need the
        // roles actually backed by UserRoles rows (e.g. the permission-diff in
        // update()) pass { cascade: false } to avoid phantom add/remove.
        if (cascade && ret.isAdmin) {
            ret.canEditNews = true;
            ret.canManageUsers = true;
            ret.canManagePermissions = true;
            ret.canManageGames = true;
            ret.canManageNodes = true;
            ret.canModerateChat = true;
            ret.canVerifyDecks = true;
            ret.canManageBanlist = true;
            ret.canManageMotd = true;
            ret.canManageTournaments = true;
        }

        return ret;
    }
}

module.exports = UserService;
