const passport = require('passport');

const GameService = require('../services/GameService.js');
const RatingService = require('../services/rating/RatingService.js');
const ConfigService = require('../services/ConfigService.js');
const { wrapAsync } = require('../util.js');
const { rateLimit } = require('./rateLimit');

let gameService = new GameService();
let ratingService = new RatingService(new ConfigService());

// Minting share links is cheap but writes a row and hands out a credential;
// there is no legitimate high-frequency use.
const shareLimit = rateLimit({
    name: 'replay-share',
    windowMs: 10 * 60 * 1000,
    max: 60,
    message: 'Too many share links created. Please wait a little before sharing more replays.'
});

// ARCHON: services are injectable at init, matching api/account.js. It is what
// lets test/server/api/replayAccess.spec.js drive the shipped replay route
// rather than a copy of it - and the check that route makes is the sort that
// survives quietly until a refactor drops it.
module.exports.init = function (server, options = {}) {
    gameService = options.gameService || gameService;
    ratingService = options.ratingService || ratingService;

    server.get(
        '/api/games',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            // ARCHON: filters are applied in SQL before the row limit, so a
            // filtered view searches the whole history rather than the last
            // page of it.
            let games = await gameService.findByUserName(req.user.username, {
                format: req.query.format,
                deck: req.query.deck,
                opponent: req.query.opponent,
                result: req.query.result,
                limit: req.query.limit
            });

            res.send({ success: true, games: games });
        })
    );

    // ARCHON: the values that actually occur in this player's history, so the
    // filter controls can offer real choices.
    server.get(
        '/api/games/filters',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            const filters = await gameService.getGameFilterOptions(req.user.username);

            res.send({ success: true, ...filters });
        })
    );

    // ARCHON: a replay someone deliberately shared. Public and unauthenticated
    // on purpose - that is the point of a share link - and safe because the
    // recording is spectator-safe by construction: snapshots are rendered
    // through the same AnonymousSpectator path that protects live spectators,
    // so a link can never reveal more than watching the game would have.
    // Registered before the parameterised /api/games/:gameId/* routes.
    server.get(
        '/api/replays/shared/:token',
        wrapAsync(async function (req, res) {
            const replay = await gameService.getReplayByShareToken(req.params.token);

            if (!replay) {
                return res.status(404).send({ success: false, message: 'Replay not found' });
            }

            res.send({ success: true, replay: replay });
        })
    );

    // ARCHON: recorded replay (structured play-by-play) for a finished game.
    //
    // Your own games only. This used to hand a replay to any logged-in account
    // that could guess or read a game id, which made every game on the site
    // effectively public to members - not what a player assumes when they
    // finish a match, and not something they ever agreed to. A player who does
    // want to show a game has a share link for it, which is an explicit act.
    //
    // Admins are the one exception, because a report about what happened in a
    // game cannot be investigated without seeing the game.
    server.get(
        '/api/games/:gameId/replay',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            const isParticipant = await gameService.isGameParticipant(
                req.params.gameId,
                req.user.id
            );
            const isAdmin = !!req.user.permissions?.isAdmin;

            if (!isParticipant && !isAdmin) {
                // 403 rather than 404: the game exists, it is simply not
                // theirs, and saying so is not a leak - they had to know the id
                // to ask, and every finished game is already listed publicly on
                // the players' profiles.
                return res.status(403).send({
                    success: false,
                    reason: 'not-your-game',
                    message: 'You can only watch replays of your own games.'
                });
            }

            const replay = await gameService.getReplay(req.params.gameId);

            if (!replay) {
                // Which of the four reasons, so the page can say something the
                // reader can act on.
                const reason = await gameService.describeMissingReplay(req.params.gameId);

                return res
                    .status(404)
                    .send({ success: false, reason, message: 'Replay not found' });
            }

            // Sharing stays a participant's call even when an admin is reading.
            res.send({ success: true, replay: replay, canShare: isParticipant });
        })
    );

    // ARCHON: mint (or return) the public share link for a replay. Only the two
    // players in the game may share it - sharing is a decision about your own
    // game, not something any logged-in reader can do on your behalf.
    server.post(
        '/api/games/:gameId/share',
        passport.authenticate('jwt', { session: false }),
        shareLimit,
        wrapAsync(async function (req, res) {
            res.send(await gameService.createShareToken(req.params.gameId, req.user.id));
        })
    );

    server.delete(
        '/api/games/:gameId/share',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            res.send(await gameService.revokeShareToken(req.params.gameId, req.user.id));
        })
    );

    // ARCHON: what a finished game did to both players' Amber (post-game result
    // screen). `rated: false` is a normal answer - unrated games are common -
    // so it is a 200 with an explicit flag rather than a 404 the client has to
    // interpret. Everything returned is already public via the leaderboards.
    server.get(
        '/api/games/:gameId/rating',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            const result = await ratingService.getGameResult(req.params.gameId);

            if (!result) {
                // ARCHON: "no rating row" is two answers, not one. Rating runs
                // after GAMEWIN, so the panel's request usually arrives first;
                // saying "not rated" then is simply wrong. `pending` tells the
                // client to ask again, and `reason` explains the cases where it
                // genuinely never will be.
                const missing = await ratingService.describeMissingRating(req.params.gameId);

                return res.send({
                    success: true,
                    rated: false,
                    pending: missing.pending,
                    reason: missing.reason
                });
            }

            res.send({ success: true, rated: true, ...result });
        })
    );
};
