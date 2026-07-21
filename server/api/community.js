const passport = require('passport');

const FriendService = require('../services/community/FriendService');
const ClubService = require('../services/community/ClubService');
const MemberDirectoryService = require('../services/community/MemberDirectoryService');
const { wrapAsync } = require('../util.js');

const friendService = new FriendService();
const clubService = new ClubService();
const memberDirectory = new MemberDirectoryService();

const jwt = passport.authenticate('jwt', { session: false });

/**
 * ARCHON: community features (Phase 9): friends, member directory, clubs.
 */
module.exports.init = function (server) {
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

                res.send(
                    await clubService.getDetail(parseInt(req.params.id, 10), user?.id || null)
                );
            })(req, res, next);
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
};
