const logger = require('../log');

/**
 * ARCHON: how much mail this deployment is allowed to send, and who yields.
 *
 * Every provider's entry plan is a hard cap with a cliff at the end of it.
 * Resend's free plan is 100 emails a day and 3,000 a month; Brevo's is 300 a
 * day; SES outside the sandbox has a send rate. Past the cap the provider stops
 * accepting mail, and it stops accepting ALL of it - so the failure is not
 * "some pairing emails were late", it is that the next person to register gets
 * no activation link and, because registration rolls an account back when the
 * mail fails, no account either. One busy Saturday of tournaments locks the
 * site's front door.
 *
 * That is worth arithmetic. A sixteen-player Swiss pairs four rounds: 64
 * pairing emails. Add a scheduling exchange on each match in an async event -
 * a proposal and an acceptance, two people - and one event clears a hundred
 * comfortably. Notification mail is the volume; activation and password reset
 * are the mail that must not fail.
 *
 * So sends are classed:
 *
 *   transactional  somebody is waiting on this RIGHT NOW and cannot proceed
 *                  without it - account activation, password reset, a
 *                  moderation notice. Spends the budget down to zero.
 *   bulk           the site decided to tell someone something - pairings,
 *                  scheduling, deadlines. Stops at the reserve, leaving the
 *                  last slice of the day for the mail that matters, and the
 *                  in-app notification still lands either way.
 *
 * The counter is in the database rather than in memory because the cap belongs
 * to the provider's calendar, not to this process: a restart must not hand the
 * day's quota back, and two node processes must not each believe they have a
 * hundred sends.
 *
 * With no limits configured this does nothing at all - `claim` always allows -
 * so a deployment on a paid plan or its own relay is unaffected.
 */

/** UTC day and month keys. The provider counts in UTC; so must this. */
const dayKey = (when) => when.toISOString().slice(0, 10);
const monthKey = (when) => when.toISOString().slice(0, 7);

class MailBudget {
    /**
     * @param {object} db
     * @param {object} [options]
     * @param {number} [options.dailyLimit]   0 or absent = no daily cap
     * @param {number} [options.monthlyLimit] 0 or absent = no monthly cap
     * @param {number} [options.reserveFraction] share of each cap held back
     *   from bulk mail. 0.2 of a 100/day plan keeps the last 20 for activation
     *   and password resets.
     */
    constructor(db, options = {}) {
        this.db = db;
        this.dailyLimit = Math.max(0, parseInt(options.dailyLimit, 10) || 0);
        this.monthlyLimit = Math.max(0, parseInt(options.monthlyLimit, 10) || 0);

        const fraction = Number(options.reserveFraction);

        this.reserveFraction =
            Number.isFinite(fraction) && fraction >= 0 && fraction < 1 ? fraction : 0.2;
        this.now = options.now || (() => new Date());
        // Set when a count fails, so a broken counter degrades to "send it"
        // rather than to "send nothing". Losing the cap is recoverable; refusing
        // every activation email because a table is missing is not.
        this.degraded = false;
    }

    /** Whether any cap is in force. */
    get enabled() {
        return this.dailyLimit > 0 || this.monthlyLimit > 0;
    }

    /**
     * How many of a cap bulk mail may use. Transactional gets the whole cap.
     */
    ceilingFor(priority, limit) {
        if (limit <= 0) {
            return Infinity;
        }

        return priority === 'bulk' ? Math.floor(limit * (1 - this.reserveFraction)) : limit;
    }

    /**
     * Increment one period's counter, but only if it is under its ceiling.
     *
     * ONE STATEMENT, because the check and the increment have to be the same
     * operation. Reading the count, comparing it, and then incrementing is a
     * race every concurrent send takes part in: a round that pairs sixteen
     * players fires its notifications together, they all read the same "80
     * used", and they all decide there is room. Against a real PostgreSQL that
     * took a cap of 100 to 121 - which is not a cap.
     *
     * `ON CONFLICT ... DO UPDATE ... WHERE` is the atomic form. The row lock
     * taken by the conflicting insert is held across the WHERE, so exactly one
     * of any number of racing statements sees each value of Sent. No row comes
     * back when the ceiling is reached, and that is the refusal.
     *
     * The plain INSERT path (no row yet, first send of the day) needs no
     * predicate: a limit below 1 means the budget is disabled entirely.
     *
     * @returns {Promise<number|null>} the new count, or null if it was full
     */
    async increment(period, key, ceiling) {
        const rows = await this.db.query(
            'INSERT INTO "EmailQuota" ("Period", "PeriodKey", "Sent") VALUES ($1, $2, 1) ' +
                'ON CONFLICT ("Period", "PeriodKey") DO UPDATE SET ' +
                '"Sent" = "EmailQuota"."Sent" + 1 WHERE "EmailQuota"."Sent" < $3 ' +
                'RETURNING "Sent"',
            [period, key, ceiling]
        );

        return rows && rows[0] ? parseInt(rows[0].Sent, 10) : null;
    }

    /** Give one period's counter back, floored at zero. */
    async decrement(period, key) {
        await this.db.query(
            'UPDATE "EmailQuota" SET "Sent" = GREATEST("Sent" - 1, 0) ' +
                'WHERE "Period" = $1 AND "PeriodKey" = $2',
            [period, key]
        );
    }

    /**
     * Take one send from the budget, if there is one to take.
     *
     * Claiming BEFORE the send rather than recording after it is deliberate:
     * the provider's counter is the one that matters and it moves the moment
     * the request lands, so a budget that recorded afterwards would always be
     * one burst behind. The cost is that a send which then fails has been
     * counted, which `release` undoes.
     *
     * The two periods are claimed in order and the day is given back if the
     * month refuses. That is not a transaction, and does not need to be: the
     * only visible effect of the gap is that the day's count reads one high for
     * a moment, which errs toward sending LESS than the cap. Erring the other
     * way is what gets mail refused by the provider.
     *
     * @returns {Promise<{ok: boolean, reason?: string, sentToday: number,
     *   sentThisMonth: number, dailyLimit: number, monthlyLimit: number}>}
     */
    async claim(priority = 'transactional') {
        if (!this.enabled) {
            return { ok: true, sentToday: 0, sentThisMonth: 0, dailyLimit: 0, monthlyLimit: 0 };
        }

        const when = this.now();
        const day = dayKey(when);
        const month = monthKey(when);
        const state = {
            sentToday: 0,
            sentThisMonth: 0,
            dailyLimit: this.dailyLimit,
            monthlyLimit: this.monthlyLimit
        };

        try {
            if (this.dailyLimit > 0) {
                const sentToday = await this.increment(
                    'day',
                    day,
                    this.ceilingFor(priority, this.dailyLimit)
                );

                if (sentToday === null) {
                    const counts = await this.counts(day, month);

                    return {
                        ...state,
                        sentToday: counts.day,
                        sentThisMonth: counts.month,
                        ok: false,
                        reason: 'daily'
                    };
                }

                state.sentToday = sentToday;
            }

            if (this.monthlyLimit > 0) {
                const sentThisMonth = await this.increment(
                    'month',
                    month,
                    this.ceilingFor(priority, this.monthlyLimit)
                );

                if (sentThisMonth === null) {
                    // The day was claimed and this send is not happening.
                    if (this.dailyLimit > 0) {
                        await this.decrement('day', day);
                        state.sentToday = Math.max(state.sentToday - 1, 0);
                    }

                    const counts = await this.counts(day, month);

                    return {
                        ...state,
                        sentThisMonth: counts.month,
                        ok: false,
                        reason: 'monthly'
                    };
                }

                state.sentThisMonth = sentThisMonth;
            }
        } catch (err) {
            if (!this.degraded) {
                // Once, not per send: a missing table would otherwise fill the
                // log with the same line at the rate mail is sent.
                logger.warn(
                    `Mail budget could not be read (${err.message}); sending without a cap ` +
                        'until it recovers.'
                );
                this.degraded = true;
            }

            // Failing OPEN is the deliberate choice. Losing the cap costs money
            // at the provider; refusing every activation email because a table
            // is missing locks real people out of a working site.
            return { ok: true, sentToday: 0, sentThisMonth: 0, dailyLimit: 0, monthlyLimit: 0 };
        }

        this.degraded = false;

        return { ...state, ok: true };
    }

    /**
     * Hand a claimed send back after the provider refused it.
     *
     * Floored at zero: a release with no matching claim (a send attempted while
     * the counter was unreadable, which then failed) must not drive the count
     * negative and hand out free quota.
     */
    async release() {
        if (!this.enabled) {
            return;
        }

        const when = this.now();

        try {
            if (this.dailyLimit > 0) {
                await this.decrement('day', dayKey(when));
            }

            if (this.monthlyLimit > 0) {
                await this.decrement('month', monthKey(when));
            }
        } catch (err) {
            logger.warn(`Mail budget could not be released: ${err.message}`);
        }
    }

    async counts(day, month) {
        const rows = await this.db.query(
            'SELECT "Period", "Sent" FROM "EmailQuota" ' +
                'WHERE ("Period" = \'day\' AND "PeriodKey" = $1) ' +
                'OR ("Period" = \'month\' AND "PeriodKey" = $2)',
            [day, month]
        );

        const counts = { day: 0, month: 0 };

        for (const row of rows || []) {
            counts[row.Period] = parseInt(row.Sent, 10) || 0;
        }

        return counts;
    }

    /**
     * What is left, for the health check and the admin page. Read-only: it
     * never claims, so asking cannot cost a send.
     */
    async describe() {
        if (!this.enabled) {
            return { enabled: false };
        }

        const when = this.now();

        try {
            const counts = await this.counts(dayKey(when), monthKey(when));

            return {
                enabled: true,
                sentToday: counts.day,
                sentThisMonth: counts.month,
                dailyLimit: this.dailyLimit,
                monthlyLimit: this.monthlyLimit,
                bulkDailyCeiling: this.ceilingFor('bulk', this.dailyLimit),
                bulkStopped:
                    counts.day >= this.ceilingFor('bulk', this.dailyLimit) ||
                    counts.month >= this.ceilingFor('bulk', this.monthlyLimit)
            };
        } catch (err) {
            return { enabled: true, error: err.message };
        }
    }
}

module.exports = MailBudget;
