const passport = require('passport');

const TournamentService = require('../services/tournament/TournamentService');
const { wrapAsync } = require('../util.js');
const { rateLimit } = require('./rateLimit');

const tournamentService = new TournamentService();

const tournamentCreateLimit = rateLimit({
    name: 'tournament-create',
    windowMs: 60 * 60 * 1000,
    max: 10,
    message:
        'You have created several tournaments recently. Please wait a while before creating another.'
});

/**
 * ARCHON: native tournament engine API (Phase 7). Reads are public;
 * every mutation is JWT-authed and authorized inside the service
 * (organizer / participant / site TO rules).
 */
module.exports.init = function (server) {
    server.get(
        '/api/tournaments',
        wrapAsync(async (req, res) => {
            const tournaments = await tournamentService.list(req.query.status);

            res.send({ success: true, tournaments });
        })
    );

    server.post(
        '/api/tournaments',
        passport.authenticate('jwt', { session: false }),
        tournamentCreateLimit,
        wrapAsync(async (req, res) => {
            res.send(await tournamentService.create(req.user, req.body));
        })
    );

    server.get(
        '/api/tournaments/:id',
        wrapAsync(async (req, res, next) => {
            // Optional auth: detail includes actor-specific flags when a
            // valid token is presented, but stays public without one.
            passport.authenticate('jwt', { session: false }, async (err, user) => {
                if (err) {
                    return next(err);
                }

                // This callback runs outside wrapAsync's promise chain, so a
                // rejection here would be an unhandled rejection and the
                // request would hang. Catch and forward to the error handler.
                try {
                    res.send(
                        await tournamentService.getDetail(parseInt(req.params.id, 10), user || null)
                    );
                } catch (detailErr) {
                    next(detailErr);
                }
            })(req, res, next);
        })
    );

    const action = (path, handler) =>
        server.post(
            path,
            passport.authenticate('jwt', { session: false }),
            wrapAsync(async (req, res) => {
                res.send(await handler(req));
            })
        );

    action('/api/tournaments/:id/register', (req) =>
        tournamentService.register(parseInt(req.params.id, 10), req.user)
    );

    action('/api/tournaments/:id/drop', (req) =>
        tournamentService.drop(
            parseInt(req.params.id, 10),
            req.body.userId ? parseInt(req.body.userId, 10) : null,
            req.user
        )
    );

    action('/api/tournaments/:id/start', (req) =>
        tournamentService.start(parseInt(req.params.id, 10), req.user)
    );

    action('/api/tournaments/:id/next-round', (req) =>
        tournamentService.nextRound(parseInt(req.params.id, 10), req.user)
    );

    action('/api/tournaments/:id/matches/:matchId/result', (req) =>
        tournamentService.reportResult(
            parseInt(req.params.id, 10),
            parseInt(req.params.matchId, 10),
            parseInt(req.body.winnerId, 10),
            req.user
        )
    );

    action('/api/tournaments/:id/finish', (req) =>
        tournamentService.finish(parseInt(req.params.id, 10), req.user)
    );

    action('/api/tournaments/:id/cancel', (req) =>
        tournamentService.cancel(parseInt(req.params.id, 10), req.user)
    );
};
