const passport = require('passport');

const { wrapAsync } = require('../util.js');
const ConfigService = require('../services/ConfigService');
const ChampionsChallengeService = require('../services/championschallenge/ChampionsChallengeService');
const { requireCapability } = require('./requireCapability');
const { CAPABILITIES } = require('../services/membership/capabilities');

const configService = new ConfigService();
const championsChallenge = new ChampionsChallengeService(configService);

/**
 * ARCHON (N18): the Champion’s Challenge - Vault Master's background deck testing.
 *
 * Every route is authenticated AND gated on the capability: the page blurs
 * itself for a locked account, but this is where the data is actually
 * withheld. Scoping is strictly to the caller's own roster - there is no
 * route that reads another member's lab, because simulated results are a
 * member's private analysis of their own decks.
 *
 * Expected failures (a full roster, someone else's deck, an unsimulatable
 * set) are thrown by the service with player-readable messages and forwarded
 * here as 400s, so the page can show the sentence rather than a shrug.
 */
module.exports.init = function (server) {
    server.get(
        '/api/champions-challenge',
        passport.authenticate('jwt', { session: false }),
        requireCapability(CAPABILITIES.CHAMPIONS_CHALLENGE),
        wrapAsync(async (req, res) => {
            const report = await championsChallenge.getLabReport(req.user.id, {
                isAdmin: !!(req.user.permissions && req.user.permissions.isAdmin)
            });

            res.send({ success: true, ...report });
        })
    );

    // ARCHON (N21): the randomizer - fill roster slots with random eligible
    // decks, each swapping itself for a fresh one after `games` games.
    // `count` fills several at once; it is clamped to the slots actually
    // free rather than refused, because "add 5" with 3 slots left plainly
    // means "add what fits".
    server.post(
        '/api/champions-challenge/decks/random',
        passport.authenticate('jwt', { session: false }),
        requireCapability(CAPABILITIES.CHAMPIONS_CHALLENGE),
        wrapAsync(async (req, res) => {
            const games = parseInt(req.body && req.body.games, 10);
            const requested =
                req.body && req.body.count !== undefined ? parseInt(req.body.count, 10) : 1;

            if (!Number.isFinite(games) || games < 1 || games > 500) {
                return res.status(400).send({
                    success: false,
                    message: 'Games before the swap must be between 1 and 500.'
                });
            }

            const config = championsChallenge.getConfig();

            if (!Number.isFinite(requested) || requested < 1) {
                return res.status(400).send({
                    success: false,
                    message: 'Number of random decks must be at least 1.'
                });
            }

            const enrolled = await championsChallenge.db.query(
                'SELECT COUNT(*)::int AS "Count" FROM "ProvingGroundsDecks" WHERE "UserId" = $1',
                [req.user.id]
            );
            const used = (enrolled[0] && enrolled[0].Count) || 0;
            const free = config.maxEnrolledPerUser - used;

            if (free <= 0) {
                return res.status(400).send({
                    success: false,
                    message:
                        `All ${config.maxEnrolledPerUser} Champion’s Challenge slots are in ` +
                        'use. Withdraw a deck to add a random one.'
                });
            }

            const deckIds = await championsChallenge.enrollRandomDecks(
                req.user.id,
                games,
                Math.min(requested, free)
            );

            if (!deckIds.length) {
                return res.status(400).send({
                    success: false,
                    message:
                        'No eligible deck to draw: every rated, simulatable deck you own is ' +
                        'already enrolled.'
                });
            }

            res.send({
                success: true,
                deckIds,
                // Kept for older clients, which asked for one and read one.
                deckId: deckIds[0],
                added: deckIds.length,
                requested
            });
        })
    );

    // ARCHON (N26): the lab's vital signs. Admin-only, and a separate route
    // from the member report because it is a different question: not "how are my
    // decks doing" but "is the lab working at all" - the pool, the diary, the
    // sweep lease and which node holds it.
    server.get(
        '/api/champions-challenge/health',
        passport.authenticate('jwt', { session: false }),
        wrapAsync(async (req, res) => {
            if (!(req.user.permissions && req.user.permissions.isAdmin)) {
                return res.status(403).send({ success: false, message: 'Admins only.' });
            }

            res.send({ success: true, health: await championsChallenge.labHealth() });
        })
    );

    // ARCHON (N24): the Gauntlet's own settings - whether to play the field,
    // how much of the time, and which decks count as the field.
    server.post(
        '/api/champions-challenge/gauntlet',
        passport.authenticate('jwt', { session: false }),
        requireCapability(CAPABILITIES.CHAMPIONS_CHALLENGE),
        wrapAsync(async (req, res) => {
            const body = req.body || {};
            const asList = (value) => (Array.isArray(value) ? value.slice(0, 40) : []);

            const settings = await championsChallenge.gauntletService.saveSettings(req.user.id, {
                enabled: !!body.enabled,
                fieldSharePct: body.fieldSharePct,
                sets: asList(body.sets),
                houses: asList(body.houses),
                strategies: asList(body.strategies),
                minSas: body.minSas,
                maxSas: body.maxSas
            });
            const pool = await championsChallenge.gauntletService.poolStatus(req.user.id, settings);

            res.send({ success: true, gauntlet: { ...settings, pool } });
        })
    );

    server.post(
        '/api/champions-challenge/decks',
        passport.authenticate('jwt', { session: false }),
        requireCapability(CAPABILITIES.CHAMPIONS_CHALLENGE),
        wrapAsync(async (req, res) => {
            const deckId = parseInt(req.body && req.body.deckId, 10);

            if (!Number.isFinite(deckId)) {
                return res.status(400).send({ success: false, message: 'Invalid deck id' });
            }

            try {
                await championsChallenge.enrollDeck(req.user.id, deckId);
            } catch (err) {
                return res.status(400).send({ success: false, message: err.message });
            }

            res.send({ success: true });
        })
    );

    server.delete(
        '/api/champions-challenge/decks/:id',
        passport.authenticate('jwt', { session: false }),
        requireCapability(CAPABILITIES.CHAMPIONS_CHALLENGE),
        wrapAsync(async (req, res) => {
            const deckId = parseInt(req.params.id, 10);

            if (!Number.isFinite(deckId)) {
                return res.status(400).send({ success: false, message: 'Invalid deck id' });
            }

            await championsChallenge.withdrawDeck(req.user.id, deckId);

            res.send({ success: true });
        })
    );
};

// The lobby reuses this instance for its sweep, the same way analytics and
// moderation are shared - one service, one card cache, one config read.
module.exports.championsChallengeService = championsChallenge;
