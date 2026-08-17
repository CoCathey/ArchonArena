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

    // ARCHON (N21): the randomizer - fill a roster slot with a random
    // eligible deck that swaps itself for a fresh one after `games` games.
    server.post(
        '/api/champions-challenge/decks/random',
        passport.authenticate('jwt', { session: false }),
        requireCapability(CAPABILITIES.CHAMPIONS_CHALLENGE),
        wrapAsync(async (req, res) => {
            const games = parseInt(req.body && req.body.games, 10);

            if (!Number.isFinite(games) || games < 1 || games > 500) {
                return res.status(400).send({
                    success: false,
                    message: 'Games before the swap must be between 1 and 500.'
                });
            }

            const config = championsChallenge.getConfig();
            const enrolled = await championsChallenge.db.query(
                'SELECT COUNT(*)::int AS "Count" FROM "ProvingGroundsDecks" WHERE "UserId" = $1',
                [req.user.id]
            );

            if (enrolled[0] && enrolled[0].Count >= config.maxEnrolledPerUser) {
                return res.status(400).send({
                    success: false,
                    message:
                        `All ${config.maxEnrolledPerUser} Champion’s Challenge slots are in ` +
                        'use. Withdraw a deck to add a random one.'
                });
            }

            const deckId = await championsChallenge.enrollRandomDeck(req.user.id, games);

            if (!deckId) {
                return res.status(400).send({
                    success: false,
                    message:
                        'No eligible deck to draw: every rated, simulatable deck you own is ' +
                        'already enrolled.'
                });
            }

            res.send({ success: true, deckId });
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
