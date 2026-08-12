const passport = require('passport');

const StatisticsService = require('../services/StatisticsService.js');
const { wrapAsync } = require('../util.js');
// ARCHON (N12): these routes stay unauthenticated - the public player profile
// depends on them. Premium extras are stripped from the PAYLOAD instead. See
// statsGating.js for why gating the route would be a regression.
const {
    filterFields,
    filterDeckStats,
    optionalUser,
    entitlementsForRequest,
    PLAYER_PREMIUM,
    META_PREMIUM
} = require('./statsGating');

let statisticsService = new StatisticsService();

/**
 * ARCHON: platform statistics & analytics. Public, aggregate read-only
 * lookups (like the ratings/leaderboard endpoints) - a meta dashboard plus
 * per-player breakdowns, both served from the service's TTL cache.
 */
module.exports.init = function (server) {
    server.get(
        '/api/stats/meta',
        optionalUser(passport),
        wrapAsync(async function (req, res) {
            const stats = await statisticsService.getMetaStats();
            const { stats: filtered, locked } = filterFields(
                stats,
                META_PREMIUM,
                entitlementsForRequest(req)
            );

            res.send({ success: true, stats: filtered, locked });
        })
    );

    // ARCHON: per-deck record, with each deck's win rate against what decks of
    // its SAS band actually achieve site-wide.
    server.get(
        '/api/stats/decks/:username',
        optionalUser(passport),
        wrapAsync(async function (req, res) {
            const stats = await statisticsService.getDeckStats(req.params.username);

            if (!stats) {
                return res.status(404).send({ success: false, message: 'No such player' });
            }

            const { stats: filtered, locked } = filterDeckStats(stats, entitlementsForRequest(req));

            res.send({ success: true, stats: filtered, locked });
        })
    );

    server.get(
        '/api/stats/player/:username',
        optionalUser(passport),
        wrapAsync(async function (req, res) {
            const stats = await statisticsService.getPlayerStats(req.params.username);

            if (!stats) {
                return res.status(404).send({ success: false, message: 'No such player' });
            }

            // `overall` is never touched: the win/loss record and Elo are in
            // the free tier's promise, and the public profile renders them for
            // logged-out visitors.
            const { stats: filtered, locked } = filterFields(
                stats,
                PLAYER_PREMIUM,
                entitlementsForRequest(req)
            );

            res.send({ success: true, stats: filtered, locked });
        })
    );
};
