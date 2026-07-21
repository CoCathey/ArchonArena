const ConfigService = require('../services/ConfigService');
const RatingService = require('../services/rating/RatingService');
const { wrapAsync } = require('../util.js');

const configService = new ConfigService();
const ratingService = new RatingService(configService);

/**
 * ARCHON: public rating lookups (Phase 5). Leaderboards arrive in Phase 6.
 */
module.exports.init = function (server) {
    server.get(
        '/api/ratings/:username',
        wrapAsync(async (req, res) => {
            const ratings = await ratingService.getRatingsForUsername(req.params.username);

            res.send({ success: true, ratings: ratings });
        })
    );
};
