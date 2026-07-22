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

module.exports.init = function (server) {
    server.get(
        '/api/user/:username',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!req.user.permissions || !req.user.permissions.canManageUsers) {
                return res.status(403);
            }

            let user;
            let linkedAccounts;
            let retUser;
            try {
                user = await userService.getFullUserByUsername(req.params.username);

                if (!user) {
                    return res.status(404).send({ message: 'Not found' });
                }

                retUser = user.getFullDetails();

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
                return res.status(403);
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
                return res.status(403);
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

            const user = await userService.getUserByUsername(req.params.username);
            if (!user) {
                return res.status(404).send({ success: false, message: 'Not found' });
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

            const user = await userService.getUserByUsername(req.params.username);
            if (!user) {
                return res.status(404).send({ success: false, message: 'Not found' });
            }

            await userService.anonymizeUser(user);
            logger.info(`Admin ${req.user.username} deleted user ${req.params.username}`);

            res.send({ success: true });
        })
    );
};
