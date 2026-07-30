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

module.exports.init = function (server) {
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
    server.get(
        '/api/games/:gameId/replay',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            const replay = await gameService.getReplay(req.params.gameId);

            if (!replay) {
                return res.status(404).send({ success: false, message: 'Replay not found' });
            }

            // Whether the caller may share it is theirs to know, so the button
            // does not appear for a spectator reading someone else's game.
            const canShare = await gameService.isGameParticipant(req.params.gameId, req.user.id);

            res.send({ success: true, replay: replay, canShare });
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
                return res.send({ success: true, rated: false });
            }

            res.send({ success: true, rated: true, ...result });
        })
    );
};
