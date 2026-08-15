const passport = require('passport');

const { wrapAsync } = require('../util.js');
const ArchonIntelligenceService = require('../services/membership/ArchonIntelligenceService');
const TournamentLabService = require('../services/membership/TournamentLabService');
const { requireCapability } = require('./requireCapability');
const { CAPABILITIES } = require('../services/membership/capabilities');
const { parseSets } = require('../services/membership/setFilter');

const intelligence = new ArchonIntelligenceService();
const tournamentLab = new TournamentLabService(undefined, intelligence);

/**
 * ARCHON (N12): Archon Intelligence and the Tournament Lab.
 *
 * Every route here is authenticated AND capability-gated. The client blurs
 * these panels for a free account, but that is a courtesy - this is where the
 * data is actually withheld, so a locked user cannot simply call the endpoint.
 *
 * Admins pass `requireCapability` without it knowing anything about admins: the
 * capability list on their token already contains everything, because
 * resolveEntitlements put it there.
 *
 * Scoping: deck intelligence is always computed for the requesting user's own
 * games unless the deck is theirs. There is no route here that lets one player
 * read another's per-deck record - that would be a privacy change wearing a
 * premium feature's clothes.
 *
 * Sets: every route that aggregates takes `?sets=800,874` - a comma-separated
 * list of set codes, the same numbers an event stores in AllowedSets and the
 * same ones the client's expansion constants use. Absent or empty means every
 * set. Junk entries are dropped rather than 400'd: a narrowing filter arriving
 * malformed should show more than the caller asked for, never fail the page.
 */
module.exports.init = function (server) {
    server.get(
        '/api/intelligence/deck/:id',
        passport.authenticate('jwt', { session: false }),
        requireCapability(CAPABILITIES.ARCHON_INTELLIGENCE),
        wrapAsync(async (req, res) => {
            const deckId = parseInt(req.params.id, 10);

            if (!Number.isFinite(deckId)) {
                return res.status(400).send({ success: false, message: 'Invalid deck id' });
            }

            const owns = await intelligence.deckBelongsTo(deckId, req.user.id);

            if (!owns) {
                return res.status(403).send({ success: false, message: 'Not your deck' });
            }

            const [mine, everyone] = await Promise.all([
                // "Am I good with this deck?" - only my games.
                intelligence.deckIntelligence(deckId, { userId: req.user.id }),
                // "Is this a good deck?" - everyone's games with this deck row.
                intelligence.deckOverview(deckId, {})
            ]);

            res.send({ success: true, deckId, mine, everyone });
        })
    );

    server.get(
        '/api/intelligence/player',
        passport.authenticate('jwt', { session: false }),
        requireCapability(CAPABILITIES.ARCHON_INTELLIGENCE),
        wrapAsync(async (req, res) => {
            const sets = parseSets(req.query.sets);

            const [rankings, vsExpectation, byHouse, bySet, ratingHistory] = await Promise.all([
                intelligence.playerDeckRankings(req.user.id, { sets }),
                intelligence.playerVsExpectation(req.user.id, { sets }),
                intelligence.playerByOwnHouse(req.user.id, { sets }),
                // Unfiltered on purpose: this is the table the filter is chosen
                // FROM, so narrowing it to the current filter would collapse it
                // to a single row and hide the comparison.
                intelligence.playerBySet(req.user.id),
                intelligence.playerRatingHistory(req.user.id, { limit: 500 })
            ]);

            res.send({
                success: true,
                sets,
                rankings,
                vsExpectation,
                byHouse,
                bySet,
                ratingHistory
            });
        })
    );

    server.get(
        '/api/intelligence/meta',
        passport.authenticate('jwt', { session: false }),
        requireCapability(CAPABILITIES.META_ANALYTICS),
        wrapAsync(async (req, res) => {
            const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
            const sets = parseSets(req.query.sets);

            const [houses, summary, bySet] = await Promise.all([
                intelligence.metaHouses({ days, sets }),
                intelligence.metaSummary({ days, sets }),
                // Also unfiltered: the set table is the map, not the territory.
                intelligence.metaSets({ days })
            ]);

            // `sets` echoes the filter, `bySet` is the breakdown - the same
            // pairing the player route uses.
            res.send({ success: true, days, sets, houses, summary, bySet });
        })
    );

    server.get(
        '/api/intelligence/tournament-lab',
        passport.authenticate('jwt', { session: false }),
        requireCapability(CAPABILITIES.TOURNAMENT_LAB),
        wrapAsync(async (req, res) => {
            const deckIds = String(req.query.decks || '')
                .split(',')
                .map((id) => parseInt(id, 10))
                .filter(Number.isFinite)
                // A hard cap: this fans out per deck, and an unbounded list is
                // an easy way to make the database do a lot of work per request.
                .slice(0, 8);

            // `tournament` scopes to a real event and wins over `sets`; the
            // service reads the event's own AllowedSets rather than trusting
            // a list the caller assembled.
            const comparison = await tournamentLab.compare(req.user.id, deckIds, {
                sets: parseSets(req.query.sets),
                tournamentId: req.query.tournament || null
            });

            res.send({ success: true, ...comparison });
        })
    );
};
