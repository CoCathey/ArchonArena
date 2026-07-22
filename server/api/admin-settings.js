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
    // Public: admin-authored page content overrides (About / Privacy).
    // Only ever exposes the 'content' section - nothing sensitive lives
    // there, and the pages that consume it are public themselves.
    server.get(
        '/api/content',
        wrapAsync(async (req, res) => {
            const content = settingsService.getSection('content') || {};

            res.send({
                success: true,
                about: content.aboutMarkdown || '',
                privacy: content.privacyMarkdown || ''
            });
        })
    );

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
