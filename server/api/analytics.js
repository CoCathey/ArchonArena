const passport = require('passport');

const AnalyticsService = require('../services/AnalyticsService');
const { wrapAsync } = require('../util.js');

const analyticsService = new AnalyticsService();

const requireAdmin = (req, res, next) => {
    if (!req.user?.permissions?.isAdmin) {
        return res.status(403).send({ success: false, message: 'Forbidden' });
    }

    next();
};

/**
 * ARCHON (N8): the operations dashboard. isAdmin only - these numbers
 * describe the health of the whole site, not one player's activity.
 */
module.exports.init = function (server) {
    server.get(
        '/api/admin/analytics',
        passport.authenticate('jwt', { session: false }),
        requireAdmin,
        wrapAsync(async (req, res) => {
            res.send(
                await analyticsService.getDashboard({
                    days: req.query.days ? parseInt(req.query.days, 10) : 30
                })
            );
        })
    );
};

module.exports.analyticsService = analyticsService;
