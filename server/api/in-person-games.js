const passport = require('passport');

const ConfigService = require('../services/ConfigService');
const InPersonGameService = require('../services/InPersonGameService');
const RatingService = require('../services/rating/RatingService');
const { wrapAsync } = require('../util.js');
const { rateLimit } = require('./rateLimit');

const notificationService = require('../services/notifications');

const inPersonGameService = new InPersonGameService(require('../db'), {
    notificationService,
    // A confirmed paper game goes through exactly the same rating path as an
    // online one - see InPersonGameService.commit.
    ratingService: new RatingService(new ConfigService()),
    // ARCHON (N5): a dispute the players cannot settle can be escalated into
    // the moderation queue.
    moderationService: require('./moderation').moderationService
});

// Opening games is the only cheap way to spam someone with notifications
// here, so it is the one that is limited.
const createLimit = rateLimit({
    name: 'in-person-game-create',
    windowMs: 60 * 60 * 1000,
    max: 40,
    message: 'You have recorded a lot of in-person games recently. Please wait a little.'
});

const jwt = passport.authenticate('jwt', { session: false });

/**
 * ARCHON (N13): in-person game tracking.
 *
 * Every route is authenticated and scoped to the two players inside the
 * service - a paper game is private to the people who played it until it is
 * confirmed, at which point it becomes an ordinary game in both histories.
 */
module.exports.init = function (server) {
    server.get(
        '/api/in-person-games',
        jwt,
        wrapAsync(async (req, res) => {
            res.send({
                success: true,
                // The rated setting is returned with the list so a player can
                // see whether reporting will move their Amber BEFORE they
                // report, rather than finding out afterwards.
                rated: inPersonGameService.getConfig().rated,
                games: await inPersonGameService.listForUser(req.user.id, {
                    limit: req.query.limit
                })
            });
        })
    );

    server.post(
        '/api/in-person-games',
        jwt,
        createLimit,
        wrapAsync(async (req, res) => {
            res.send(await inPersonGameService.create(req.user.id, req.body));
        })
    );

    server.get(
        '/api/in-person-games/:id',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(await inPersonGameService.getDetail(parseInt(req.params.id, 10), req.user.id));
        })
    );

    server.post(
        '/api/in-person-games/:id/report',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(
                await inPersonGameService.report(parseInt(req.params.id, 10), req.user.id, req.body)
            );
        })
    );

    server.post(
        '/api/in-person-games/:id/withdraw',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(
                await inPersonGameService.withdrawReport(parseInt(req.params.id, 10), req.user.id)
            );
        })
    );

    server.post(
        '/api/in-person-games/:id/escalate',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(
                await inPersonGameService.escalate(
                    parseInt(req.params.id, 10),
                    req.user.id,
                    req.body.details
                )
            );
        })
    );

    server.post(
        '/api/in-person-games/:id/cancel',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(await inPersonGameService.cancel(parseInt(req.params.id, 10), req.user.id));
        })
    );

    // Confirmed paper games at a club - public, exactly like the club's
    // member list and board already are.
    server.get(
        '/api/clubs/:id/in-person-games',
        wrapAsync(async (req, res) => {
            res.send({
                success: true,
                games: await inPersonGameService.listForClub(parseInt(req.params.id, 10), {
                    limit: req.query.limit
                })
            });
        })
    );
};
