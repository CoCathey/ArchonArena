const passport = require('passport');
const bcrypt = require('bcrypt');

const UserService = require('../services/UserService.js');
const DeckService = require('../services/DeckService.js');
const ConfigService = require('../services/ConfigService.js');
const { wrapAsync } = require('../util.js');
const logger = require('../log.js');
const CardService = require('../services/CardService.js');

let configService = new ConfigService();

let userService = new UserService(configService);
let cardService = new CardService(configService);
let deckService = new DeckService(configService, cardService);

// Management permissions that make an account "staff". A destructive action
// (reset password / delete) may not target an account that holds a permission
// the actor lacks - otherwise a lower-tier staff member (e.g. a UserManager)
// could reset an admin's/owner's password and take over the account, or delete
// an admin. isAdmin implies every management permission, so an admin actor is
// never blocked.
const MANAGEMENT_PERMISSIONS = [
    'isAdmin',
    'canManageUsers',
    'canManagePermissions',
    'canManageGames',
    'canManageNodes',
    'canModerateChat',
    'canVerifyDecks',
    'canManageBanlist',
    'canManageMotd',
    'canEditNews',
    'canManageTournaments'
];

const targetOutranksActor = (targetPermissions, actorPermissions) => {
    const target = targetPermissions || {};
    const actor = actorPermissions || {};

    if (actor.isAdmin) {
        return false;
    }

    return MANAGEMENT_PERMISSIONS.some((permission) => target[permission] && !actor[permission]);
};

// Fields that must never be exposed to a user-management lookup: another
// user's refresh tokens (hash/ip), Patreon token, and reset/activation
// tokens. getFullDetails() only strips the password.
const stripSensitiveUserFields = (user) => {
    if (!user) {
        return user;
    }

    delete user.tokens;
    delete user.resetToken;
    delete user.tokenExpires;
    delete user.activationToken;
    delete user.activationTokenExpiry;
    delete user.patreon;

    return user;
};

module.exports.init = function (server) {
    server.get(
        '/api/user/:username',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!req.user.permissions || !req.user.permissions.canManageUsers) {
                return res.status(403).send({ success: false, message: 'Forbidden' });
            }

            let user;
            let linkedAccounts;
            let retUser;
            try {
                user = await userService.getFullUserByUsername(req.params.username);

                if (!user) {
                    return res.status(404).send({ message: 'Not found' });
                }

                retUser = stripSensitiveUserFields(user.getFullDetails());

                if (req.user.permissions.canVerifyDecks) {
                    retUser.invalidDecks = (
                        await deckService.getFlaggedUnverifiedDecksForUser(user)
                    ).map((deck) => {
                        return { id: deck.id, uuid: deck.uuid, name: deck.name };
                    });
                }

                linkedAccounts = await userService.getPossiblyLinkedAccounts(user);
            } catch (error) {
                logger.error(error);

                return res.send({
                    success: false,
                    message: 'An error occurred searching the user.  Please try again later.'
                });
            }

            res.send({
                success: true,
                user: retUser,
                linkedAccounts:
                    linkedAccounts &&
                    linkedAccounts
                        .map((account) => account.username)
                        .filter((name) => name !== user.username)
            });
        })
    );

    server.put(
        '/api/user/:username',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!req.user.permissions || !req.user.permissions.canManageUsers) {
                return res.status(403).send({ success: false, message: 'Forbidden' });
            }

            if (!req.body.userToChange) {
                return res.send({ success: false, message: 'You must specify the user data' });
            }

            let userToSet = req.body.userToChange;
            let dbUser;

            try {
                dbUser = await userService.getFullUserByUsername(req.params.username);
            } catch (error) {
                logger.error(error);

                return res.send({
                    success: false,
                    message: 'An error occurred saving the user.  Please try again later.'
                });
            }

            let user = dbUser.getDetails();

            if (!user) {
                return res.status(404).send({ message: 'Not found' });
            }

            if (req.user.permissions.canManagePermissions) {
                user.permissions = userToSet.permissions;
            }

            user.verified = userToSet.verified;
            user.disabled = userToSet.disabled;

            try {
                await userService.update(user);
            } catch (error) {
                logger.error(error);

                return res.send({
                    success: false,
                    message: 'An error occurred saving the user.  Please try again later.'
                });
            }

            res.send({ success: true });
        })
    );

    server.post(
        '/api/user/:username/verifyDecks',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!req.user.permissions || !req.user.permissions.canVerifyDecks) {
                return res.status(403).send({ success: false, message: 'Forbidden' });
            }

            let user;
            try {
                user = await userService.getFullUserByUsername(req.params.username);

                if (!user) {
                    return res.status(404).send({ message: 'Not found' });
                }

                await deckService.verifyDecksForUser(user.id);
            } catch (error) {
                logger.error(error);

                return res.send({
                    success: false,
                    message: 'An error occurred verifying decks.  Please try again later.'
                });
            }

            res.send({ success: true });
        })
    );

    // ARCHON: admin sets a new password for a user and clears their sessions,
    // so the admin can hand them a temporary password when they're locked out.
    server.post(
        '/api/user/:username/reset-password',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!req.user.permissions || !req.user.permissions.canManageUsers) {
                return res.status(403).send({ success: false, message: 'Forbidden' });
            }

            const newPassword = req.body.newPassword || '';
            if (newPassword.length < 6) {
                return res.send({
                    success: false,
                    message: 'Password must be at least 6 characters'
                });
            }

            const user = await userService.getFullUserByUsername(req.params.username);
            if (!user) {
                return res.status(404).send({ success: false, message: 'Not found' });
            }

            if (targetOutranksActor(user.permissions, req.user.permissions)) {
                logger.warn(
                    `Blocked ${req.user.username} from resetting the password of higher-privileged account ${req.params.username}`
                );
                return res.status(403).send({ success: false, message: 'Forbidden' });
            }

            const hash = await bcrypt.hash(newPassword, 10);
            await userService.setPassword(user, hash);
            // Force re-login everywhere the old credentials might be cached.
            await userService.clearUserSessions(req.params.username);

            logger.info(`Admin ${req.user.username} reset the password for ${req.params.username}`);

            res.send({ success: true });
        })
    );

    // ARCHON: admin deletes (anonymizes) a user. Soft delete: the account row
    // and its id survive so rating history / game records stay intact, but the
    // username is freed, the password/PII wiped, roles and sessions removed,
    // and the account disabled. Cannot delete yourself here.
    server.delete(
        '/api/user/:username',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!req.user.permissions || !req.user.permissions.canManageUsers) {
                return res.status(403).send({ success: false, message: 'Forbidden' });
            }

            if (req.params.username.toLowerCase() === req.user.username.toLowerCase()) {
                return res.send({
                    success: false,
                    message: 'You cannot delete your own account from here.'
                });
            }

            const user = await userService.getFullUserByUsername(req.params.username);
            if (!user) {
                return res.status(404).send({ success: false, message: 'Not found' });
            }

            if (targetOutranksActor(user.permissions, req.user.permissions)) {
                logger.warn(
                    `Blocked ${req.user.username} from deleting higher-privileged account ${req.params.username}`
                );
                return res.status(403).send({ success: false, message: 'Forbidden' });
            }

            await userService.anonymizeUser(user);
            logger.info(`Admin ${req.user.username} deleted user ${req.params.username}`);

            res.send({ success: true });
        })
    );
};
