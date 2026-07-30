const passport = require('passport');

const settingsService = require('../services/settings');
const AdminResetService = require('../services/AdminResetService');
const StatisticsService = require('../services/StatisticsService');
const { wrapAsync } = require('../util.js');
const logger = require('../log.js');

const adminResetService = new AdminResetService(undefined, {
    statisticsService: new StatisticsService()
});

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
    // ARCHON: site-wide statistics reset (isAdmin). Destructive, so it is a dry
    // run by default: POST without `confirm` reports exactly what would be
    // deleted and deletes nothing.
    server.get(
        '/api/admin/reset/categories',
        passport.authenticate('jwt', { session: false }),
        requireAdmin,
        wrapAsync(async (req, res) => {
            res.send({ success: true, categories: AdminResetService.categories() });
        })
    );

    server.post(
        '/api/admin/reset',
        passport.authenticate('jwt', { session: false }),
        requireAdmin,
        wrapAsync(async (req, res) => {
            const categories = Array.isArray(req.body?.categories) ? req.body.categories : [];
            const confirm = req.body?.confirm === true;

            const result = await adminResetService.reset({
                categories,
                confirm,
                actor: req.user.username
            });

            if (result.success && !result.dryRun) {
                // Deliberately loud and attributable: this destroys history and
                // there is no undo.
                logger.warn(
                    `ADMIN RESET by ${req.user.username}: cleared ${result.total} row(s) from ` +
                        result.tables.join(', ')
                );
            }

            res.send(result);
        })
    );

    // Public: admin-authored page content overrides (About / Privacy).
    // Only ever exposes the 'content' section - nothing sensitive lives
    // there, and the pages that consume it are public themselves.
    server.get(
        '/api/content',
        wrapAsync(async (req, res) => {
            const content = settingsService.getSection('content') || {};
            const navigation = settingsService.getSection('navigation') || {};
            // ARCHON (N1): Watch hub presentation. Public on purpose - a
            // broadcast delay that spectators cannot see is a delay they will
            // report as a bug, and the featured game is a public pointer.
            const watch = settingsService.getSectionWithDefaults('watch');

            res.send({
                success: true,
                about: content.aboutMarkdown || '',
                privacy: content.privacyMarkdown || '',
                terms: content.termsMarkdown || '',
                // Optional Community content pages, visible unless an admin has
                // explicitly turned them off. Consumed by the sidebar nav.
                pages: {
                    news: navigation.showNews !== false,
                    articles: navigation.showArticles !== false,
                    blogs: navigation.showBlogs !== false,
                    forums: navigation.showForums !== false
                },
                watch: {
                    showSpectatorCounts: watch.showSpectatorCounts !== false,
                    broadcastDelaySeconds: Number(watch.broadcastDelaySeconds) || 0,
                    featuredGameId: watch.featuredGameId || '',
                    featuredLabel: watch.featuredLabel || ''
                }
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
