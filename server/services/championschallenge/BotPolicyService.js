const logger = require('../../log');
const { emptyModel, trainModel } = require('./labPolicy');
const { sprt, wilsonInterval } = require('./labMath');
const { personaByKey, duelPairKey } = require('./labPersonas');

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

class BotPolicyService {
    constructor(configService, db = require('../../db'), settingsService = require('../settings')) {
        this.configService = configService;
        this.db = db;
        this.settingsService = settingsService;
        this.championCache = { model: null, at: 0 };
    }

    /** The reigning model, or null while the heuristics still hold the title. */
    async champion() {
        const now = Date.now();

        if (now - this.championCache.at < CHAMPION_CACHE_MS) {
            return this.championCache.model;
        }

        const rows = await this.db.query(
            'SELECT "Model" FROM "BotPolicies" WHERE "Status" = \'champion\' ' +
                'ORDER BY "Version" DESC LIMIT 1'
        );

        this.championCache = { model: rows && rows[0] ? rows[0].Model : null, at: now };

        return this.championCache.model;
    }

    /** The candidate in training, with its arena record, or null. */
    async candidate() {
        const rows = await this.db.query(
            'SELECT "Id", "Version", "Model", "ArenaWins", "ArenaLosses" ' +
                'FROM "BotPolicies" WHERE "Status" = \'candidate\' ' +
                'ORDER BY "Version" DESC LIMIT 1'
        );

        return rows && rows[0] ? rows[0] : null;
    }

    /**
     * One sparring game into the diary. Returns how many games the diary
     * holds, which is what the caller's "time to train?" check reads.
     */
    async recordTrainingGame({ policyVersion, winnerSide, decisions, persona = null }, keep) {
        await this.db.query(
            'INSERT INTO "BotTrainingGames" ' +
                '("PolicyVersion", "WinnerSide", "Decisions", "Persona", "CreatedAt") ' +
                "VALUES ($1, $2, $3, $4, now() AT TIME ZONE 'utc')",
            [policyVersion || null, winnerSide, JSON.stringify(decisions), persona]
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
            'SELECT "WinnerSide", "Decisions" FROM "BotTrainingGames" ' +
                'ORDER BY "Id" DESC LIMIT $1',
            [batchGames]
        );

        if (!rows || rows.length < 20) {
            return null; // not enough evidence to be worth a title fight
        }

        const games = rows.map((row) => ({
            winnerSide: row.WinnerSide,
            decisions: row.Decisions || []
        }));
        const base = (await this.champion()) || emptyModel();
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
            [version, JSON.stringify(trained), trained.trainedGames || games.length]
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

module.exports = BotPolicyService;
