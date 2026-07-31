const passport = require('passport');

const ConfigService = require('../services/ConfigService');
const RatingService = require('../services/rating/RatingService');
const { REGION_NAMES } = require('../services/rating/regions');
const { wrapAsync } = require('../util.js');
const logger = require('../log.js');

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

    // ARCHON (N4): season list and archived standings. Public, like the
    // leaderboard itself - a past season's ladder is no more sensitive than the
    // current one. Registered before /api/ratings/:username so 'seasons' is
    // never read as a username.
    server.get(
        '/api/ratings/seasons',
        wrapAsync(async (req, res) => {
            res.send({ success: true, seasons: await ratingService.getSeasons() });
        })
    );

    server.get(
        '/api/ratings/seasons/:season',
        wrapAsync(async (req, res) => {
            const standings = await ratingService.getSeasonStandings(req.params.season, {
                pool: req.query.pool,
                limit: req.query.limit,
                offset: req.query.offset
            });

            if (!standings) {
                return res.status(404).send({ success: false, message: 'No such season' });
            }

            res.send({ success: true, ...standings });
        })
    );

    server.get(
        '/api/ratings/:username',
        wrapAsync(async (req, res) => {
            const [ratings, seasonHistory, currentSeason] = await Promise.all([
                ratingService.getRatingsForUsername(req.params.username),
                // ARCHON (N4): where they finished in prior seasons, and what
                // each soft reset did to their Amber.
                ratingService.getSeasonHistoryForUsername(req.params.username),
                ratingService.getCurrentSeason()
            ]);

            res.send({ success: true, ratings, seasonHistory, currentSeason });
        })
    );

    // ----- Admin rating tools (set / reset a player's Amber)
    const ensureUserAdmin = (req, res) => {
        if (req.user?.permissions?.isAdmin || req.user?.permissions?.canManageUsers) {
            return true;
        }

        res.status(403).send({ success: false, message: 'Forbidden' });

        return false;
    };

    server.put(
        '/api/admin/ratings/:username',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!ensureUserAdmin(req, res)) {
                return;
            }

            res.send(
                await ratingService.adminSetRating(
                    req.params.username,
                    req.body.pool,
                    req.body.rating,
                    req.body.gamesPlayed
                )
            );
        })
    );

    server.post(
        '/api/admin/ratings/:username/reset',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!ensureUserAdmin(req, res)) {
                return;
            }

            res.send(await ratingService.adminResetRatings(req.params.username, req.body.pool));
        })
    );

    // ----- Seasons & rating decay (site-wide operations; isAdmin only)
    const ensureAdmin = (req, res) => {
        if (req.user?.permissions?.isAdmin) {
            return true;
        }

        res.status(403).send({ success: false, message: 'Forbidden' });

        return false;
    };

    server.get(
        '/api/admin/ratings/season',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!ensureAdmin(req, res)) {
                return;
            }

            const season = await ratingService.getCurrentSeason();

            res.send({ success: true, ...season });
        })
    );

    server.post(
        '/api/admin/ratings/decay',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!ensureAdmin(req, res)) {
                return;
            }

            const result = await ratingService.applyDecay();

            res.send({ success: true, ...result });
        })
    );

    server.post(
        '/api/admin/ratings/new-season',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!ensureAdmin(req, res)) {
                return;
            }

            res.send(await ratingService.startNewSeason());
        })
    );

    // ARCHON (N4): rebuild the ladder by replaying RatingHistory under a
    // different Elo config.
    //
    // Deliberately a dry run unless `confirm` is exactly true, matching
    // AdminResetService: this rewrites the competitive standing of every player
    // on the site, so the default has to be "show me what would happen".
    server.post(
        '/api/admin/ratings/recalculate',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!ensureAdmin(req, res)) {
                return;
            }

            const result = await ratingService.recalculateRatings({
                elo: req.body?.elo,
                commit: req.body?.confirm === true,
                reportLimit: req.body?.reportLimit
            });

            if (result.success && result.committed) {
                // Loud and attributable: there is no undo.
                logger.warn(
                    `ADMIN RATING RECALCULATION by ${req.user.username}: ` +
                        `${result.changed} rating(s) rewritten from ${result.gamesReplayed} game(s)`
                );
            }

            res.send(result);
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
