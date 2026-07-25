const passport = require('passport');

const GameService = require('../services/GameService.js');
const { wrapAsync } = require('../util.js');

let gameService = new GameService();

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
};
