const logger = require('../../log');
const { emptyModel, trainModel } = require('./labPolicy');
const { sprt, wilsonInterval } = require('./labMath');
const { personaByKey, duelPairKey } = require('./labPersonas');
const { withCardPriors, stripCardPriors } = require('./cardPriors');
const { MODES, humanLearningConfig } = require('./humanLearning');
const {
    HUMAN_OVERALL,
    HUMAN_PREFIX,
    bandFor,
    calibrationKeys,
    isHumanKey
} = require('./humanLadder');
const { sectionDefaults } = require('../settings/registry');
// ARCHON (N50): the band thresholds are the rating engine's, not a second
// opinion about where "strong" starts - see humanLadder.
const { DEFAULT_ELO_CONFIG } = require('../rating/eloDefaults');

/**
 * ARCHON (N21): the learning loop's bookkeeping - training diary, candidate
 * training, and the champion's title fight.
 *
 * The loop this service turns: sparring games log their decisions here;
 * every `trainEveryGames` logged games, the current champion's model is
 * folded over the fresh diary into a CANDIDATE; the candidate then plays
 * the champion in arena games on neutral decks; and it takes the title only
 * when a sequential probability ratio test says its record is evidence of
 * real improvement (N25 - it was a fixed-N Wilson bound before, which spent
 * the same few hundred games on every candidate however obvious the answer
 * was). A candidate the test rules against retires at once; one it cannot
 * separate from the champion retires when `arenaDecideGames` closes the
 * window. Records are kept either way. The bot can therefore get provably
 * stronger, and can never quietly get worse - the same conservatism the
 * hidden-gem badge applies to decks, applied to the bot's own brain.
 *
 * Arena games exist ONLY here: they are policy evaluation, one bot brain
 * against another with asymmetric strength, so they never touch
 * ProvingGroundsGames, never move ARI, and never colour anyone's deck
 * stats.
 *
 * Champion lookup is cached briefly - the sweep asks every tick, models
 * change at most every few hundred games.
 */

const CHAMPION_CACHE_MS = 60 * 1000;

/**
 * ARCHON (N50): the human record shares `ChallengeCalibration` and must stay
 * out of the fixed ladder's query.
 *
 * The ladder reads "the newest version anybody has calibrated", and human rows
 * are written at the champion version too - so the moment a champion is
 * promoted, one practice game finishing before the lab's next calibration
 * sweep would make MAX(PolicyVersion) point at a version holding nothing BUT
 * that game, and the whole ladder would vanish from the page until the sweep
 * caught up. Excluding them from both halves of the query is what stops a rung
 * that is a person from being able to empty the ladder it sits beside.
 */
const NOT_HUMAN_SQL = `("Opponent" <> '${HUMAN_OVERALL}' AND "Opponent" NOT LIKE '${HUMAN_PREFIX}%')`;

class BotPolicyService {
    constructor(configService, db = require('../../db'), settingsService = require('../settings')) {
        this.configService = configService;
        this.db = db;
        this.settingsService = settingsService;
        this.championCache = { model: null, at: 0 };
    }

    /**
     * The Challenge's settings, composed over the registry defaults the way
     * getSectionWithDefaults does - so a stubbed settings service in a spec,
     * or a database never written to, reads as the defaults rather than as an
     * error.
     */
    section() {
        try {
            return {
                ...sectionDefaults('championsChallenge'),
                ...((this.settingsService.getSection &&
                    this.settingsService.getSection('championsChallenge')) ||
                    {})
            };
        } catch (err) {
            logger.error('Challenge bot: could not read the Challenge settings', err);

            return sectionDefaults('championsChallenge');
        }
    }

    /**
     * ARCHON (N38): how strongly the card-text priors pull, from the admin
     * knob. Zero (or a broken read) means priors off.
     */
    priorWeight() {
        const weight = Number(this.section().cardPriorWeight);

        return Number.isFinite(weight) && weight > 0 ? weight : 0;
    }

    /**
     * How many games the diary holds before the oldest are pruned. Read here
     * for the writers that have no caller to pass it (a finished human game
     * arrives from the lobby's GAMEWIN handler, which has no business knowing
     * about diary pruning).
     */
    diaryCap() {
        const keep = Number(this.section().trainingGamesKept);

        return Number.isFinite(keep) && keep > 0
            ? keep
            : sectionDefaults('championsChallenge').trainingGamesKept;
    }

    /**
     * The reigning model, or null while the heuristics still hold the title.
     *
     * ARCHON (N38): priors attach HERE, at load - every consumer (sparring,
     * arena, personas, the practice bots) goes through this method or through
     * candidate(), so attaching at the two doors keeps play and training
     * scoring with the same brain. Stored rows never carry priors; the file
     * is the source of truth (see cardPriors.js).
     */
    async champion() {
        const now = Date.now();

        if (now - this.championCache.at < CHAMPION_CACHE_MS) {
            return this.championCache.model;
        }

        const rows = await this.db.query(
            'SELECT "Model" FROM "BotPolicies" WHERE "Status" = \'champion\' ' +
                'ORDER BY "Version" DESC LIMIT 1'
        );
        const model = rows && rows[0] ? rows[0].Model : null;

        this.championCache = { model: withCardPriors(model, this.priorWeight()), at: now };

        return this.championCache.model;
    }

    /** The candidate in training, with its arena record, or null. */
    async candidate() {
        const rows = await this.db.query(
            'SELECT "Id", "Version", "Model", "ArenaWins", "ArenaLosses" ' +
                'FROM "BotPolicies" WHERE "Status" = \'candidate\' ' +
                'ORDER BY "Version" DESC LIMIT 1'
        );
        const row = rows && rows[0] ? rows[0] : null;

        if (row) {
            // The same door as champion(): a candidate trained with priors
            // must also FIGHT with them, or the arena measures a brain nobody
            // will ever play.
            row.Model = withCardPriors(row.Model, this.priorWeight());
        }

        return row;
    }

    /**
     * One sparring game into the diary. Returns how many games the diary
     * holds, which is what the caller's "time to train?" check reads.
     */
    async recordTrainingGame(
        { policyVersion, winnerSide, decisions, persona = null, source = 'self' },
        keep
    ) {
        await this.db.query(
            'INSERT INTO "BotTrainingGames" ' +
                '("PolicyVersion", "WinnerSide", "Decisions", "Persona", "Source", "CreatedAt") ' +
                "VALUES ($1, $2, $3, $4, $5, now() AT TIME ZONE 'utc')",
            [policyVersion || null, winnerSide, JSON.stringify(decisions), persona, source]
        );

        // Prune beyond the working set, oldest first. A diary is not an
        // archive; the model IS the memory.
        if (keep > 0) {
            await this.db.query(
                'DELETE FROM "BotTrainingGames" WHERE "Id" IN (' +
                    'SELECT "Id" FROM "BotTrainingGames" ORDER BY "Id" DESC OFFSET $1)',
                [keep]
            );
        }

        const counted = await this.db.query(
            'SELECT COUNT(*)::int AS "Count" FROM "BotTrainingGames"'
        );

        return counted && counted[0] ? counted[0].Count : 0;
    }

    /**
     * ARCHON (N48): one finished HUMAN game into the same diary.
     *
     * The rows were captured live at the game node
     * (server/gamenode/humancapture.js) through the same `decisionRecord` the
     * bot's own driver calls, so they are the same shape as every other row
     * here and the trainer needs no special case for them beyond the pull.
     *
     * Two guards, and both matter:
     *
     *  - The MODE is re-checked here, not only where the table was stamped. A
     *    game can run for half an hour; an admin who switches capture off
     *    during one has said no, and the row that arrives afterwards should
     *    not land anyway.
     *  - The rows carry no weight. The pull is applied when the batch is
     *    folded (trainCandidate), from the knob as it reads THEN - so an
     *    operator who decides human play is pulling too hard can change it and
     *    have the whole diary re-read, rather than only its future.
     *
     * @param {{winnerSide: string, decisions: object[]}} game
     * @returns {Promise<number>} the diary's size, or 0 if nothing was filed
     */
    async recordHumanGame({ winnerSide, decisions } = {}) {
        if (!winnerSide || !Array.isArray(decisions) || !decisions.length) {
            return 0;
        }

        if (humanLearningConfig(this.settingsService).mode === MODES.OFF) {
            return 0;
        }

        const size = await this.recordTrainingGame(
            { winnerSide, decisions, source: 'human' },
            this.diaryCap()
        );

        logger.info(
            `Challenge bot: learned from a human game - ${decisions.length} decisions, ` +
                `diary now ${size}`
        );

        return size;
    }

    /**
     * Fold the recent diary over the champion into a new candidate. One
     * candidate at a time: while a title fight is on, fresh games keep
     * accumulating for the NEXT candidate instead.
     *
     * @returns {Promise<object|null>} the new candidate row, or null
     */
    async trainCandidate({ batchGames = 200, lambda, targetWeight } = {}) {
        if (await this.candidate()) {
            return null;
        }

        const rows = await this.db.query(
            'SELECT "WinnerSide", "Decisions", "Source" FROM "BotTrainingGames" ' +
                'ORDER BY "Id" DESC LIMIT $1',
            [batchGames]
        );

        if (!rows || rows.length < 20) {
            return null; // not enough evidence to be worth a title fight
        }

        // ARCHON (N48): a human's move pulls harder than a sparring one.
        //
        // Applied HERE rather than at capture time, and that is the point of
        // storing the source instead of the weight: the knob then governs the
        // whole diary rather than only the rows written after it was last
        // changed. `trainModel` already honours a per-row `weight` - the LLM
        // teacher's rows use the same door - so nothing downstream changes.
        const humanWeight = humanLearningConfig(this.settingsService).weight;
        const games = rows.map((row) => ({
            winnerSide: row.WinnerSide,
            decisions: weighDecisions(row.Decisions || [], row.Source, humanWeight)
        }));
        // champion() arrives with priors attached; the very first candidate
        // (no champion yet) gets them attached to the blank slate, so version
        // one already knows what the cards say.
        const base = (await this.champion()) || withCardPriors(emptyModel(), this.priorWeight());
        // lambda: how far a label leans on the value of what came next rather
        // than on the final result alone (labPolicy.decisionTarget).
        // targetWeight: how much harder a decision the deep bot MEASURED
        // pulls than one merely labelled by who won.
        const options = {};

        if (lambda !== undefined) {
            options.lambda = lambda;
        }

        if (targetWeight !== undefined) {
            options.targetWeight = targetWeight;
        }

        const trained = trainModel(base, games, options);

        const versions = await this.db.query(
            'SELECT COALESCE(MAX("Version"), 0)::int AS "Version" FROM "BotPolicies"'
        );
        const version = ((versions && versions[0] && versions[0].Version) || 0) + 1;

        trained.version = version;

        const inserted = await this.db.query(
            'INSERT INTO "BotPolicies" ("Version", "Status", "Model", "TrainedGames", "CreatedAt") ' +
                "VALUES ($1, 'candidate', $2, $3, now() AT TIME ZONE 'utc') RETURNING \"Id\"",
            // Stored WITHOUT priors: the file is the source of truth, and a
            // copy in the row would go stale while looking authoritative.
            // candidate()/champion() re-attach at every load.
            [
                version,
                JSON.stringify(stripCardPriors(trained)),
                trained.trainedGames || games.length
            ]
        );

        logger.info(`Challenge bot: trained candidate v${version} on ${games.length} games`);

        return {
            Id: inserted[0].Id,
            Version: version,
            Model: trained,
            ArenaWins: 0,
            ArenaLosses: 0
        };
    }

    /**
     * Score one arena game and settle the title if the record now decides it.
     *
     * `minGames` is a FLOOR, not a sample size: the sequential test does the
     * deciding, and the floor exists only so a streak of ten cannot crown a
     * candidate. That is why it is far smaller than the fixed-N window this
     * replaced - a test that stops early and a large minimum are the same thing
     * as a test that never stops early.
     *
     * @returns {Promise<'promoted'|'retired'|'fighting'>}
     */
    async recordArenaResult(candidateId, candidateWon, { minGames = 30, decideGames = 400 } = {}) {
        const rows = await this.db.query(
            'UPDATE "BotPolicies" SET ' +
                (candidateWon
                    ? '"ArenaWins" = "ArenaWins" + 1 '
                    : '"ArenaLosses" = "ArenaLosses" + 1 ') +
                'WHERE "Id" = $1 RETURNING "Version", "ArenaWins", "ArenaLosses"',
            [candidateId]
        );
        const row = rows && rows[0];

        if (!row) {
            return 'fighting';
        }

        const games = row.ArenaWins + row.ArenaLosses;
        // ARCHON (N25): the sequential test decides, with a floor under it.
        //
        // Fixed-N Wilson spent the same few hundred games on every candidate,
        // however obvious the answer was. SPRT stops as soon as the evidence
        // crosses a bound in either direction, so a plainly stronger bot is
        // crowned in tens of games and a plainly worse one retires in tens -
        // which, since arena games are pure overhead, is the difference between
        // the bot improving weekly and improving hourly. `minGames` keeps a
        // small-sample fluke from taking the title on the strength of a streak.
        const evidence = sprt(row.ArenaWins, row.ArenaLosses);

        if (games >= minGames && evidence.verdict === 'better') {
            await this.db.query(
                'UPDATE "BotPolicies" SET "Status" = \'retired\' WHERE "Status" = \'champion\''
            );
            await this.db.query(
                'UPDATE "BotPolicies" SET "Status" = \'champion\', ' +
                    '"PromotedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
                [candidateId]
            );
            this.championCache = { model: null, at: 0 };
            logger.info(
                `Challenge bot: candidate v${row.Version} PROMOTED to champion ` +
                    `(${row.ArenaWins}-${row.ArenaLosses}, llr ${evidence.llr.toFixed(2)})`
            );

            return 'promoted';
        }

        // Retire on proof of no improvement, or when the window closes on a
        // candidate the test could not separate from the champion either way.
        if ((games >= minGames && evidence.verdict === 'no-better') || games >= decideGames) {
            await this.db.query('UPDATE "BotPolicies" SET "Status" = \'retired\' WHERE "Id" = $1', [
                candidateId
            ]);
            logger.info(
                `Challenge bot: candidate v${row.Version} retired ` +
                    `(${row.ArenaWins}-${row.ArenaLosses}, llr ${evidence.llr.toFixed(2)}) - ` +
                    (evidence.verdict === 'no-better'
                        ? 'no better than the champion'
                        : 'unproven inside the window')
            );

            return 'retired';
        }

        return 'fighting';
    }

    /**
     * ARCHON (N26): the champion's line of succession.
     *
     * Every version that ever held or contested the title, with the record it
     * held it on. This is the one thing that makes "the bot is learning" a claim
     * a member can check rather than a promise on a page: each promotion had to
     * clear the sequential test against the champion before it, so the list IS
     * the improvement, in order.
     *
     * Never throws - a page must not fail because a history query did.
     */
    async strengthCurve(limit = 20) {
        try {
            const rows = await this.db.query(
                'SELECT "Version", "Status", "TrainedGames", "ArenaWins", "ArenaLosses", ' +
                    '"CreatedAt", "PromotedAt" FROM "BotPolicies" ' +
                    'ORDER BY "Version" DESC LIMIT $1',
                [Math.max(1, Math.min(100, limit))]
            );

            return (rows || [])
                .map((row) => ({
                    version: row.Version,
                    status: row.Status,
                    trainedGames: row.TrainedGames,
                    arenaWins: row.ArenaWins,
                    arenaLosses: row.ArenaLosses,
                    createdAt: row.CreatedAt,
                    promotedAt: row.PromotedAt
                }))
                .reverse();
        } catch (err) {
            logger.error('Challenge bot: could not read the strength curve', err);

            return [];
        }
    }

    /**
     * ARCHON (N28): record one persona duel, and read the ladder back.
     *
     * The duels exist to answer a question ordinary sparring cannot: is one of
     * the three pilots simply the worse player? Sparring shares one pilot across
     * both seats on purpose - that is what keeps a game's result attributable to
     * the decks - so a persona's strength never appears in it. Here two personas
     * meet on neutral decks with paired seeds, which is the same instrument the
     * champion's title fight uses.
     *
     * One row per unordered pair, keys sorted, so the record cannot end up split
     * between "racer vs bruiser" and "bruiser vs racer".
     *
     * Best effort: a calibration write must never cost a sweep.
     */
    async recordPersonaDuel(winner, loser) {
        if (!winner || !loser || winner === loser) {
            return false;
        }

        const [a, b] = duelPairKey(winner, loser);
        const winnerIsA = winner === a;

        try {
            await this.db.query(
                'INSERT INTO "ChallengePersonaDuels" ' +
                    '("PersonaA", "PersonaB", "WinsA", "WinsB", "UpdatedAt") ' +
                    "VALUES ($1, $2, $3, $4, now() AT TIME ZONE 'utc') " +
                    'ON CONFLICT ("PersonaA", "PersonaB") DO UPDATE SET ' +
                    '"WinsA" = "ChallengePersonaDuels"."WinsA" + EXCLUDED."WinsA", ' +
                    '"WinsB" = "ChallengePersonaDuels"."WinsB" + EXCLUDED."WinsB", ' +
                    '"UpdatedAt" = EXCLUDED."UpdatedAt"',
                [a, b, winnerIsA ? 1 : 0, winnerIsA ? 0 : 1]
            );

            return true;
        } catch (err) {
            logger.error('Challenge bot: could not record a persona duel', err);

            return false;
        }
    }

    /**
     * Each persona's record across every pair it has played, with the interval -
     * because "the Schemer wins 42%" over twelve games is not a finding.
     *
     * Never throws; an empty ladder is what "they have not duelled yet" looks
     * like.
     */
    async personaLadder() {
        let rows;

        try {
            rows = await this.db.query(
                'SELECT "PersonaA", "PersonaB", "WinsA", "WinsB" FROM "ChallengePersonaDuels"'
            );
        } catch (err) {
            logger.error('Challenge bot: could not read the persona ladder', err);

            return [];
        }

        const records = new Map();
        const note = (key, wins, losses) => {
            const record = records.get(key) || { persona: key, wins: 0, losses: 0 };

            record.wins += wins;
            record.losses += losses;
            records.set(key, record);
        };

        for (const row of rows || []) {
            note(row.PersonaA, row.WinsA || 0, row.WinsB || 0);
            note(row.PersonaB, row.WinsB || 0, row.WinsA || 0);
        }

        return [...records.values()]
            .map((record) => {
                const games = record.wins + record.losses;
                const persona = personaByKey(record.persona);

                return {
                    ...record,
                    label: persona ? persona.label : record.persona,
                    games,
                    ...wilsonInterval(record.wins, games)
                };
            })
            .sort((left, right) => right.rate - left.rate || right.games - left.games);
    }

    // -------------------------------------------------- the calibration ladder

    /**
     * ARCHON (N39): record one calibrated result for the current champion.
     *
     * Kept per champion version rather than as a running total. A ladder that
     * pooled every model the loop has ever promoted would smear a regression
     * across the record of the model that caused it - which is exactly the
     * moment somebody needs to see it.
     */
    async recordCalibration(opponent, policyVersion, championWon) {
        if (!opponent) {
            return false;
        }

        try {
            await this.db.query(
                'INSERT INTO "ChallengeCalibration" ' +
                    '("Opponent", "PolicyVersion", "Wins", "Losses", "UpdatedAt") ' +
                    "VALUES ($1, $2, $3, $4, now() AT TIME ZONE 'utc') " +
                    'ON CONFLICT ("Opponent", "PolicyVersion") DO UPDATE SET ' +
                    '"Wins" = "ChallengeCalibration"."Wins" + EXCLUDED."Wins", ' +
                    '"Losses" = "ChallengeCalibration"."Losses" + EXCLUDED."Losses", ' +
                    '"UpdatedAt" = EXCLUDED."UpdatedAt"',
                [opponent, policyVersion || 0, championWon ? 1 : 0, championWon ? 0 : 1]
            );

            return true;
        } catch (err) {
            logger.error('Challenge bot: could not record a calibration game', err);

            return false;
        }
    }

    /**
     * What the champion can beat, and by how much.
     *
     * One row per reference opponent for the version asked about - the current
     * champion unless a caller wants history. Intervals throughout, because
     * "beats the heuristic bot 78%" over nine games is a sentence nobody should
     * read without its error bars.
     *
     * Never throws; an empty ladder means the calibration has not run yet,
     * which is a normal state on a young install and says so on the page.
     */
    async calibration(policyVersion = null) {
        let rows;

        try {
            rows = await this.db.query(
                policyVersion === null
                    ? 'SELECT "Opponent", "PolicyVersion", "Wins", "Losses" ' +
                          `FROM "ChallengeCalibration" WHERE ${NOT_HUMAN_SQL} ` +
                          'AND "PolicyVersion" = (SELECT MAX("PolicyVersion") ' +
                          `FROM "ChallengeCalibration" WHERE ${NOT_HUMAN_SQL})`
                    : 'SELECT "Opponent", "PolicyVersion", "Wins", "Losses" ' +
                          `FROM "ChallengeCalibration" WHERE ${NOT_HUMAN_SQL} ` +
                          'AND "PolicyVersion" = $1',
                policyVersion === null ? [] : [policyVersion]
            );
        } catch (err) {
            logger.error('Challenge bot: could not read the calibration ladder', err);

            return [];
        }

        return (rows || [])
            .map((row) => {
                const wins = row.Wins || 0;
                const losses = row.Losses || 0;
                const games = wins + losses;

                return {
                    opponent: row.Opponent,
                    policyVersion: row.PolicyVersion,
                    wins,
                    losses,
                    games,
                    ...wilsonInterval(wins, games)
                };
            })
            .sort((left, right) => right.rate - left.rate || right.games - left.games);
    }

    /**
     * ARCHON (N50): one finished practice game, filed against the champion.
     *
     * Called from the lobby's GAMEWIN handler, which is the one place where
     * "this was a bot table", "this is who won" and "this is the model the bot
     * was playing" are all known at once.
     *
     * Best effort from end to end. A practice game that has finished already
     * gave the player what it owed them; a ladder row is bookkeeping, and
     * bookkeeping never gets to throw into the path that saves somebody's
     * replay.
     *
     * @param {object} params
     * @param {string} params.username the human seat
     * @param {boolean} params.botWon
     * @param {number} params.policyVersion the model the bot actually played
     * @returns {Promise<boolean>} whether anything was written
     */
    async recordHumanLadderGame({ username, botWon, policyVersion } = {}) {
        if (!username) {
            return false;
        }

        const band = bandFor(await this.humanStanding(username), this.eloThresholds());
        const results = await Promise.all(
            calibrationKeys(band).map((key) =>
                this.recordCalibration(key, policyVersion || 0, !!botWon)
            )
        );

        return results.some(Boolean);
    }

    /**
     * A player's standing, for banding only.
     *
     * Deliberately NOT `RatingService.getRatingsForUsername`: that one computes
     * worldwide rank and win/loss history through four correlated subqueries,
     * and - the part that would actually be wrong here - it drops players below
     * `leaderboardMinGames`, who are exactly the people this record most needs
     * to count. A band needs two numbers.
     *
     * The archon pool, because that is the format practice tables are played
     * in. A player rated only in sealed reads as provisional, which is the
     * honest answer to "how strong are they at this".
     *
     * @param {string} username
     * @returns {Promise<{rating: number, gamesPlayed: number}|null>}
     */
    async humanStanding(username) {
        try {
            const rows = await this.db.query(
                'SELECT r."Rating", r."GamesPlayed" FROM "Ratings" r ' +
                    'JOIN "Users" u ON u."Id" = r."UserId" ' +
                    'WHERE lower(u."Username") = lower($1) AND r."Pool" = $2',
                [username, 'archon']
            );

            if (!rows || !rows.length) {
                return null;
            }

            return { rating: Number(rows[0].Rating), gamesPlayed: Number(rows[0].GamesPlayed) };
        } catch (err) {
            logger.error('Challenge bot: could not read a standing for the human ladder', err);

            return null;
        }
    }

    /**
     * The rating engine's own band thresholds.
     *
     * Read from the same settings section the engine reads, so "established"
     * here and "established" there can never drift apart - and defaulted from
     * the shipped Elo config rather than from numbers written twice.
     */
    eloThresholds() {
        let elo = {};

        try {
            elo = (this.settingsService.getSection('rating') || {}).elo || {};
        } catch (err) {
            // A settings read that fails must never stop a game being counted;
            // the shipped defaults below are the same ones the engine runs on.
        }

        return {
            provisionalGames: Number(elo.provisionalGames ?? DEFAULT_ELO_CONFIG.provisionalGames),
            highRatingThreshold: Number(
                elo.highRatingThreshold ?? DEFAULT_ELO_CONFIG.highRatingThreshold
            )
        };
    }

    /**
     * ARCHON (N50): what the bot has done against people, over its lifetime.
     *
     * Read ACROSS champion versions, where the fixed ladder is read within
     * one. The ladder can afford per-version because the lab plays it every
     * sweep and a version accumulates hundreds of games; this record grows
     * only when somebody sits down to play, so per-version it would read "0
     * games so far" for most of every champion's reign, and a panel that says
     * nothing is one nobody looks at twice.
     *
     * The rows are still WRITTEN per version, so the day this is worth
     * splitting by champion, the history is already there to split.
     *
     * Never throws; an empty record means nobody has finished a practice game
     * yet, which is a normal state and says so on the page.
     *
     * @returns {Promise<{overall: object|null, bands: object[]}>}
     */
    async humanLadder() {
        let rows;

        try {
            rows = await this.db.query(
                'SELECT "Opponent", SUM("Wins")::int AS "Wins", SUM("Losses")::int AS "Losses" ' +
                    'FROM "ChallengeCalibration" ' +
                    'WHERE "Opponent" = $1 OR "Opponent" LIKE $2 ' +
                    'GROUP BY "Opponent"',
                [HUMAN_OVERALL, `${HUMAN_PREFIX}%`]
            );
        } catch (err) {
            logger.error('Challenge bot: could not read the human record', err);

            return { overall: null, bands: [] };
        }

        const measured = (row) => {
            const wins = row.Wins || 0;
            const losses = row.Losses || 0;
            const games = wins + losses;

            return { wins, losses, games, ...wilsonInterval(wins, games) };
        };
        const overallRow = (rows || []).find((row) => row.Opponent === HUMAN_OVERALL);

        return {
            overall: overallRow ? measured(overallRow) : null,
            bands: (rows || [])
                .filter((row) => isHumanKey(row.Opponent) && row.Opponent !== HUMAN_OVERALL)
                .map((row) => ({
                    band: row.Opponent.slice(HUMAN_PREFIX.length),
                    ...measured(row)
                }))
        };
    }

    /** The learning loop's public vitals, for the Challenge page. */
    async vitals() {
        const rows = await this.db.query(
            'SELECT "Version", "Status", "TrainedGames", "ArenaWins", "ArenaLosses", "PromotedAt" ' +
                'FROM "BotPolicies" WHERE "Status" IN (\'champion\', \'candidate\') ' +
                'ORDER BY "Version" DESC'
        );
        const champion = (rows || []).find((row) => row.Status === 'champion') || null;
        const candidate = (rows || []).find((row) => row.Status === 'candidate') || null;

        return {
            championVersion: champion ? champion.Version : 0,
            championTrainedGames: champion ? champion.TrainedGames : 0,
            candidate: candidate
                ? {
                      version: candidate.Version,
                      arenaWins: candidate.ArenaWins,
                      arenaLosses: candidate.ArenaLosses
                  }
                : null
        };
    }
}

/**
 * ARCHON (N48): stamp the pull a stored row's SOURCE earns it.
 *
 * A row that already carries its own weight keeps it - that is the LLM
 * teacher's rows, whose pull is set from how well that teacher has been
 * agreeing with the deep bot, and is evidence about the row rather than about
 * where it came from.
 */
function weighDecisions(decisions, source, weight) {
    if (source !== 'human' || !Array.isArray(decisions)) {
        return decisions;
    }

    return decisions.map((decision) =>
        decision && typeof decision.weight === 'number' ? decision : { ...decision, weight }
    );
}

module.exports = BotPolicyService;
// Exported for its own spec: this is where "a human row pulls harder" is
// actually decided, and it is worth pinning without a database in the way.
module.exports.weighDecisions = weighDecisions;
