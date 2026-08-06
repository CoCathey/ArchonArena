const logger = require('../../log');

/**
 * The persisted state of a bulk collection import (docs/design/dok-import.md).
 *
 * Importing a collection used to be a loop in the browser: the server listed
 * the player's decks from Decks of KeyForge and handed back uuids, and the
 * client posted them back one at a time. Master Vault meters that hard, so a
 * 257-deck collection takes minutes - and closing the modal, following a link
 * or losing a tab killed the import wherever it had got to, with no way to
 * resume and no record of what had already landed.
 *
 * So the loop moves here, as a row:
 *  - A job holds nothing but uuids. Listing the collection needs the player's
 *    DoK key, but importing a deck does not - each deck comes from Master
 *    Vault, which knows nothing about DoK. That is what makes the key
 *    disposable: it is used during the synchronous prepare step and never
 *    written anywhere, and the job that outlives the request cannot leak a
 *    credential it was never given.
 *  - Progress is absolute, not incremental, and is written after every batch.
 *    A lobby restart mid-import therefore costs at most the batch in flight,
 *    and the decks already imported stay imported.
 *  - One live job per user, enforced by a partial unique index in the schema.
 *    Two jobs for the same collection would double this player's share of a
 *    rate limit that every other importing player is also queueing behind.
 *
 * Every method is best effort: this is background work behind a status poll,
 * so a failed query degrades to "no job" / "nothing claimed" and is logged. It
 * must never throw into a lobby tick or an API handler.
 *
 * The db adapter is injected to keep the service unit-testable.
 */
class DeckImportJobService {
    constructor(configService, db = require('../../db'), settingsService = require('../settings')) {
        this.configService = configService;
        this.db = db;
        this.settingsService = settingsService;
    }

    getConfig() {
        // Runtime admin overrides (SiteSettings) win over file config.
        return {
            ...(this.configService.getValue('deckImport') || {}),
            ...this.settingsService.getSection('deckImport')
        };
    }

    // ARCHON: on unless an operator turns it off, which is the opposite of the
    // catalog crawl's default. The crawl is an outbound job nobody asked for
    // and indexes somebody else's whole API; this is the machinery behind a
    // button players already press. Defaulting it off would mean an instance
    // that upgrades quietly loses collection import until someone finds the
    // flag - so the switch exists for an operator having a bad day with Master
    // Vault, not as an opt-in.
    isEnabled() {
        return this.getConfig().enabled !== false;
    }

    /**
     * How many decks one sweep may import. Small on purpose: the sweep shares
     * Master Vault with every player importing a single deck by hand, and a
     * job that empties itself in one tick is the client-side loop again with
     * extra steps.
     *
     * A configured 0 floors to 1 rather than meaning "stop". Honouring it
     * literally would leave every job claimed and forever unfinished, which
     * from the player's side is indistinguishable from the feature being
     * broken; an operator who wants imports stopped has `enabled`.
     */
    getDecksPerTick() {
        const decksPerTick = parseInt(this.getConfig().decksPerTick, 10);

        return Number.isFinite(decksPerTick) ? Math.max(1, decksPerTick) : 5;
    }

    /**
     * Start a job for this user, replacing whatever they had running.
     *
     * The supersede is a separate statement that runs FIRST, and the order is
     * load-bearing: the schema carries a partial unique index over live jobs
     * per user, so inserting before cancelling would be refused by the index
     * rather than replacing the old job. If the cancel silently failed the
     * insert is refused too and this returns null - the player is told their
     * import could not start, which is the correct outcome and much better
     * than two jobs racing each other through the same rate limit.
     *
     * Returns the created row, or null when it could not be created.
     */
    async createJob({ userId, username, uuids }) {
        const config = this.getConfig();
        const cap = parseInt(config.maxJobDecks, 10) || 1000;
        // Deduplicated because the cursor walks this list blindly: a uuid
        // listed twice is a second Master Vault request that can only ever
        // come back "Deck already exists", spending the player's rate limit to
        // inflate their own already-owned count.
        const list = Array.from(
            new Set((Array.isArray(uuids) ? uuids : []).filter((uuid) => typeof uuid === 'string'))
        ).slice(0, cap);

        // ARCHON: checked BEFORE cancelActive, not after. "Username" is NOT
        // NULL, so passing null guaranteed a constraint violation - and the
        // cancel had already run, so a caller with a missing username destroyed
        // the player's in-flight import and got a null back that the API
        // reported as success. Refusing up front leaves the existing job alone.
        if (!userId || !username) {
            logger.warn(
                `Refusing to create a deck import job without a user (${userId}) and username`
            );

            return null;
        }

        await this.cancelActive(userId);

        try {
            const rows = await this.db.query(
                'INSERT INTO "DeckImportJobs" ' +
                    '("UserId", "Username", "Status", "Uuids", "Cursor", "Imported", ' +
                    '"AlreadyOwned", "Failed", "Reasons", "CreatedAt", "UpdatedAt") VALUES ' +
                    "($1, $2, 'pending', $3, 0, 0, 0, 0, '{}', " +
                    "now() AT TIME ZONE 'utc', now() AT TIME ZONE 'utc') RETURNING *",
                [userId, username, JSON.stringify(list)]
            );

            return (rows && rows[0]) || null;
        } catch (err) {
            logger.warn(`Failed to create a deck import job for user ${userId}: ${err.message}`);

            return null;
        }
    }

    /**
     * The job this user has in flight, if any. Null on failure, so a database
     * hiccup shows the player "no import running" rather than a 500 on a page
     * they opened to watch one.
     */
    async getActiveJob(userId) {
        try {
            const rows = await this.db.query(
                'SELECT * FROM "DeckImportJobs" WHERE "UserId" = $1 ' +
                    'AND "Status" IN (\'pending\', \'running\') ORDER BY "CreatedAt" DESC LIMIT 1',
                [userId]
            );

            return (rows && rows[0]) || null;
        } catch (err) {
            logger.warn(
                `Failed to read the active deck import job for user ${userId}: ${err.message}`
            );

            return null;
        }
    }

    /**
     * The user's most recent job whatever became of it. A finished import is
     * still the answer to "what happened to my collection?" - the summary of
     * which decks failed and why is the whole point of having run it, and
     * asking only for live jobs would erase it the moment the last deck landed.
     */
    async getLatestJob(userId) {
        try {
            const rows = await this.db.query(
                'SELECT * FROM "DeckImportJobs" WHERE "UserId" = $1 ' +
                    'ORDER BY "CreatedAt" DESC LIMIT 1',
                [userId]
            );

            return (rows && rows[0]) || null;
        } catch (err) {
            logger.warn(
                `Failed to read the latest deck import job for user ${userId}: ${err.message}`
            );

            return null;
        }
    }

    /**
     * Take the oldest job that is due, marking it running. Null when there is
     * nothing to do.
     *
     * ARCHON: one statement, because more than one lobby process runs this
     * sweep. A SELECT followed by an UPDATE would let both read the same
     * oldest row before either wrote to it, and they would then import the
     * same collection in parallel - doubling that player's Master Vault
     * request rate at exactly the moment the pacing here exists to reduce it.
     * The UPDATE's subquery takes a row lock and SKIP LOCKED steps over rows
     * another process is already claiming, so simultaneous claims pick
     * different jobs rather than fighting over one.
     *
     * 'running' rows are claimable, not just 'pending' ones: a lobby that dies
     * mid-batch leaves its job marked running with nobody working it, and a
     * filter on 'pending' would strand that job until a human noticed. What
     * bounds the work per claim is the batch size, not the status.
     *
     * PausedUntil is the circuit breaker: a job Master Vault has rate-limited
     * is invisible to this query until its backoff expires.
     */
    // How long a claim is good for. UpdatedAt is the lease clock: the claim
    // itself stamps it and every batch re-stamps it, so a job somebody is
    // actively working always looks fresh.
    getClaimLeaseSeconds() {
        const seconds = parseInt(this.getConfig().claimLeaseSeconds, 10);

        return Number.isFinite(seconds) && seconds > 0 ? seconds : 120;
    }

    async claimNextJob() {
        try {
            const rows = await this.db.query(
                'UPDATE "DeckImportJobs" SET "Status" = \'running\', ' +
                    '"UpdatedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = (' +
                    'SELECT "Id" FROM "DeckImportJobs" ' +
                    // ARCHON: a 'running' job is only claimable once its lease
                    // has gone stale. FOR UPDATE SKIP LOCKED alone does not
                    // make a claim exclusive - the row lock dies with the
                    // statement, not with the batch - so a second sweep
                    // starting while the first was still awaiting Master Vault
                    // claimed the SAME job, requested every deck twice, and
                    // then overwrote the first run's absolute counters with its
                    // own. Measured: five decks imported, the row reporting
                    // "0 imported, 5 already owned", and double the traffic
                    // aimed at the origin this feature exists to be gentle to.
                    // Reclaiming a stale one is still required, or a lobby that
                    // died mid-batch would strand its job forever.
                    'WHERE ("Status" = \'pending\' OR ("Status" = \'running\' ' +
                    "AND \"UpdatedAt\" <= now() AT TIME ZONE 'utc' - ($1 || ' seconds')::interval)) " +
                    'AND ("PausedUntil" IS NULL OR "PausedUntil" <= now() AT TIME ZONE \'utc\') ' +
                    'ORDER BY "CreatedAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *',
                [String(this.getClaimLeaseSeconds())]
            );

            return (rows && rows[0]) || null;
        } catch (err) {
            logger.warn(`Failed to claim a deck import job: ${err.message}`);

            return null;
        }
    }

    /**
     * ARCHON: both parsers accept the decoded value and the raw text.
     *
     * Uuids and Reasons are JSON columns, and node-postgres hands back a
     * decoded array/object for jsonb but a string for text or json cast to it.
     * Which one the column is should not be able to break an import, and it is
     * the kind of difference that produces a job that imports nothing while
     * reporting perfect health - so both shapes are read, and anything else
     * degrades to empty rather than throwing inside a sweep.
     */
    parseUuids(job) {
        const value = job ? job.Uuids : null;
        const parsed = Array.isArray(value) ? value : this.parseJson(value);

        return Array.isArray(parsed) ? parsed : [];
    }

    parseReasons(job) {
        const value = job ? job.Reasons : null;
        const parsed = value && typeof value === 'object' ? value : this.parseJson(value);

        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }

    parseJson(value) {
        if (typeof value !== 'string' || value.trim() === '') {
            return null;
        }

        try {
            return JSON.parse(value);
        } catch (err) {
            logger.warn(`Unreadable JSON on a deck import job: ${err.message}`);

            return null;
        }
    }

    /**
     * Persist what a batch achieved. Every count is ABSOLUTE: the worker holds
     * the running totals for the job it claimed, so it writes what the totals
     * now are rather than what changed.
     *
     * `"Imported" = "Imported" + $n` would need the read and the write to be
     * one transaction to be correct, and would double-count the moment a batch
     * was retried or two workers overlapped. Writing the totals makes a
     * repeated write land the same numbers instead of accumulating them.
     *
     * A successful batch also clears the breaker: Master Vault answering is
     * the only evidence that matters, and a failure count left standing from
     * an outage half an hour ago would pause a job that is plainly fine.
     */
    async recordProgress(jobId, { cursor, imported, alreadyOwned, failed, reasons } = {}) {
        try {
            await this.db.query(
                'UPDATE "DeckImportJobs" SET "Cursor" = $2, "Imported" = $3, ' +
                    '"AlreadyOwned" = $4, "Failed" = $5, "Reasons" = $6, ' +
                    '"ConsecutiveFailures" = 0, "PausedUntil" = NULL, "LastError" = NULL, ' +
                    '"UpdatedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
                [
                    jobId,
                    this.toCount(cursor),
                    this.toCount(imported),
                    this.toCount(alreadyOwned),
                    this.toCount(failed),
                    JSON.stringify(reasons || {})
                ]
            );

            return true;
        } catch (err) {
            logger.warn(`Failed to record progress for deck import job ${jobId}: ${err.message}`);

            return false;
        }
    }

    /**
     * Back a job off after Master Vault refused us, persisting the progress it
     * made on the way in the SAME statement.
     *
     * ARCHON: one statement rather than recordProgress followed by a pause,
     * because whichever of the two failed alone would be a bug nobody could
     * see. Losing the progress re-imports decks the player already has, at the
     * cost of more requests from the origin that just rate-limited us; losing
     * the pause is worse - the job is due again on the next tick and hammers
     * Master Vault precisely because it was told to stop.
     *
     * Status is left alone so the job is reclaimed when the backoff expires; a
     * paused job is a waiting job, not a finished one.
     */
    async pauseJob(
        jobId,
        {
            untilMs,
            error,
            consecutiveFailures,
            cursor,
            imported,
            alreadyOwned,
            failed,
            reasons
        } = {}
    ) {
        const until = Number(untilMs);
        // ARCHON: UTC wall clock, as a string, deliberately.
        //
        // "PausedUntil" is `timestamp without time zone` and every other
        // timestamp in this table is written by SQL as now() AT TIME ZONE
        // 'utc'. This is the one written from JavaScript, and handing
        // node-postgres a Date serialises it with the PROCESS's offset, which
        // the column then silently discards. West of UTC that stores a time
        // already in the past, so the claim query sees an expired backoff and
        // resumes hammering the origin that just rate-limited us - the exact
        // failure the column exists to prevent. East of UTC it parks the job
        // for hours and the player's import looks hung. Measured at four hours
        // early in America/New_York and two hours late in Europe/Berlin.
        // Containers run UTC, which is why this hid.
        const pausedUntil = Number.isFinite(until)
            ? new Date(until).toISOString().slice(0, 19).replace('T', ' ')
            : null;

        try {
            await this.db.query(
                'UPDATE "DeckImportJobs" SET "Cursor" = $2, "Imported" = $3, ' +
                    '"AlreadyOwned" = $4, "Failed" = $5, "Reasons" = $6, ' +
                    '"ConsecutiveFailures" = $7, "PausedUntil" = $8, "LastError" = $9, ' +
                    '"UpdatedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
                [
                    jobId,
                    this.toCount(cursor),
                    this.toCount(imported),
                    this.toCount(alreadyOwned),
                    this.toCount(failed),
                    JSON.stringify(reasons || {}),
                    this.toCount(consecutiveFailures),
                    pausedUntil,
                    error || null
                ]
            );

            return true;
        } catch (err) {
            logger.warn(`Failed to pause deck import job ${jobId}: ${err.message}`);

            return false;
        }
    }

    /**
     * Retire a job. 'done' when the cursor reached the end of the list,
     * 'cancelled' when the player (or a newer job) took it away.
     */
    async finishJob(jobId, status = 'done') {
        try {
            await this.db.query(
                'UPDATE "DeckImportJobs" SET "Status" = $2, ' +
                    '"UpdatedAt" = now() AT TIME ZONE \'utc\' WHERE "Id" = $1',
                [jobId, status]
            );

            return true;
        } catch (err) {
            logger.warn(`Failed to finish deck import job ${jobId}: ${err.message}`);

            return false;
        }
    }

    /**
     * Stop whatever this user has in flight. Returns how many rows were
     * cancelled - normally one, zero when they had nothing running, and zero
     * when the query failed. The caller cannot tell those last two apart on
     * purpose: the only thing that acts on the answer is createJob, whose
     * insert is refused by the live-job index if the cancel did not really
     * happen, so the count is a report rather than a permission.
     */
    async cancelActive(userId) {
        try {
            const rows = await this.db.query(
                'UPDATE "DeckImportJobs" SET "Status" = \'cancelled\', ' +
                    '"UpdatedAt" = now() AT TIME ZONE \'utc\' WHERE "UserId" = $1 ' +
                    'AND "Status" IN (\'pending\', \'running\') RETURNING "Id"',
                [userId]
            );

            return (rows || []).length;
        } catch (err) {
            logger.warn(`Failed to cancel the deck import job for user ${userId}: ${err.message}`);

            return 0;
        }
    }

    // Doubling per consecutive failure, capped. The cap matters more than the
    // curve: a player is watching this job, and a backoff that keeps doubling
    // through the night turns "Master Vault was busy for a minute" into an
    // import that never visibly resumes.
    backoffMs(consecutiveFailures) {
        const config = this.getConfig();
        const base = config.backoffBaseMs || 60000;
        const max = config.backoffMaxMs || 1800000;

        return Math.min(max, base * Math.pow(2, Math.max(0, consecutiveFailures - 1)));
    }

    // Counters are NOT NULL and a job's totals are read back as numbers; a
    // caller that omitted one would otherwise write null and break every later
    // read of the row.
    toCount(value) {
        const count = parseInt(value, 10);

        return Number.isFinite(count) && count > 0 ? count : 0;
    }
}

module.exports = DeckImportJobService;
