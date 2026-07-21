const passport = require('passport');

const UserService = require('../services/UserService');
const { isValidImage, processAvatar } = require('./account.js');
const { wrapAsync } = require('../util.js');

const jwt = passport.authenticate('jwt', { session: false });

let userService;

/**
 * ARCHON: first-run onboarding wizard (Phase 9). Two small endpoints the
 * wizard needs beyond what already exists: marking the wizard complete
 * and a lightweight avatar upload (the full profile PUT requires the
 * whole settings payload, which a brand-new user has no business
 * assembling). Location, deck import, and club joining reuse their
 * existing endpoints.
 */
module.exports.init = function (server, options) {
    userService = options.userService || new UserService(options.configService);

    server.post(
        '/api/account/onboarded',
        jwt,
        wrapAsync(async (req, res) => {
            await userService.setOnboarded(req.user.id);

            res.send({ success: true });
        })
    );

    server.put(
        '/api/account/avatar',
        jwt,
        wrapAsync(async (req, res) => {
            if (!req.body.avatar) {
                return res.send({ success: false, message: 'avatar must be specified' });
            }

            if (!isValidImage(req.body.avatar)) {
                return res.status(400).send({ success: false, message: 'Avatar must be image' });
            }

            const fullUser = await userService.getFullUserByUsername(req.user.username);

            if (!fullUser) {
                return res.status(404).send({ success: false, message: 'Not found' });
            }

            const user = fullUser.getDetails();
            const fileName = await processAvatar({ avatar: req.body.avatar }, user);

            if (!fileName) {
                return res.send({ success: false, message: 'Could not process that image' });
            }

            user.settings.avatar = fileName;
            await userService.update(user);

            res.send({ success: true, avatar: fileName });
        })
    );
};
