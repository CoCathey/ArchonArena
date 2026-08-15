const passport = require('passport');

const settingsService = require('../services/settings');
const TestFlightService = require('../services/mobile/TestFlightService');
const { wrapAsync } = require('../util.js');
const { rateLimit } = require('./rateLimit');

const testFlightService = new TestFlightService();

const testFlightRequestLimit = rateLimit({
    name: 'testflight-request',
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Please wait a bit before requesting again.'
});

const requireAdmin = (req, res, next) => {
    if (!req.user?.permissions?.isAdmin) {
        return res.status(403).send({ success: false, message: 'Forbidden' });
    }

    next();
};

/**
 * ARCHON (N14): self-serve entry points to the mobile apps.
 *
 * `/mobile/ios` and `/mobile/android` were Placeholder pages - the apps exist
 * and already have real testers, invited by hand, but the only way into the
 * beta was knowing the owner personally. This is the self-serve half: iOS
 * requests an invite through a queue (Apple enrollment itself stays manual),
 * Android reads an install link the admin sets once a beta track exists -
 * dormant (no link) until then, the same shape N12 used for Patreon
 * credentials.
 */
module.exports.init = function (server) {
    // Public: build numbers, changelog and the Android install link, all
    // admin-config so a new beta build or store link never needs a redeploy.
    server.get(
        '/api/mobile/info',
        wrapAsync(async (req, res) => {
            const mobile = settingsService.getSectionWithDefaults('mobile');

            res.send({
                success: true,
                ios: {
                    buildNumber: mobile.iosBuildNumber || '',
                    changelog: mobile.iosChangelog || ''
                },
                android: {
                    buildNumber: mobile.androidBuildNumber || '',
                    changelog: mobile.androidChangelog || '',
                    installUrl: mobile.androidInstallUrl || ''
                }
            });
        })
    );

    server.post(
        '/api/mobile/testflight-request',
        passport.authenticate('jwt', { session: false }),
        testFlightRequestLimit,
        wrapAsync(async (req, res) => {
            res.send(await testFlightService.request(req.user.id, req.body.appleIdEmail));
        })
    );

    server.get(
        '/api/mobile/testflight-request',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            res.send({ success: true, request: await testFlightService.getForUser(req.user.id) });
        })
    );

    server.get(
        '/api/admin/mobile/testflight-requests',
        passport.authenticate('jwt', { session: false }),
        requireAdmin,
        wrapAsync(async (req, res) => {
            res.send({ success: true, requests: await testFlightService.list(req.query.status) });
        })
    );

    server.post(
        '/api/admin/mobile/testflight-requests/:id/status',
        passport.authenticate('jwt', { session: false }),
        requireAdmin,
        wrapAsync(async (req, res) => {
            res.send(
                await testFlightService.setStatus(
                    parseInt(req.params.id, 10),
                    req.body.status,
                    req.user.id
                )
            );
        })
    );
};
