const passport = require('passport');

const ServiceFactory = require('../services/ServiceFactory.js');
const DirectMessageService = require('../services/community/DirectMessageService');
const { wrapAsync } = require('../util.js');
const { rateLimit } = require('./rateLimit');

const logger = require('../log.js');

let messageService = ServiceFactory.messageService();

// ARCHON: direct messages share the moderation service the moderation API
// already built, so a mute is one fact enforced everywhere.
const directMessageService = new DirectMessageService(require('../db'), {
    moderationService: require('./moderation').moderationService
});

// A conversation between two people who are arranging a game never touches
// this; a script working through the member list does.
const sendLimit = rateLimit({
    name: 'direct-message',
    windowMs: 60 * 1000,
    max: 30,
    message: 'You are sending messages very quickly. Please wait a moment.'
});

const jwt = passport.authenticate('jwt', { session: false });

module.exports.init = function (server) {
    server.delete(
        '/api/messages/:messageId',
        passport.authenticate('jwt', { session: false }),
        function (req, res) {
            if (!req.user.permissions || !req.user.permissions.canModerateChat) {
                return res.status(403);
            }

            messageService
                .removeMessage(req.params.messageId, req.user)
                .then(() => {
                    res.send({ success: true });
                })
                .catch((err) => {
                    logger.error(err);
                    res.send({ success: false, message: 'An error occurred deleting the message' });
                });
        }
    );

    /**
     * ARCHON: direct messages. Every route is scoped to the calling account
     * inside the service, so there is no ownership check to forget here.
     *
     * Fixed paths ('conversations', 'unread-count') are registered before the
     * ':username' routes so they are not read as somebody's name.
     */
    server.get(
        '/api/messages/conversations',
        jwt,
        wrapAsync(async (req, res) => {
            res.send({
                success: true,
                conversations: await directMessageService.conversations(req.user.id)
            });
        })
    );

    // Cheap poll target for the envelope badge: two counts, not a page.
    server.get(
        '/api/messages/unread-count',
        jwt,
        wrapAsync(async (req, res) => {
            res.send({ success: true, ...(await directMessageService.unreadCount(req.user.id)) });
        })
    );

    server.get(
        '/api/messages/with/:username',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(
                await directMessageService.thread(req.user.id, req.params.username, {
                    before: req.query.before,
                    limit: req.query.limit
                })
            );
        })
    );

    server.post(
        '/api/messages/with/:username',
        jwt,
        sendLimit,
        wrapAsync(async (req, res) => {
            res.send(
                await directMessageService.send(req.user, req.params.username, req.body.text, {
                    matchId: req.body.matchId
                })
            );
        })
    );

    server.post(
        '/api/messages/with/:username/read',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(await directMessageService.markRead(req.user.id, req.params.username));
        })
    );
};

module.exports.directMessageService = directMessageService;
