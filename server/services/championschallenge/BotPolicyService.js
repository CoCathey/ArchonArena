const logger = require('../../log');
const { emptyModel, trainModel } = require('./labPolicy');
const { wilsonLowerBound } = require('./labMath');

/**
 * ARCHON (N21): the learning loop's bookkeeping - training diary, candidate
 * training, and the champion's title fight.
 *
 * The loop this service turns: sparring games log their decisions here;
 * every `trainEveryGames` logged games, the current champion's model is
 * folded over the fresh diary into a CANDIDATE; the candidate then plays
 * the champion in arena games on neutral decks; and only when its record is
 * good enough that the 95% Wilson lower bound clears 50% does it take the
 * title. A candidate that cannot prove itself inside `arenaDecideGames`
 * retires with its record kept. The bot can therefore get provably
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
    async recordTrainingGame({ policyVersion, winnerSide, decisions }, keep) {
        await this.db.query(
            'INSERT INTO "BotTrainingGames" ("PolicyVersion", "WinnerSide", "Decisions", "CreatedAt") ' +
                "VALUES ($1, $2, $3, now() AT TIME ZONE 'utc')",
            [policyVersion || null, winnerSide, JSON.stringify(decisions)]
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
    async trainCandidate({ batchGames = 200 } = {}) {
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
        const trained = trainModel(base, games);

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
     * Score one arena game and settle the title if the record now decides
     * it. Promotion demands proof (Wilson lower bound above 50%); failure to
     * prove within the window retires the candidate.
     *
     * @returns {Promise<'promoted'|'retired'|'fighting'>}
     */
    async recordArenaResult(candidateId, candidateWon, { minGames = 150, decideGames = 400 } = {}) {
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

        if (games >= minGames && wilsonLowerBound(row.ArenaWins, games) > 0.5) {
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
                    `(${row.ArenaWins}-${row.ArenaLosses})`
            );

            return 'promoted';
        }

        if (games >= decideGames) {
            await this.db.query('UPDATE "BotPolicies" SET "Status" = \'retired\' WHERE "Id" = $1', [
                candidateId
            ]);
            logger.info(
                `Challenge bot: candidate v${row.Version} retired ` +
                    `(${row.ArenaWins}-${row.ArenaLosses}) - the champion holds`
            );

            return 'retired';
        }

        return 'fighting';
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
