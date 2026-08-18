/*eslint no-console: 0*/

// ARCHON (N38): the advisor packet - the learning loop's telemetry, in one
// paste.
//
//   npm run advisor-packet            (in production:
//   docker compose -f docker-compose.prod.yml --env-file .env.production \
//       exec -T lobby npm run advisor-packet > packet.json)
//
// The third way the Challenge uses AI costs nothing to keep and nothing to
// run: every month or so, hand this JSON to a Claude session alongside the
// repo and ask the questions a pipeline cannot ask - which learned card
// weights look wrong and why, what classic signal the features are missing,
// what to tune when the strength curve goes flat. The output is judgment a
// human applies (a knob in Site Settings, a feature in labFeatures.js), which
// is exactly why it is a conversation and not a job.
//
// Everything here is read-only. What goes in:
//
//  - the admin's challenge settings, as effectively configured
//  - the loop's vitals: champion lineage, diary depth, recent game volume
//  - the strength curve and the persona duel ladder
//  - the AI teacher's licence state, plus its sharpest recent DISAGREEMENTS
//    with the deep bot - the positions worth arguing about
//  - the champion's brain, ranked: state/action weights, the cards it rates
//    highest and lowest (as actually scored: learned weight shrunk toward
//    its text prior by evidence), and the cards where the games most
//    disagree with the card text - each one either a model error or a
//    scouting report
//
// Read-only, safe to run any time; secrets never appear in the packet.

const { shrink } = require('../services/championschallenge/labPolicy');
const { cardPriorsAt } = require('../services/championschallenge/cardPriors');
const { getCardIndex } = require('../services/championschallenge/packCards');

/** Entries of a sparse weight map, shrunk by evidence, named and ranked. */
function rankedCards(model, priors, nameOf, count) {
    const counts = model.cardCounts || {};
    const entries = Object.keys({ ...(model.cardWeights || {}), ...(priors || {}) }).map((id) => {
        const seen = counts[id] || 0;
        const prior = (priors || {})[id] || 0;
        const learned = (model.cardWeights || {})[id] || 0;

        return {
            id,
            name: nameOf(id),
            games: seen,
            prior: round3(prior),
            learned: round3(learned),
            // What actually enters a decision's score today.
            effective: round3(shrink(learned, seen, prior))
        };
    });
    // Ranked among cards with real evidence behind them: an unseen card's
    // "effective" is just its prior, and thousands of those would bury the
    // learned signal under a re-sorted copy of the priors file.
    const byEffective = entries
        .filter((entry) => entry.games >= 10)
        .sort((a, b) => b.effective - a.effective);

    return {
        strongest: byEffective.slice(0, count),
        weakest: byEffective.slice(-count).reverse(),
        // Where the games most contradict the card text, with enough games
        // that the contradiction means something: each row is either a model
        // error or a scouting report, and deciding which is the advisor's
        // best question.
        textDisagreements: entries
            .filter((entry) => entry.games >= 20 && entry.prior !== 0)
            .map((entry) => ({
                ...entry,
                gap: round3(shrink(entry.learned, entry.games, 0) - entry.prior)
            }))
            .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
            .slice(0, 15)
    };
}

function rankedPrompts(model, count) {
    const shrunk = Object.entries(model.promptWeights || {})
        .map(([key, weight]) => ({
            prompt: key,
            games: (model.promptCounts || {})[key] || 0,
            effective: round3(shrink(weight, (model.promptCounts || {})[key]))
        }))
        .sort((a, b) => b.effective - a.effective);

    return { strongest: shrunk.slice(0, count), weakest: shrunk.slice(-count).reverse() };
}

function round3(value) {
    return Math.round(value * 1000) / 1000;
}

/**
 * Assemble the packet from injected services - pure enough to spec against
 * fakes; main() below wires the real ones.
 */
async function buildPacket({ db, settingsService, policyService, teacherService, cardIndex }) {
    const settings = settingsService.getSectionWithDefaults('championsChallenge');
    const nameOf = (id) => (cardIndex[id] && cardIndex[id].name) || id;

    const [vitals, strengthCurve, personaLadder, teacher] = await Promise.all([
        policyService.vitals(),
        policyService.strengthCurve(30),
        policyService.personaLadder(),
        teacherService.vitals()
    ]);

    const [diary, recent, championRows, calibration] = await Promise.all([
        db.query('SELECT COUNT(*)::int AS "Count" FROM "BotTrainingGames"'),
        db.query(
            'SELECT COUNT(*)::int AS "Games", COUNT(*) FILTER (WHERE "Deep")::int AS "Deep" ' +
                'FROM "ProvingGroundsGames" ' +
                "WHERE \"FinishedAt\" >= now() AT TIME ZONE 'utc' - interval '7 days'"
        ),
        db.query(
            'SELECT "Version", "Model" FROM "BotPolicies" ' +
                'WHERE "Status" = \'champion\' ORDER BY "Version" DESC LIMIT 1'
        ),
        db.query(
            'SELECT "Summary", "Candidates", "DeepTargets", "Review" ' +
                'FROM "ChallengeLlmPositions" ' +
                'WHERE "Status" = \'reviewed\' AND "DeepTargets" IS NOT NULL ' +
                'ORDER BY "ReviewedAt" DESC LIMIT 30'
        )
    ]);

    // The teacher's sharpest recent arguments with the deep bot: the
    // positions where its best move was NOT the one the search measured best.
    const disagreements = (calibration || [])
        .filter((row) => row.Review && row.Review.topMatch === false)
        .slice(0, 5)
        .map((row) => ({
            round: row.Summary && row.Summary.round,
            side: row.Summary && row.Summary.side,
            kind: row.Summary && row.Summary.kind,
            candidates: (row.Candidates || []).map((candidate) => candidate.label),
            teacherScores: row.Review.scores,
            deepTargets: row.DeepTargets
        }));

    const champion = championRows && championRows[0] ? championRows[0] : null;
    const priors = cardPriorsAt(settings.cardPriorWeight);

    return {
        generatedAt: new Date().toISOString(),
        note:
            'Champion’s Challenge learning-loop telemetry. Paste into a Claude ' +
            'session (ideally one with the ArchonArena repo open, so it can read ' +
            'labFeatures.js and friends) and interrogate it.',
        settings,
        loop: {
            ...vitals,
            diaryGames: (diary && diary[0] && diary[0].Count) || 0,
            gamesLast7Days: (recent && recent[0] && recent[0].Games) || 0,
            deepGamesLast7Days: (recent && recent[0] && recent[0].Deep) || 0
        },
        strengthCurve,
        personaLadder,
        teacher: { ...teacher, disagreements },
        model: champion
            ? {
                  version: champion.Version,
                  cardPriorsLoaded: !!priors,
                  // Every dense weight, most influential first - the model's
                  // strategy, stated in its own vocabulary.
                  stateAndActionWeights: Object.entries(champion.Model.weights || {})
                      .map(([key, weight]) => [key, round3(weight)])
                      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])),
                  cards: rankedCards(champion.Model, priors, nameOf, 30),
                  prompts: rankedPrompts(champion.Model, 10)
              }
            : { note: 'The heuristics still hold the title - no learned model yet.' }
    };
}

async function main() {
    const db = require('../db');
    const settingsService = require('../services/settings');
    const ConfigService = require('../services/ConfigService');
    const BotPolicyService = require('../services/championschallenge/BotPolicyService');
    const LlmTeacherService = require('../services/championschallenge/LlmTeacherService');

    // One snapshot, no refresh timer: a script reads and leaves.
    await settingsService.refresh();

    const configService = new ConfigService();
    const packet = await buildPacket({
        db,
        settingsService,
        policyService: new BotPolicyService(configService, db, settingsService),
        teacherService: new LlmTeacherService(configService, db, settingsService),
        cardIndex: getCardIndex()
    });

    console.log(JSON.stringify(packet, null, 2));
}

// Requiring this file (the spec does, for buildPacket) must not open a
// database connection or print anything.
if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('Could not build the advisor packet:', err);
            process.exit(1);
        });
}

module.exports = { buildPacket };
