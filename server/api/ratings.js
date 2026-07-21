const passport = require('passport');

const ConfigService = require('../services/ConfigService');
const RatingService = require('../services/rating/RatingService');
const { REGION_NAMES } = require('../services/rating/regions');
const { wrapAsync } = require('../util.js');

const configService = new ConfigService();
const ratingService = new RatingService(configService);

/**
 * ARCHON: public rating + leaderboard lookups and the player location
 * settings that scope them (Phase 5/6).
 */
module.exports.init = function (server) {
    server.get(
        '/api/ratings/leaderboard',
        wrapAsync(async (req, res) => {
            const leaderboard = await ratingService.getLeaderboard({
                pool: req.query.pool,
                scope: req.query.scope,
                region: req.query.region,
                country: req.query.country,
                state: req.query.state,
                limit: req.query.limit,
                offset: req.query.offset
            });

            res.send({ success: true, ...leaderboard, regions: REGION_NAMES });
        })
    );

    server.get(
        '/api/ratings/:username',
        wrapAsync(async (req, res) => {
            const ratings = await ratingService.getRatingsForUsername(req.params.username);

            res.send({ success: true, ratings: ratings });
        })
    );

    server.get(
        '/api/account/location',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            const location = await ratingService.getLocation(req.user.id);

            res.send({ success: true, ...location });
        })
    );

    server.put(
        '/api/account/location',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            const result = await ratingService.setLocation(
                req.user.id,
                req.body.country,
                req.body.state
            );

            res.send(result);
        })
    );
};
