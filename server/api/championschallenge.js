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
            const report = await championsChallenge.getLabReport(req.user.id);

            res.send({ success: true, ...report });
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
