const passport = require('passport');

const TournamentService = require('../services/tournament/TournamentService');
const { wrapAsync } = require('../util.js');
const { rateLimit } = require('./rateLimit');
// ARCHON (N12): organiser exports, behind the Vault Master capability.
const { requireCapability } = require('./requireCapability');
const { CAPABILITIES } = require('../services/membership/capabilities');
const { buildExport, toCsv, DATASET_IDS } = require('../services/tournament/organizerExport');

// ARCHON (N7): finishing a team event rates the team ladder.
const TeamRatingService = require('../services/rating/TeamRatingService');

const tournamentService = new TournamentService(require('../db'), {
    teamRatingService: new TeamRatingService()
});

const tournamentCreateLimit = rateLimit({
    name: 'tournament-create',
    windowMs: 60 * 60 * 1000,
    max: 10,
    message:
        'You have created several tournaments recently. Please wait a while before creating another.'
});

// ARCHON: opening a table is the most expensive thing a participant can ask
// for - it builds a lobby game and broadcasts it to everyone in the lobby. A
// player opening their own table does it once or twice a round; the ceiling is
// only here so one account cannot fill the lobby list with tables.
const openGameLimit = rateLimit({
    name: 'tournament-open-game',
    windowMs: 10 * 60 * 1000,
    max: 30,
    message: 'You have opened a lot of tables. Please wait a moment before opening another.'
});

// Scheduling and result reporting both notify the other player, in-app and by
// email. Generous enough that a real negotiation never touches it, low enough
// that the notification path is not a way to bother somebody.
const matchTrafficLimit = rateLimit({
    name: 'tournament-match-traffic',
    windowMs: 10 * 60 * 1000,
    max: 60,
    message: 'Too many match updates in a short time. Please wait a moment and try again.'
});

/**
 * ARCHON: native tournament engine API (Phase 7). Reads are public
 * (with optional auth for actor-specific flags and private events);
 * every mutation is JWT-authed and authorized inside the service
 * (organizer / staff / participant / site TO rules).
 */
module.exports.init = function (server) {
    const optionalAuth = (handler) =>
        wrapAsync(async (req, res, next) => {
            passport.authenticate('jwt', { session: false }, async (err, user) => {
                if (err) {
                    return next(err);
                }

                try {
                    await handler(req, res, user || null);
                } catch (innerErr) {
                    next(innerErr);
                }
            })(req, res, next);
        });

    server.get(
        '/api/tournaments',
        optionalAuth(async (req, res, user) => {
            const tournaments = await tournamentService.list(req.query.status, user);

            res.send({ success: true, tournaments });
        })
    );

    server.post(
        '/api/tournaments',
        passport.authenticate('jwt', { session: false }),
        tournamentCreateLimit,
        wrapAsync(async (req, res) => {
            res.send(await tournamentService.create(req.user, req.body));
        })
    );

    server.get(
        '/api/tournaments/history/:username',
        wrapAsync(async (req, res) => {
            const events = await tournamentService.history(req.params.username);

            res.send({ success: true, events });
        })
    );

    // ARCHON (N14): every open match the caller owes, across all their live
    // events. Declared before '/:id' so 'my-matches' is not read as an id.
    server.get(
        '/api/tournaments/my-matches',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            const matches = await tournamentService.myOpenMatches(req.user);

            res.send({ success: true, matches });
        })
    );

    server.get(
        '/api/tournaments/:id',
        optionalAuth(async (req, res, user) => {
            res.send(await tournamentService.getDetail(parseInt(req.params.id, 10), user));
        })
    );

    /**
     * ARCHON (N12): take the event away as a spreadsheet.
     *
     * Two gates, and they are not the same gate:
     *
     *   - `requireCapability(ORGANIZER_TOOLS)` - is this a membership that
     *     includes organiser tooling at all;
     *   - `canManage` on the event itself - is this THEIR event.
     *
     * Neither implies the other, and dropping either one would be a real hole:
     * without the first the tier is being given away, and without the second a
     * Vault Master could export the entry list, decklists and payment status of
     * somebody else's private tournament. `canManage` comes back from getDetail
     * rather than being re-derived here, so the answer is the same one the page
     * itself uses.
     *
     * Declared before the `/:id/...` POST actions purely for readability; Express
     * matches on method and full path, so order does not matter here.
     */
    server.get(
        '/api/tournaments/:id/export',
        passport.authenticate('jwt', { session: false }),
        requireCapability(CAPABILITIES.ORGANIZER_TOOLS),
        wrapAsync(async (req, res) => {
            const dataset = String(req.query.dataset || 'standings');

            if (!DATASET_IDS.includes(dataset)) {
                return res.status(400).send({
                    success: false,
                    message: `Unknown dataset. Choose one of: ${DATASET_IDS.join(', ')}.`
                });
            }

            const detail = await tournamentService.getDetail(parseInt(req.params.id, 10), req.user);

            if (!detail.success) {
                return res.status(404).send(detail);
            }

            if (!detail.tournament.canManage) {
                return res.status(403).send({
                    success: false,
                    message: 'Only the organiser and staff of an event can export it.'
                });
            }

            const built = buildExport(detail, dataset);

            // JSON when asked for, so an organiser scripting against this does
            // not have to parse back out of CSV.
            if (String(req.query.format || 'csv').toLowerCase() === 'json') {
                return res.send({ success: true, ...built });
            }

            res.set('Content-Type', 'text/csv; charset=utf-8');
            // The filename an organiser sees in their downloads folder. Built
            // from the event name in organizerExport, and stripped there to
            // characters that cannot break out of this header.
            res.set('Content-Disposition', `attachment; filename="${built.filename}"`);

            res.send(toCsv(built));
        })
    );

    // `limit` is optional: most of these are organizer tools behind an
    // authorization check in the service, and the ones worth bounding are the
    // ones any participant can call.
    const action = (path, handler, limit) =>
        server.post(
            path,
            passport.authenticate('jwt', { session: false }),
            ...(limit ? [limit] : []),
            wrapAsync(async (req, res) => {
                res.send(await handler(req));
            })
        );

    action('/api/tournaments/:id/register', (req) =>
        tournamentService.register(parseInt(req.params.id, 10), req.user, {
            joinCode: req.body.joinCode,
            deckId: req.body.deckId ? parseInt(req.body.deckId, 10) : null,
            // ARCHON (N7): which team the player is entering under.
            teamId: req.body.teamId ? parseInt(req.body.teamId, 10) : null,
            // ARCHON: an organizer entering somebody - the only way a player
            // can join an event that has already started. Authorized in the
            // service, like every other judge action.
            userId: req.body.userId ? parseInt(req.body.userId, 10) : null,
            username: req.body.username || null
        })
    );

    // ARCHON (N9): kiosk check-in. Not under /:id - the scanned code IS the
    // event, which is the whole point of a QR at the door.
    action('/api/tournaments/check-in-by-code', (req) =>
        tournamentService.checkInByCode(req.body.code, req.user)
    );

    action('/api/tournaments/:id/register-deck', (req) =>
        tournamentService.registerDeck(
            parseInt(req.params.id, 10),
            req.user,
            req.body.deckId ? parseInt(req.body.deckId, 10) : null,
            // ARCHON: an organizer ruling on somebody else's deck. Authorized
            // in the service, like every other judge action.
            req.body.userId ? parseInt(req.body.userId, 10) : null
        )
    );

    action('/api/tournaments/:id/register-triad-decks', (req) =>
        tournamentService.registerTriadDecks(
            parseInt(req.params.id, 10),
            req.user,
            req.body.deckIds
        )
    );

    action('/api/tournaments/:id/drop', (req) =>
        tournamentService.drop(
            parseInt(req.params.id, 10),
            req.body.userId ? parseInt(req.body.userId, 10) : null,
            req.user
        )
    );

    action('/api/tournaments/:id/update', (req) =>
        tournamentService.updateSettings(parseInt(req.params.id, 10), req.user, req.body)
    );

    action('/api/tournaments/:id/open-check-in', (req) =>
        tournamentService.openCheckIn(parseInt(req.params.id, 10), req.user)
    );

    action('/api/tournaments/:id/check-in', (req) =>
        tournamentService.checkIn(parseInt(req.params.id, 10), req.user, {
            // ARCHON: the desk marking somebody present. Authorized in the
            // service - only staff may name a player other than themselves.
            userId: req.body.userId ? parseInt(req.body.userId, 10) : null
        })
    );

    // ARCHON: the entry-payment register. Staff only - authorized in the
    // service, where the "not the player themselves" rule lives.
    action('/api/tournaments/:id/set-paid', (req) =>
        tournamentService.setPaid(
            parseInt(req.params.id, 10),
            req.user,
            req.body.userId,
            req.body.paid !== false
        )
    );

    action('/api/tournaments/:id/seeds', (req) =>
        tournamentService.setSeeds(parseInt(req.params.id, 10), req.user, req.body.seeds)
    );

    action('/api/tournaments/:id/staff/add', (req) =>
        tournamentService.addStaff(parseInt(req.params.id, 10), req.user, req.body.username)
    );

    action('/api/tournaments/:id/staff/remove', (req) =>
        tournamentService.removeStaff(parseInt(req.params.id, 10), req.user, req.body.userId)
    );

    action('/api/tournaments/:id/start', (req) =>
        tournamentService.start(parseInt(req.params.id, 10), req.user, {
            dropNoShows: !!req.body.dropNoShows
        })
    );

    action('/api/tournaments/:id/next-round', (req) =>
        tournamentService.nextRound(parseInt(req.params.id, 10), req.user)
    );

    action('/api/tournaments/:id/cut', (req) =>
        tournamentService.cutToPlayoff(parseInt(req.params.id, 10), req.user)
    );

    // ARCHON: "time in the round" - decide every match still open, so one
    // absent player cannot hold the event open indefinitely.
    action('/api/tournaments/:id/resolve-unfinished', (req) =>
        tournamentService.resolveUnfinished(parseInt(req.params.id, 10), req.user, {
            tieBreak: req.body.tieBreak
        })
    );

    action('/api/tournaments/:id/round-clock', (req) =>
        tournamentService.adjustRoundClock(parseInt(req.params.id, 10), req.user, req.body.minutes)
    );

    action(
        '/api/tournaments/:id/matches/:matchId/result',
        (req) =>
            tournamentService.reportResult(
                parseInt(req.params.id, 10),
                parseInt(req.params.matchId, 10),
                parseInt(req.body.winnerId, 10),
                req.user,
                {
                    player1Wins: req.body.player1Wins,
                    player2Wins: req.body.player2Wins,
                    // ARCHON (N9): 'paper' for a result played across a table.
                    source: req.body.source
                }
            ),
        matchTrafficLimit
    );

    // ARCHON: the opponent's half of a reported result - agree with it, or
    // say it is wrong and put it in front of the organizer.
    action(
        '/api/tournaments/:id/matches/:matchId/confirm',
        (req) =>
            tournamentService.confirmResult(
                parseInt(req.params.id, 10),
                parseInt(req.params.matchId, 10),
                req.user
            ),
        matchTrafficLimit
    );

    action(
        '/api/tournaments/:id/matches/:matchId/dispute',
        (req) =>
            tournamentService.disputeResult(
                parseInt(req.params.id, 10),
                parseInt(req.params.matchId, 10),
                req.user,
                req.body.note
            ),
        matchTrafficLimit
    );

    action('/api/tournaments/:id/matches/:matchId/award', (req) =>
        tournamentService.awardWin(
            parseInt(req.params.id, 10),
            parseInt(req.params.matchId, 10),
            parseInt(req.body.winnerId, 10),
            req.user,
            req.body.resultType || 'forfeit'
        )
    );

    action('/api/tournaments/:id/matches/:matchId/double-loss', (req) =>
        tournamentService.doubleLoss(
            parseInt(req.params.id, 10),
            parseInt(req.params.matchId, 10),
            req.user
        )
    );

    action(
        '/api/tournaments/:id/matches/:matchId/open-game',
        (req) =>
            tournamentService.ensureGameForMatch(
                parseInt(req.params.id, 10),
                parseInt(req.params.matchId, 10),
                req.user
            ),
        openGameLimit
    );

    // ARCHON (N14): asynchronous events - the two players of a match agree
    // between themselves when to play it, inside the round's deadline.
    action(
        '/api/tournaments/:id/matches/:matchId/propose-time',
        (req) =>
            tournamentService.proposeMatchTime(
                parseInt(req.params.id, 10),
                parseInt(req.params.matchId, 10),
                req.user,
                req.body.time,
                req.body.note,
                // The browser's own zone, so an offer can be shown as "8pm
                // your time, 3am theirs". Advisory - see cleanZone.
                req.body.zone
            ),
        matchTrafficLimit
    );

    action(
        '/api/tournaments/:id/matches/:matchId/accept-time',
        (req) =>
            tournamentService.acceptMatchTime(
                parseInt(req.params.id, 10),
                parseInt(req.params.matchId, 10),
                req.user,
                // Which of the offered times. Absent means "the only one",
                // which is what an older client sends.
                req.body.slotId
            ),
        matchTrafficLimit
    );

    // Take one of your own offers back without clearing the rest.
    action(
        '/api/tournaments/:id/matches/:matchId/withdraw-time',
        (req) =>
            tournamentService.withdrawMatchTime(
                parseInt(req.params.id, 10),
                parseInt(req.params.matchId, 10),
                req.user,
                req.body.slotId
            ),
        matchTrafficLimit
    );

    action('/api/tournaments/:id/matches/:matchId/clear-time', (req) =>
        tournamentService.clearMatchSchedule(
            parseInt(req.params.id, 10),
            parseInt(req.params.matchId, 10),
            req.user
        )
    );

    action('/api/tournaments/:id/matches/:matchId/triad-ban', (req) =>
        tournamentService.triadBan(
            parseInt(req.params.id, 10),
            parseInt(req.params.matchId, 10),
            req.user,
            req.body.deckId
        )
    );

    action('/api/tournaments/:id/matches/:matchId/triad-pick', (req) =>
        tournamentService.triadPick(
            parseInt(req.params.id, 10),
            parseInt(req.params.matchId, 10),
            req.user,
            req.body.deckId
        )
    );

    // ARCHON (N9): Adaptive Bo3 chain bidding before game three.
    server.get(
        '/api/tournaments/:id/matches/:matchId/adaptive',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            res.send(
                await tournamentService.getAdaptiveState(
                    parseInt(req.params.id, 10),
                    parseInt(req.params.matchId, 10),
                    req.user
                )
            );
        })
    );

    action('/api/tournaments/:id/matches/:matchId/adaptive-bid', (req) =>
        tournamentService.adaptiveBid(
            parseInt(req.params.id, 10),
            parseInt(req.params.matchId, 10),
            req.user,
            req.body.chains
        )
    );

    action('/api/tournaments/:id/matches/:matchId/adaptive-pass', (req) =>
        tournamentService.adaptivePass(
            parseInt(req.params.id, 10),
            parseInt(req.params.matchId, 10),
            req.user
        )
    );

    action('/api/tournaments/:id/finish', (req) =>
        tournamentService.finish(parseInt(req.params.id, 10), req.user, {
            // ARCHON: the organizer confirming an early finish. See finish().
            force: !!req.body.force
        })
    );

    action('/api/tournaments/:id/cancel', (req) =>
        tournamentService.cancel(parseInt(req.params.id, 10), req.user)
    );
};
