const passport = require('passport');

const notificationService = require('../services/notifications');
const { wrapAsync } = require('../util.js');

const jwt = passport.authenticate('jwt', { session: false });

/**
 * ARCHON: the in-app notification centre (N2).
 *
 * Everything here is scoped to the calling account inside the service - an id
 * belonging to somebody else is a no-op rather than a cross-account read, so
 * there is no ownership check to forget at this layer.
 */
module.exports.init = function (server) {
    server.get(
        '/api/notifications',
        jwt,
        wrapAsync(async (req, res) => {
            const [notifications, unread] = await Promise.all([
                notificationService.list(req.user.id, {
                    limit: req.query.limit,
                    unreadOnly: req.query.unreadOnly === 'true'
                }),
                notificationService.unreadCount(req.user.id)
            ]);

            res.send({ success: true, notifications, unread });
        })
    );

    // Cheap poll target for the bell badge: a count, not a page of rows.
    server.get(
        '/api/notifications/unread-count',
        jwt,
        wrapAsync(async (req, res) => {
            res.send({ success: true, unread: await notificationService.unreadCount(req.user.id) });
        })
    );

    // No ids in the body means "all of them", which is what the
    // mark-everything-read control sends.
    server.post(
        '/api/notifications/read',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(await notificationService.markRead(req.user.id, req.body.ids));
        })
    );

    server.get(
        '/api/notifications/preferences',
        jwt,
        wrapAsync(async (req, res) => {
            res.send({
                success: true,
                preferences: await notificationService.getPreferences(req.user.id)
            });
        })
    );

    server.post(
        '/api/notifications/preferences',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(
                await notificationService.setPreference(req.user.id, req.body.category, {
                    inApp: req.body.inApp,
                    email: req.body.email
                })
            );
        })
    );
};
