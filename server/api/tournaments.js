const passport = require('passport');

const TournamentService = require('../services/tournament/TournamentService');
const { wrapAsync } = require('../util.js');

const tournamentService = new TournamentService();

/**
 * ARCHON: native tournament engine API (Phase 7). Reads are public
 * (with optional auth for actor-specific flags and private events);
 * every mutation is JWT-authed and authorized inside the service
 * (organizer / staff / participant / site TO rules).
 */
module.exports.init = function (server) {
    const optionalAuth = (handler) =>
        wrapAsync(async (req, res, next) => {
            passport.authenticate('jwt', { session: false }, async (err, user) => {
                if (err) {
                    return next(err);
                }

                try {
                    await handler(req, res, user || null);
                } catch (innerErr) {
                    next(innerErr);
                }
            })(req, res, next);
        });

    server.get(
        '/api/tournaments',
        optionalAuth(async (req, res, user) => {
            const tournaments = await tournamentService.list(req.query.status, user);

            res.send({ success: true, tournaments });
        })
    );

    server.post(
        '/api/tournaments',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            res.send(await tournamentService.create(req.user, req.body));
        })
    );

    server.get(
        '/api/tournaments/history/:username',
        wrapAsync(async (req, res) => {
            const events = await tournamentService.history(req.params.username);

            res.send({ success: true, events });
        })
    );

    server.get(
        '/api/tournaments/:id',
        optionalAuth(async (req, res, user) => {
            res.send(await tournamentService.getDetail(parseInt(req.params.id, 10), user));
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
        tournamentService.register(parseInt(req.params.id, 10), req.user, {
            joinCode: req.body.joinCode,
            deckId: req.body.deckId ? parseInt(req.body.deckId, 10) : null
        })
    );

    action('/api/tournaments/:id/register-deck', (req) =>
        tournamentService.registerDeck(
            parseInt(req.params.id, 10),
            req.user,
            req.body.deckId ? parseInt(req.body.deckId, 10) : null
        )
    );

    action('/api/tournaments/:id/drop', (req) =>
        tournamentService.drop(
            parseInt(req.params.id, 10),
            req.body.userId ? parseInt(req.body.userId, 10) : null,
            req.user
        )
    );

    action('/api/tournaments/:id/update', (req) =>
        tournamentService.updateSettings(parseInt(req.params.id, 10), req.user, req.body)
    );

    action('/api/tournaments/:id/open-check-in', (req) =>
        tournamentService.openCheckIn(parseInt(req.params.id, 10), req.user)
    );

    action('/api/tournaments/:id/check-in', (req) =>
        tournamentService.checkIn(parseInt(req.params.id, 10), req.user)
    );

    action('/api/tournaments/:id/seeds', (req) =>
        tournamentService.setSeeds(parseInt(req.params.id, 10), req.user, req.body.seeds)
    );

    action('/api/tournaments/:id/staff/add', (req) =>
        tournamentService.addStaff(parseInt(req.params.id, 10), req.user, req.body.username)
    );

    action('/api/tournaments/:id/staff/remove', (req) =>
        tournamentService.removeStaff(parseInt(req.params.id, 10), req.user, req.body.userId)
    );

    action('/api/tournaments/:id/start', (req) =>
        tournamentService.start(parseInt(req.params.id, 10), req.user, {
            dropNoShows: !!req.body.dropNoShows
        })
    );

    action('/api/tournaments/:id/next-round', (req) =>
        tournamentService.nextRound(parseInt(req.params.id, 10), req.user)
    );

    action('/api/tournaments/:id/cut', (req) =>
        tournamentService.cutToPlayoff(parseInt(req.params.id, 10), req.user)
    );

    action('/api/tournaments/:id/matches/:matchId/result', (req) =>
        tournamentService.reportResult(
            parseInt(req.params.id, 10),
            parseInt(req.params.matchId, 10),
            parseInt(req.body.winnerId, 10),
            req.user,
            {
                player1Wins: req.body.player1Wins,
                player2Wins: req.body.player2Wins
            }
        )
    );

    action('/api/tournaments/:id/matches/:matchId/award', (req) =>
        tournamentService.awardWin(
            parseInt(req.params.id, 10),
            parseInt(req.params.matchId, 10),
            parseInt(req.body.winnerId, 10),
            req.user,
            req.body.resultType || 'forfeit'
        )
    );

    action('/api/tournaments/:id/matches/:matchId/double-loss', (req) =>
        tournamentService.doubleLoss(
            parseInt(req.params.id, 10),
            parseInt(req.params.matchId, 10),
            req.user
        )
    );

    action('/api/tournaments/:id/matches/:matchId/open-game', (req) =>
        tournamentService.ensureGameForMatch(
            parseInt(req.params.id, 10),
            parseInt(req.params.matchId, 10),
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
