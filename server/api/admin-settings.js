const passport = require('passport');

const settingsService = require('../services/settings');
const { wrapAsync } = require('../util.js');

/**
 * ARCHON: runtime site settings management. isAdmin only.
 */
const requireAdmin = (req, res, next) => {
    if (!req.user?.permissions?.isAdmin) {
        return res.status(403).send({ success: false, message: 'Forbidden' });
    }

    next();
};

module.exports.init = function (server) {
    server.get(
        '/api/admin/settings',
        passport.authenticate('jwt', { session: false }),
        requireAdmin,
        wrapAsync(async (req, res) => {
            const sections = await settingsService.describe();

            res.send({ success: true, sections: sections });
        })
    );

    server.put(
        '/api/admin/settings/:section',
        passport.authenticate('jwt', { session: false }),
        requireAdmin,
        wrapAsync(async (req, res) => {
            const result = await settingsService.setSection(
                req.params.section,
                req.body.value,
                req.user.id
            );

            res.send(result);
        })
    );

    server.delete(
        '/api/admin/settings/:section',
        passport.authenticate('jwt', { session: false }),
        requireAdmin,
        wrapAsync(async (req, res) => {
            const result = await settingsService.resetSection(req.params.section, req.user.id);

            res.send(result);
        })
    );
};
