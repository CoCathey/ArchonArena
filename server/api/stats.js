const StatisticsService = require('../services/StatisticsService.js');
const { wrapAsync } = require('../util.js');

let statisticsService = new StatisticsService();

/**
 * ARCHON: platform statistics & analytics. Public, aggregate read-only
 * lookups (like the ratings/leaderboard endpoints) - a meta dashboard plus
 * per-player breakdowns, both served from the service's TTL cache.
 */
module.exports.init = function (server) {
    server.get(
        '/api/stats/meta',
        wrapAsync(async function (req, res) {
            const stats = await statisticsService.getMetaStats();

            res.send({ success: true, stats: stats });
        })
    );

    server.get(
        '/api/stats/player/:username',
        wrapAsync(async function (req, res) {
            const stats = await statisticsService.getPlayerStats(req.params.username);

            if (!stats) {
                return res.status(404).send({ success: false, message: 'No such player' });
            }

            res.send({ success: true, stats: stats });
        })
    );
};
