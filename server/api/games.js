const passport = require('passport');

const GameService = require('../services/GameService.js');
const RatingService = require('../services/rating/RatingService.js');
const ConfigService = require('../services/ConfigService.js');
const { wrapAsync } = require('../util.js');

let gameService = new GameService();
let ratingService = new RatingService(new ConfigService());

module.exports.init = function (server) {
    server.get(
        '/api/games',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async function (req, res) {
            let games = await gameService.findByUserName(req.user.username);
            res.send({ success: true, games: games });
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

            res.send({ success: true, replay: replay });
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
