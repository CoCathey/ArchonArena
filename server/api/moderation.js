const passport = require('passport');

const ModerationService = require('../services/ModerationService');
const { wrapAsync } = require('../util.js');
const { rateLimit } = require('./rateLimit');

const notificationService = require('../services/notifications');

const moderationService = new ModerationService(require('../db'), { notificationService });

// Reporting is the one action here a non-moderator can take, so it is the one
// that needs a limit: a report queue is only useful if it can be read, and
// flooding it is the cheapest way to make it useless.
const reportLimit = rateLimit({
    name: 'moderation-report',
    windowMs: 60 * 60 * 1000,
    max: 20,
    message: 'You have filed several reports recently. Please wait a little before filing more.'
});

const jwt = passport.authenticate('jwt', { session: false });

const requireModerator = (req, res, next) => {
    if (!moderationService.canModerate(req.user)) {
        return res.status(403).send({ success: false, message: 'Forbidden' });
    }

    next();
};

/**
 * ARCHON (N5): reports and the moderation queue.
 *
 * Filing is open to any signed-in player; everything else is gated on
 * canModerateChat (or isAdmin) both here and again inside the service, so the
 * check cannot be bypassed by reaching the service another way.
 */
module.exports.init = function (server) {
    // What a report can be about - drives the report dialog rather than the
    // client hardcoding a list that can drift from the server's.
    server.get(
        '/api/moderation/options',
        wrapAsync(async (req, res) => {
            res.send({
                success: true,
                targetTypes: ModerationService.TARGET_TYPES,
                reasons: ModerationService.REASONS
            });
        })
    );

    server.post(
        '/api/reports',
        jwt,
        reportLimit,
        wrapAsync(async (req, res) => {
            res.send(await moderationService.report(req.user.id, req.body));
        })
    );

    // A player's own live restrictions, so the UI can explain why a control
    // is disabled instead of silently doing nothing.
    server.get(
        '/api/moderation/me',
        jwt,
        wrapAsync(async (req, res) => {
            res.send({
                success: true,
                restrictions: await moderationService.getActiveRestrictions(req.user.id)
            });
        })
    );

    server.get(
        '/api/moderation/queue',
        jwt,
        requireModerator,
        wrapAsync(async (req, res) => {
            res.send(
                await moderationService.getQueue(req.user, {
                    status: req.query.status,
                    limit: req.query.limit
                })
            );
        })
    );

    server.post(
        '/api/moderation/reports/:id/claim',
        jwt,
        requireModerator,
        wrapAsync(async (req, res) => {
            res.send(await moderationService.claim(parseInt(req.params.id, 10), req.user));
        })
    );

    server.post(
        '/api/moderation/reports/:id/release',
        jwt,
        requireModerator,
        wrapAsync(async (req, res) => {
            res.send(await moderationService.release(parseInt(req.params.id, 10), req.user));
        })
    );

    server.post(
        '/api/moderation/reports/:id/resolve',
        jwt,
        requireModerator,
        wrapAsync(async (req, res) => {
            res.send(
                await moderationService.resolve(parseInt(req.params.id, 10), req.user, req.body)
            );
        })
    );

    server.post(
        '/api/moderation/actions',
        jwt,
        requireModerator,
        wrapAsync(async (req, res) => {
            res.send(await moderationService.act(req.user, req.body));
        })
    );

    server.post(
        '/api/moderation/actions/:id/revoke',
        jwt,
        requireModerator,
        wrapAsync(async (req, res) => {
            res.send(
                await moderationService.revoke(
                    parseInt(req.params.id, 10),
                    req.user,
                    req.body.reason
                )
            );
        })
    );

    server.get(
        '/api/moderation/players/:username',
        jwt,
        requireModerator,
        wrapAsync(async (req, res) => {
            res.send(await moderationService.getPlayerHistory(req.params.username, req.user));
        })
    );

    server.get(
        '/api/moderation/audit',
        jwt,
        requireModerator,
        wrapAsync(async (req, res) => {
            res.send(
                await moderationService.getAuditLog(req.user, {
                    limit: req.query.limit,
                    targetUserId: req.query.targetUserId
                })
            );
        })
    );
};

module.exports.moderationService = moderationService;
