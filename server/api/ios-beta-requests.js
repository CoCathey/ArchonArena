const passport = require('passport');

const IosBetaRequestService = require('../services/IosBetaRequestService');
const { wrapAsync } = require('../util.js');
const { rateLimit } = require('./rateLimit');

const iosBetaRequestService = new IosBetaRequestService();

const requestLimit = rateLimit({
    name: 'ios-beta-request',
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Please wait a bit before requesting again.'
});

/**
 * ARCHON (N14): filing and reading your own request requires a login;
 * listing and clearing the queue is admin-only.
 */
module.exports.init = function (server) {
    const requireAdmin = (req, res, next) => {
        if (!req.user?.permissions?.isAdmin) {
            return res.status(403).send({ success: false, message: 'Forbidden' });
        }

        next();
    };

    server.post(
        '/api/ios-beta-requests',
        passport.authenticate('jwt', { session: false }),
        requestLimit,
        wrapAsync(async (req, res) => {
            res.send(
                await iosBetaRequestService.create(req.user.id, { appleId: req.body.appleId })
            );
        })
    );

    server.get(
        '/api/ios-beta-requests/mine',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            res.send({
                success: true,
                request: await iosBetaRequestService.myRequest(req.user.id)
            });
        })
    );

    server.get(
        '/api/ios-beta-requests',
        passport.authenticate('jwt', { session: false }),
        requireAdmin,
        wrapAsync(async (req, res) => {
            const requests = await iosBetaRequestService.list(req.query.status);

            res.send({ success: true, requests });
        })
    );

    server.post(
        '/api/ios-beta-requests/:id/status',
        passport.authenticate('jwt', { session: false }),
        requireAdmin,
        wrapAsync(async (req, res) => {
            res.send(
                await iosBetaRequestService.setStatus(
                    parseInt(req.params.id, 10),
                    req.body.status,
                    req.user.id
                )
            );
        })
    );
};
