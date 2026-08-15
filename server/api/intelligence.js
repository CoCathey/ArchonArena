const passport = require('passport');

const { wrapAsync } = require('../util.js');
const ArchonIntelligenceService = require('../services/membership/ArchonIntelligenceService');
const TournamentLabService = require('../services/membership/TournamentLabService');
const AercAnalyticsService = require('../services/membership/AercAnalyticsService');
const {
    requireCapability,
    requireAnyCapability,
    sectionsFor,
    entitlementsForRequest
} = require('./requireCapability');
const { CAPABILITIES } = require('../services/membership/capabilities');
const { can } = require('../services/membership/entitlements');
const { parseSets } = require('../services/membership/setFilter');
const MemberPreferencesService = require('../services/membership/MemberPreferencesService');
const { canUsePreview } = require('../services/membership/previews');

const intelligence = new ArchonIntelligenceService();
const tournamentLab = new TournamentLabService(undefined, intelligence);
const preferences = new MemberPreferencesService();
const aerc = new AercAnalyticsService();

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

    /**
     * ARCHON (N12): this payload spans three tiers, so it is gated per section
     * rather than as a whole.
     *
     * It used to require ARCHON_INTELLIGENCE for everything - which meant a
     * Supporter, who is sold "Full Elo history" and a "Performance dashboard"
     * for $5, got a 403 on the only endpoint that serves them. They were paying
     * for two things they could not reach. Gating on the lowest capability and
     * filtering the sections is what actually matches what was sold.
     *
     * Sections are computed only when the caller is entitled to them, so this
     * also stops doing four queries for someone who may see one.
     */
    const PLAYER_SECTIONS = {
        // Supporter
        ratingHistory: CAPABILITIES.ELO_HISTORY,
        vsExpectation: CAPABILITIES.PERFORMANCE_DASHBOARD,
        // Archon
        rankings: CAPABILITIES.PERSONAL_DECK_RANKINGS,
        byHouse: CAPABILITIES.MATCHUP_ANALYTICS,
        // The set counterpart of byHouse - same shape, same question asked of a
        // different dimension - so it is sold with it rather than separately.
        bySet: CAPABILITIES.MATCHUP_ANALYTICS
    };

    /**
     * ARCHON (N12): sections that are not part of any tier yet, because they are
     * in the preview programme.
     *
     * Gated on the preview rather than on a capability: a preview's audience is
     * "the tier its stage admits, that has switched it on", which no single
     * capability expresses. When one graduates, its entry moves to
     * PLAYER_SECTIONS above and the line here is deleted - the shape of that
     * move is the whole reason the two lists are separate.
     */
    const PREVIEW_SECTIONS = {
        vsExpectationTrend: 'performance-trend',
        form: 'form-and-streaks',
        byTurnOrder: 'turn-order-insights'
    };

    server.get(
        '/api/intelligence/player',
        passport.authenticate('jwt', { session: false }),
        // The preview capabilities are admitted too: a tier that holds only
        // those would otherwise be refused at the door and never reach the
        // sections it does have.
        requireAnyCapability([
            ...Object.values(PLAYER_SECTIONS),
            CAPABILITIES.EXPERIMENTAL_FEATURES,
            CAPABILITIES.BETA_FEATURES,
            CAPABILITIES.EARLY_ACCESS
        ]),
        wrapAsync(async (req, res) => {
            const sets = parseSets(req.query.sets);
            const { allowed, locked } = sectionsFor(req, PLAYER_SECTIONS);

            // One read for the account's switches, then a pure decision per
            // section - rather than a query per preview. Skipped entirely for a
            // tier that reaches no preview stage, which is most accounts: their
            // switches cannot change the answer, so reading them is a query
            // spent on nothing.
            const entitlements = entitlementsForRequest(req);
            const reachesPreviews = [
                CAPABILITIES.EXPERIMENTAL_FEATURES,
                CAPABILITIES.BETA_FEATURES,
                CAPABILITIES.EARLY_ACCESS
            ].some((capability) => can(entitlements, capability));
            const choices = reachesPreviews ? await preferences.getPreviewChoices(req.user.id) : {};
            const previews = reachesPreviews
                ? Object.entries(PREVIEW_SECTIONS)
                      .filter(([, previewId]) => canUsePreview(entitlements, choices, previewId))
                      .map(([section]) => section)
                : [];

            const producers = {
                // Not set-filtered, deliberately: a rating is one number across
                // every set, so narrowing the series would draw a line with the
                // games that moved it missing from underneath it.
                ratingHistory: () => intelligence.playerRatingHistory(req.user.id, { limit: 500 }),
                vsExpectation: () => intelligence.playerVsExpectation(req.user.id, { sets }),
                rankings: () => intelligence.playerDeckRankings(req.user.id, { sets }),
                byHouse: () => intelligence.playerByOwnHouse(req.user.id, { sets }),
                // Also unfiltered, for the opposite reason: this is the table
                // the filter is chosen FROM, so narrowing it to the current
                // selection would collapse it to one row and hide the
                // comparison that makes the filter worth setting.
                bySet: () => intelligence.playerBySet(req.user.id),
                // ---- preview sections ----
                vsExpectationTrend: () =>
                    intelligence.playerVsExpectationTrend(req.user.id, { sets }),
                // Not set-filtered, for the same reason the rating series is
                // not: a run of results is a run of games in the order they
                // happened, and dropping some of them from the middle would
                // draw a streak that never occurred.
                form: () => intelligence.playerForm(req.user.id),
                byTurnOrder: () => intelligence.playerByTurnOrder(req.user.id, { sets })
            };

            const sections = [...allowed, ...previews];
            const results = await Promise.all(sections.map((section) => producers[section]()));
            const payload = Object.fromEntries(
                sections.map((section, index) => [section, results[index]])
            );

            // `locked` tells the client which panels to render as upgrade
            // prompts rather than as missing. `sets` echoes the filter back so
            // the client can tell "no filter" from "filter returned nothing".
            // `previews` names the sections that arrived through the preview
            // programme, so the client can label them as such - an unlabelled
            // beta panel is how a work in progress gets read as a finished
            // promise.
            res.send({ success: true, sets, ...payload, locked, previews });
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

    /**
     * ARCHON: the same record, read in AERC terms instead of SAS.
     *
     * One request rather than one per panel: every panel here shares the
     * band cut points and the same filter, and firing nine requests to draw one
     * screen would be slower and would make the panels disagree while they
     * arrived.
     *
     * `trait` picks the trait the per-band panels are computed for - the
     * headline findings walk all of them regardless, because the whole point is
     * to tell a player which trait to look at.
     */
    server.get(
        '/api/intelligence/aerc',
        passport.authenticate('jwt', { session: false }),
        requireCapability(CAPABILITIES.AERC_ANALYTICS),
        wrapAsync(async (req, res) => {
            const requested = String(req.query.trait || '');
            // Guarded rather than trusted: the trait name is interpolated into
            // SQL as a JSON key, so an unknown one must never reach the query.
            const trait = AercAnalyticsService.isTrait(requested)
                ? requested
                : AercAnalyticsService.traits[0].key;
            const sets = parseSets(req.query.sets);
            const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);

            const [own, opponent, houses, findings, meta, cards] = await Promise.all([
                aerc.byOwnTrait(req.user.id, trait, { sets }),
                aerc.byOpponentTrait(req.user.id, trait, { sets }),
                aerc.housesVsOpponentTrait(req.user.id, trait, { sets }),
                aerc.findings(req.user.id, { sets }),
                aerc.metaTraitProfile({ days, sets }),
                aerc.byCard(req.user.id, { sets })
            ]);

            res.send({
                success: true,
                trait,
                sets,
                days,
                traits: AercAnalyticsService.traits,
                minConfidentGames: AercAnalyticsService.MIN_CONFIDENT_GAMES,
                own,
                opponent,
                houses,
                findings,
                meta,
                cards
            });
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
