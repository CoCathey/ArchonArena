const passport = require('passport');

const BugReportService = require('../services/BugReportService');
const { wrapAsync } = require('../util.js');
const { rateLimit } = require('./rateLimit');

const bugReportService = new BugReportService();

const bugReportLimit = rateLimit({
    name: 'bug-report',
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'You have filed several reports recently - thank you! Please wait a bit.'
});

/**
 * ARCHON: beta bug reports. Filing requires a login (and is rate
 * limited); reading and resolving is admin-only.
 */
module.exports.init = function (server) {
    const requireAdmin = (req, res, next) => {
        if (!req.user?.permissions?.isAdmin) {
            return res.status(403).send({ success: false, message: 'Forbidden' });
        }

        next();
    };

    server.post(
        '/api/bug-reports',
        passport.authenticate('jwt', { session: false }),
        bugReportLimit,
        wrapAsync(async (req, res) => {
            res.send(
                await bugReportService.create(req.user.id, {
                    page: req.body.page,
                    body: req.body.body,
                    userAgent: req.get && req.get('user-agent')
                })
            );
        })
    );

    server.get(
        '/api/bug-reports',
        passport.authenticate('jwt', { session: false }),
        requireAdmin,
        wrapAsync(async (req, res) => {
            const reports = await bugReportService.list(req.query.status);

            res.send({ success: true, reports });
        })
    );

    server.post(
        '/api/bug-reports/:id/status',
        passport.authenticate('jwt', { session: false }),
        requireAdmin,
        wrapAsync(async (req, res) => {
            res.send(
                await bugReportService.setStatus(
                    parseInt(req.params.id, 10),
                    req.body.status,
                    req.user.id
                )
            );
        })
    );
};
