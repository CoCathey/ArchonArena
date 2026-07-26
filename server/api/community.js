const passport = require('passport');

const FriendService = require('../services/community/FriendService');
const ClubService = require('../services/community/ClubService');
const MemberDirectoryService = require('../services/community/MemberDirectoryService');
const StoreService = require('../services/community/StoreService');
const PlayerProfileService = require('../services/community/PlayerProfileService');
const { wrapAsync } = require('../util.js');
const { rateLimit } = require('./rateLimit');

// Abuse limits on mutations with no legitimate high-frequency use.
const friendRequestLimit = rateLimit({
    name: 'friend-request',
    windowMs: 10 * 60 * 1000,
    max: 30,
    message: 'Too many friend requests. Please wait a little before sending more.'
});
const clubCreateLimit = rateLimit({
    name: 'club-create',
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: 'You have created several clubs recently. Please wait a while before creating another.'
});
const storeCreateLimit = rateLimit({
    name: 'store-create',
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: 'You have added several stores recently. Please wait a while before adding another.'
});

const friendService = new FriendService();
const clubService = new ClubService();
const memberDirectory = new MemberDirectoryService();
const storeService = new StoreService();
const playerProfileService = new PlayerProfileService();

const jwt = passport.authenticate('jwt', { session: false });

/**
 * ARCHON: community features (Phase 9): friends, member directory, clubs.
 */
module.exports.init = function (server) {
    // ----- Public player profile (/players/:username). Unauthenticated: it
    // exposes only what the leaderboards and member directory already show.
    server.get(
        '/api/players/:username',
        wrapAsync(async (req, res) => {
            const profile = await playerProfileService.getProfile(req.params.username);

            if (!profile) {
                return res.status(404).send({ success: false, message: 'No such player' });
            }

            res.send({ success: true, profile });
        })
    );

    // ----- Friends (all JWT-authed; friendships are private to the pair)
    server.get(
        '/api/friends',
        jwt,
        wrapAsync(async (req, res) => {
            const overview = await friendService.overview(req.user.id);

            res.send({ success: true, ...overview });
        })
    );

    server.post(
        '/api/friends/request',
        jwt,
        friendRequestLimit,
        wrapAsync(async (req, res) => {
            if (!req.body.username) {
                return res.send({ success: false, message: 'username must be specified' });
            }

            res.send(await friendService.sendRequest(req.user.id, req.body.username));
        })
    );

    server.post(
        '/api/friends/respond',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(
                await friendService.respond(
                    req.user.id,
                    parseInt(req.body.userId, 10),
                    !!req.body.accept
                )
            );
        })
    );

    server.post(
        '/api/friends/remove',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(await friendService.remove(req.user.id, parseInt(req.body.userId, 10)));
        })
    );

    // ----- Member directory (public)
    server.get(
        '/api/members',
        wrapAsync(async (req, res) => {
            const [stats, members] = await Promise.all([
                memberDirectory.stats(),
                memberDirectory.search({
                    query: req.query.query,
                    country: req.query.country,
                    limit: req.query.limit,
                    offset: req.query.offset
                })
            ]);

            res.send({ success: true, stats, members });
        })
    );

    // ----- Clubs (reads public, mutations JWT-authed)
    server.get(
        '/api/clubs',
        wrapAsync(async (req, res) => {
            res.send({ success: true, clubs: await clubService.list(req.query.query) });
        })
    );

    server.post(
        '/api/clubs',
        jwt,
        clubCreateLimit,
        wrapAsync(async (req, res) => {
            res.send(await clubService.create(req.user.id, req.body));
        })
    );

    server.get(
        '/api/clubs/:id',
        wrapAsync(async (req, res, next) => {
            passport.authenticate('jwt', { session: false }, async (err, user) => {
                if (err) {
                    return next(err);
                }

                // This callback runs outside wrapAsync's promise chain, so a
                // rejection here would be an unhandled rejection and the
                // request would hang. Catch and forward to the error handler.
                try {
                    res.send(
                        await clubService.getDetail(parseInt(req.params.id, 10), user?.id || null)
                    );
                } catch (detailErr) {
                    next(detailErr);
                }
            })(req, res, next);
        })
    );

    server.post(
        '/api/clubs/join-by-code',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(await clubService.joinByCode(req.user.id, req.body.code));
        })
    );

    server.post(
        '/api/clubs/:id/join',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(await clubService.join(parseInt(req.params.id, 10), req.user.id));
        })
    );

    server.post(
        '/api/clubs/:id/leave',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(await clubService.leave(parseInt(req.params.id, 10), req.user.id));
        })
    );

    server.post(
        '/api/clubs/:id/remove',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(
                await clubService.removeMember(
                    parseInt(req.params.id, 10),
                    parseInt(req.body.userId, 10),
                    req.user
                )
            );
        })
    );

    server.post(
        '/api/clubs/:id/disband',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(await clubService.disband(parseInt(req.params.id, 10), req.user));
        })
    );

    // ----- Local stores / venues for in-person play (reads public, add JWT-authed)
    server.get(
        '/api/stores',
        wrapAsync(async (req, res) => {
            const stores = await storeService.list({
                query: req.query.query,
                country: req.query.country,
                state: req.query.state
            });

            res.send({ success: true, stores });
        })
    );

    server.post(
        '/api/stores',
        jwt,
        storeCreateLimit,
        wrapAsync(async (req, res) => {
            res.send(await storeService.create(req.user.id, req.body));
        })
    );

    server.post(
        '/api/stores/:id/remove',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(await storeService.remove(parseInt(req.params.id, 10), req.user));
        })
    );
};
