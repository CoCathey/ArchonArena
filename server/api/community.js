const passport = require('passport');

const FriendService = require('../services/community/FriendService');
const ClubService = require('../services/community/ClubService');
// ARCHON (N7): teams are rosters that enter events as a unit.
const TeamService = require('../services/community/TeamService');
const MemberDirectoryService = require('../services/community/MemberDirectoryService');
const StoreService = require('../services/community/StoreService');
const PlayerProfileService = require('../services/community/PlayerProfileService');
// ARCHON (N12): profile customisation, sold as profile_cosmetics /
// enhanced_cosmetics.
const ProfileCosmeticsService = require('../services/community/ProfileCosmeticsService');
const { cosmeticsCatalog, bioMaxLength } = require('../services/membership/cosmetics');
const { CAPABILITIES } = require('../services/membership/capabilities');
const { requireCapability, entitlementsForRequest } = require('./requireCapability');
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
// An invitation is addressed to one person and mails them by default, so it is
// the club surface with an actual spam shape. Generous for anyone building a
// club, useless for anyone working through a user list.
const clubInviteLimit = rateLimit({
    name: 'club-invite',
    windowMs: 60 * 60 * 1000,
    max: 30,
    message: 'You have sent a lot of club invitations recently. Please wait a while.'
});
const storeCreateLimit = rateLimit({
    name: 'store-create',
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: 'You have added several stores recently. Please wait a while before adding another.'
});

// ARCHON: community actions raise notifications (N2). The service is shared
// process-wide and every call from here is fire-and-forget, so no response
// waits on a database write or an email.
const notificationService = require('../services/notifications');

// ARCHON (N7): club boards show Amber, so the club service borrows the
// rating service rather than growing a second copy of the rating queries.
const ConfigService = require('../services/ConfigService');
const RatingService = require('../services/rating/RatingService');

const friendService = new FriendService(require('../db'), notificationService);
const clubService = new ClubService(
    require('../db'),
    notificationService,
    new RatingService(new ConfigService())
);
const teamService = new TeamService(require('../db'), notificationService);
const memberDirectory = new MemberDirectoryService();
const storeService = new StoreService();
const playerProfileService = new PlayerProfileService();
const profileCosmeticsService = new ProfileCosmeticsService();

const jwt = passport.authenticate('jwt', { session: false });

/**
 * ARCHON (N12): the caller's own capabilities.
 *
 * Read from the request rather than passed in from the body, so what a client
 * claims about its membership never decides what it may save.
 */
const capabilitiesFor = (req) => (entitlementsForRequest(req) || {}).capabilities || [];

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

    // ----- Own bio (I3): short, optional, editable from the account page and
    // shown on the public profile above. Authenticated because it edits the
    // caller's own account; reading it back does not need to go through the
    // public /api/players/:username route, which also gates on Verified.
    server.get(
        '/api/account/bio',
        jwt,
        wrapAsync(async (req, res) => {
            const bio = await playerProfileService.getBio(req.user.id);

            res.send({ success: true, bio, maxLength: bioMaxLength(capabilitiesFor(req)) });
        })
    );

    server.put(
        '/api/account/bio',
        jwt,
        wrapAsync(async (req, res) => {
            // ARCHON (N12): members write a longer bio (profile_cosmetics).
            // The limit is applied from the caller's own entitlements rather
            // than from anything the client sends.
            const capabilities = capabilitiesFor(req);
            const result = await playerProfileService.setBio(
                req.user.id,
                req.body.bio,
                capabilities
            );

            res.send({ ...result, maxLength: bioMaxLength(capabilities) });
        })
    );

    // ----- Profile cosmetics (N12): what profile_cosmetics and
    // enhanced_cosmetics actually buy.
    //
    // GET is open to any signed-in account on purpose. A free player is shown
    // the whole catalogue with the locked options marked, because "you could
    // have this" is the only thing on the page that earns an upgrade - a
    // picker that silently has fewer swatches teaches them nothing.
    server.get(
        '/api/account/cosmetics',
        jwt,
        wrapAsync(async (req, res) => {
            const capabilities = capabilitiesFor(req);

            res.send({
                success: true,
                cosmetics: await profileCosmeticsService.get(req.user.id),
                catalog: cosmeticsCatalog(capabilities),
                bioMaxLength: bioMaxLength(capabilities)
            });
        })
    );

    // PUT is gated: every option above the defaults costs something, so an
    // account with no cosmetics capability has nothing it could legitimately
    // save. Individual options are checked again inside `save`, because
    // holding the Supporter capability does not make a Vault Master option
    // yours.
    server.put(
        '/api/account/cosmetics',
        jwt,
        requireCapability(CAPABILITIES.PROFILE_COSMETICS),
        wrapAsync(async (req, res) => {
            const result = await profileCosmeticsService.save(
                req.user.id,
                req.body && req.body.cosmetics ? req.body.cosmetics : req.body,
                capabilitiesFor(req)
            );

            res.send(result);
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

    // ARCHON: named invitations. The join code covers "anyone with this string";
    // this covers "I want Sam", which is what an owner actually wants most of
    // the time and had no way to express.
    //
    // Declared before '/api/clubs/:id' on purpose. Express matches in
    // registration order, so the other way round this literal path arrives at
    // the detail handler as the id "invitations" and 404s a route that exists.
    server.get(
        '/api/clubs/invitations',
        jwt,
        wrapAsync(async (req, res) => {
            res.send({ success: true, invitations: await clubService.invitations(req.user.id) });
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
        '/api/clubs/:id/invite',
        jwt,
        clubInviteLimit,
        wrapAsync(async (req, res) => {
            res.send(
                await clubService.invite(parseInt(req.params.id, 10), req.user, req.body.username)
            );
        })
    );

    server.post(
        '/api/clubs/:id/invitation',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(
                await clubService.respondToInvitation(
                    parseInt(req.params.id, 10),
                    req.user.id,
                    !!req.body.accept
                )
            );
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

    // ----- ARCHON (N7): club competition
    // Public: a club board is no more than the site leaderboard already shows.
    server.get(
        '/api/clubs/:id/leaderboard',
        wrapAsync(async (req, res) => {
            res.send(
                await clubService.getLeaderboard(parseInt(req.params.id, 10), {
                    pool: req.query.pool
                })
            );
        })
    );

    server.post(
        '/api/clubs/:id/settings',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(
                await clubService.updateSettings(parseInt(req.params.id, 10), req.user, req.body)
            );
        })
    );

    server.post(
        '/api/clubs/:id/requests/:userId',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(
                await clubService.decideJoinRequest(
                    parseInt(req.params.id, 10),
                    parseInt(req.params.userId, 10),
                    req.user,
                    req.body.approve === true
                )
            );
        })
    );

    server.post(
        '/api/clubs/:id/transfer',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(
                await clubService.transferOwnership(
                    parseInt(req.params.id, 10),
                    parseInt(req.body.userId, 10),
                    req.user
                )
            );
        })
    );

    // ----- ARCHON (N7): teams
    // The team ladder registers before /api/teams/:id so 'leaderboard' is
    // never parsed as a team id (Express matches in registration order).
    server.get(
        '/api/teams/leaderboard',
        wrapAsync(async (req, res) => {
            res.send({
                success: true,
                entries: await teamService.getLeaderboard({
                    pool: req.query.pool,
                    limit: req.query.limit
                })
            });
        })
    );

    server.get(
        '/api/teams/mine',
        jwt,
        wrapAsync(async (req, res) => {
            res.send({ success: true, teams: await teamService.getTeamsForUser(req.user.id) });
        })
    );

    server.get(
        '/api/teams',
        wrapAsync(async (req, res) => {
            res.send({ success: true, teams: await teamService.list(req.query.query) });
        })
    );

    server.post(
        '/api/teams',
        jwt,
        clubCreateLimit,
        wrapAsync(async (req, res) => {
            res.send(await teamService.create(req.user.id, req.body));
        })
    );

    server.post(
        '/api/teams/join-by-code',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(await teamService.joinByCode(req.user.id, req.body.code));
        })
    );

    server.get(
        '/api/teams/:id',
        wrapAsync(async (req, res) => {
            const user = req.user || null;

            res.send(await teamService.getDetail(parseInt(req.params.id, 10), user?.id || null));
        })
    );

    server.post(
        '/api/teams/:id/leave',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(await teamService.leave(parseInt(req.params.id, 10), req.user.id));
        })
    );

    server.post(
        '/api/teams/:id/remove',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(
                await teamService.removeMember(
                    parseInt(req.params.id, 10),
                    parseInt(req.body.userId, 10),
                    req.user
                )
            );
        })
    );

    server.post(
        '/api/teams/:id/transfer',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(
                await teamService.transferCaptaincy(
                    parseInt(req.params.id, 10),
                    parseInt(req.body.userId, 10),
                    req.user
                )
            );
        })
    );

    server.post(
        '/api/teams/:id/disband',
        jwt,
        wrapAsync(async (req, res) => {
            res.send(await teamService.disband(parseInt(req.params.id, 10), req.user));
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
