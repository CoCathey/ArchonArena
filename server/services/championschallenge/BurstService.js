const logger = require('../../log');

/**
 * ARCHON (N40): the queue behind "run it now".
 *
 * The Champion's Challenge answers in days. Twelve games a deck a day against a
 * twenty-game confidence threshold means two days before the page will commit
 * to a verdict about one deck, and eight decks share the sweep. A member enrols,
 * reads "still proving", and has to remember to come back.
 *
 * A burst is the same games, asked for rather than waited for. This service
 * owns the asking: who may, how often, what is queued, and what a member is
 * shown while it runs. The PLAYING lives in ChampionsChallengeService with
 * every other kind of game, because a burst game is not a new kind of game.
 *
 * Three decisions worth naming.
 *
 * IT IS A QUEUE. Simulated games are CPU and the lobby serves live tables on
 * the same event loop; thirty games inside an HTTP handler would freeze every
 * game on the site for half a minute. The request writes a row and returns, and
 * the process holding the sweep lease - already the one designated to spend CPU
 * on simulation - drains it. That also means a burst cannot double-run when two
 * nodes are up, for free, using a mechanism that already exists.
 *
 * IT HAS ITS OWN ALLOWANCE, not the trickle's. The per-deck daily cap exists to
 * spread a shared background budget fairly across members who did not ask for
 * anything. A burst is explicitly requested and separately bounded, so making
 * it eat the same cap would mean asking for an answer cost you the answers you
 * would have got anyway.
 *
 * PROGRESS IS PERSISTED, not held in memory. The member's page is polling, the
 * sweeper may be a different process entirely, and a burst that survives a
 * deploy mid-run is worth more than one that vanishes.
 */

/** What a burst can be played against. */
const OPPOSITIONS = [
    {
        key: 'roster',
        label: 'My other decks',
        note: 'the mirror lab: this deck against the rest of your roster'
    },
    { key: 'field', label: 'The field', note: 'random registered decks from the Gauntlet pool' },
    { key: 'vaulttour', label: 'The Vault Tour', note: 'decks that won real events' }
];

const OPPOSITION_KEYS = OPPOSITIONS.map((entry) => entry.key);

/** A run left 'running' this long was orphaned by a restart, not still going. */
const STUCK_MINUTES = 15;

class BurstService {
    constructor(configService, db = require('../../db'), settingsService = require('../settings')) {
        this.configService = configService;
        this.db = db;
        this.settingsService = settingsService;
    }

    getConfig() {
        return this.settingsService.getSectionWithDefaults('championsChallenge');
    }

    isEnabled() {
        return this.getConfig().burstEnabled !== false;
    }

    /** Games one burst plays, bounded by what an operator allows. */
    gamesPerRun() {
        const games = parseInt(this.getConfig().burstGames, 10);

        return Math.max(1, Math.min(200, Number.isFinite(games) ? games : 30));
    }

    /** Bursts a member may start in a UTC day. Admins are exempt. */
    runsPerDay() {
        const runs = parseInt(this.getConfig().burstRunsPerDay, 10);

        return Math.max(0, Number.isFinite(runs) ? runs : 2);
    }

    /**
     * How many runs this member has started today, and how many are left.
     *
     * Counted from CreatedAt rather than FinishedAt: a member who queues three
     * bursts has spent three, whatever became of them. The alternative rewards
     * cancelling.
     */
    async budgetFor(userId, { isAdmin = false } = {}) {
        const perDay = this.runsPerDay();

        if (isAdmin) {
            return { used: 0, perDay, remaining: Infinity, unlimited: true };
        }

        let used = 0;

        try {
            const rows = await this.db.query(
                'SELECT COUNT(*)::int AS "Started" FROM "ChallengeBurstRuns" ' +
                    'WHERE "UserId" = $1 AND "CreatedAt" >= ' +
                    "date_trunc('day', now() AT TIME ZONE 'utc')",
                [userId]
            );

            used = (rows && rows[0] && rows[0].Started) || 0;
        } catch (err) {
            logger.error('Burst: could not read today’s budget', err);

            // Refuse rather than over-spend: an unreadable budget is not an
            // unlimited one, and the cost of being wrong here is CPU.
            return { used: perDay, perDay, remaining: 0, unlimited: false };
        }

        return { used, perDay, remaining: Math.max(0, perDay - used), unlimited: false };
    }

    /**
     * Queue a burst.
     *
     * @returns {Promise<{run: object}|{error: string}>}
     */
    async enqueue(userId, { deckId, opposition, isAdmin = false }) {
        if (!this.isEnabled()) {
            return { error: 'Running a batch on demand is switched off on this site.' };
        }

        if (!OPPOSITION_KEYS.includes(opposition)) {
            return { error: 'Pick something for the deck to play against.' };
        }

        const deck = parseInt(deckId, 10);

        if (!Number.isFinite(deck)) {
            return { error: 'Pick a deck.' };
        }

        // Ownership, here rather than trusted from the client: this queues work
        // that plays somebody's deck and writes results under their name.
        try {
            const rows = await this.db.query(
                'SELECT "Id" FROM "Decks" WHERE "Id" = $1 AND "UserId" = $2',
                [deck, userId]
            );

            if (!rows || !rows.length) {
                return { error: 'That deck is not yours.' };
            }
        } catch (err) {
            logger.error('Burst: could not check deck ownership', err);

            return { error: 'That deck could not be checked just now.' };
        }

        const budget = await this.budgetFor(userId, { isAdmin });

        if (!budget.unlimited && budget.remaining <= 0) {
            return {
                error: `That is today’s ${budget.perDay} runs used. The background sweep keeps going.`
            };
        }

        // One at a time per member. A second run while the first is going does
        // not make anything faster - the sweeper plays them in sequence - and
        // it spends a day's allowance on a queue nobody asked to form.
        const active = await this.activeFor(userId);

        if (active) {
            return { error: 'A run is already going. It will finish shortly.' };
        }

        try {
            const rows = await this.db.query(
                'INSERT INTO "ChallengeBurstRuns" ' +
                    '("UserId", "DeckId", "Opposition", "Requested", "CreatedAt") ' +
                    "VALUES ($1, $2, $3, $4, now() AT TIME ZONE 'utc') RETURNING *",
                [userId, deck, opposition, this.gamesPerRun()]
            );

            return { run: this.mapRun(rows && rows[0]) };
        } catch (err) {
            logger.error('Burst: could not queue a run', err);

            return { error: 'That run could not be queued.' };
        }
    }

    /** This member's run that has not finished, if any. */
    async activeFor(userId) {
        try {
            const rows = await this.db.query(
                'SELECT * FROM "ChallengeBurstRuns" WHERE "UserId" = $1 ' +
                    'AND "Status" IN (\'queued\', \'running\') ORDER BY "CreatedAt" LIMIT 1',
                [userId]
            );

            return rows && rows[0] ? this.mapRun(rows[0]) : null;
        } catch (err) {
            logger.error('Burst: could not read the active run', err);

            return null;
        }
    }

    /** The member's latest run, running or finished, for the page. */
    async latestFor(userId) {
        try {
            const rows = await this.db.query(
                'SELECT * FROM "ChallengeBurstRuns" WHERE "UserId" = $1 ' +
                    'ORDER BY "CreatedAt" DESC LIMIT 1',
                [userId]
            );

            return rows && rows[0] ? this.mapRun(rows[0]) : null;
        } catch (err) {
            logger.error('Burst: could not read the latest run', err);

            return null;
        }
    }

    /**
     * Take the oldest queued run and mark it running, in one statement.
     *
     * The same shape as the sweep lease and for the same reason: a read then a
     * write leaves a window for a second process to claim the same run, and a
     * doubled burst is a member's allowance spent twice on one answer.
     */
    async claimNext() {
        try {
            const rows = await this.db.query(
                'UPDATE "ChallengeBurstRuns" SET "Status" = \'running\', ' +
                    '"StartedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = (' +
                    'SELECT "Id" FROM "ChallengeBurstRuns" WHERE "Status" = \'queued\' ' +
                    'ORDER BY "CreatedAt" LIMIT 1 FOR UPDATE SKIP LOCKED' +
                    ') RETURNING *'
            );

            return rows && rows[0] ? this.mapRun(rows[0]) : null;
        } catch (err) {
            logger.error('Burst: could not claim a run', err);

            return null;
        }
    }

    /** Record one finished game against a run. */
    async noteGame(runId, { won = false, abandoned = false } = {}) {
        try {
            await this.db.query(
                'UPDATE "ChallengeBurstRuns" SET ' +
                    '"Played" = "Played" + $2, "Wins" = "Wins" + $3, ' +
                    '"Losses" = "Losses" + $4, "Abandoned" = "Abandoned" + $5 ' +
                    'WHERE "Id" = $1',
                [
                    runId,
                    abandoned ? 0 : 1,
                    !abandoned && won ? 1 : 0,
                    !abandoned && !won ? 1 : 0,
                    abandoned ? 1 : 0
                ]
            );

            return true;
        } catch (err) {
            logger.error('Burst: could not record a game', err);

            return false;
        }
    }

    /** Close a run out. */
    async finish(runId, { status = 'done', note = null } = {}) {
        try {
            await this.db.query(
                'UPDATE "ChallengeBurstRuns" SET "Status" = $2, "Note" = $3, ' +
                    '"FinishedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
                [runId, status, note]
            );

            return true;
        } catch (err) {
            logger.error('Burst: could not finish a run', err);

            return false;
        }
    }

    /**
     * Fail runs a restart left mid-flight.
     *
     * A process that dies holding a claimed run leaves it 'running' forever,
     * and the member's page would poll a progress bar that never moves while
     * their one-at-a-time rule blocks them from asking again. Reclaiming after
     * a generous window costs nothing: the games already played are already
     * recorded in their own tables.
     */
    async releaseStuck() {
        try {
            const rows = await this.db.query(
                'UPDATE "ChallengeBurstRuns" SET "Status" = \'failed\', ' +
                    '"Note" = \'The run was interrupted. The games it finished still count.\', ' +
                    '"FinishedAt" = now() AT TIME ZONE \'utc\' ' +
                    'WHERE "Status" = \'running\' AND "StartedAt" < ' +
                    "now() AT TIME ZONE 'utc' - ($1 || ' minutes')::interval RETURNING \"Id\"",
                [STUCK_MINUTES]
            );

            return (rows || []).length;
        } catch (err) {
            logger.error('Burst: could not release stuck runs', err);

            return 0;
        }
    }

    mapRun(row) {
        if (!row) {
            return null;
        }

        const played = row.Played || 0;

        return {
            id: row.Id,
            userId: row.UserId,
            deckId: row.DeckId,
            opposition: row.Opposition,
            requested: row.Requested,
            played,
            wins: row.Wins || 0,
            losses: row.Losses || 0,
            abandoned: row.Abandoned || 0,
            status: row.Status,
            note: row.Note,
            // What the progress bar reads. Against `requested`, not against
            // played-plus-abandoned: a member asked for thirty games and the
            // bar should reach the end when the lab stops, however it got there.
            progress: row.Requested ? Math.min(1, played / row.Requested) : 0,
            winRate: played ? (row.Wins || 0) / played : null,
            createdAt: row.CreatedAt,
            startedAt: row.StartedAt,
            finishedAt: row.FinishedAt
        };
    }
}

module.exports = BurstService;
module.exports.OPPOSITIONS = OPPOSITIONS;
module.exports.OPPOSITION_KEYS = OPPOSITION_KEYS;
module.exports.STUCK_MINUTES = STUCK_MINUTES;
