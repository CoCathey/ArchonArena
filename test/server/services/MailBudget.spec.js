const MailBudget = require('../../../server/services/MailBudget');

/**
 * ARCHON: the provider's plan is a cliff, not a slope.
 *
 * Resend's free plan is 100 emails a day and 3,000 a month. Past the cap the
 * provider refuses ALL mail - so the failure is not "some pairing emails were
 * late", it is that the next person to register gets no activation link, and
 * because registration rolls an account back when that mail fails, no account
 * either. One sixteen-player Swiss is 64 pairing emails, so an afternoon of
 * tournaments can shut the front door.
 *
 * What these tests care about is the ordering that prevents it: notification
 * mail runs out of budget BEFORE the mail somebody is actually waiting on does.
 */
describe('MailBudget', function () {
    // An in-memory stand-in for the EmailQuota table, routed on the same SQL
    // the service issues.
    const createDb = (seed = {}) => {
        const rows = new Map(Object.entries(seed));

        return {
            rows,
            query: vi.fn(async (sql, params = []) => {
                if (sql.startsWith('SELECT "Period"')) {
                    const [day, month] = params;

                    return [
                        ['day', day],
                        ['month', month]
                    ]
                        .filter(([period, key]) => rows.has(`${period}:${key}`))
                        .map(([period, key]) => ({
                            Period: period,
                            Sent: rows.get(`${period}:${key}`)
                        }));
                }

                // The conditional increment: bump only while under the ceiling,
                // and say which by whether a row comes back. Against a real
                // PostgreSQL this is one statement precisely so that racing
                // sends cannot all read the same count and all decide there is
                // room - see the real-database test.
                if (sql.startsWith('INSERT INTO "EmailQuota"')) {
                    const [period, key, ceiling] = params;
                    const slot = `${period}:${key}`;
                    const current = rows.get(slot);

                    if (current === undefined) {
                        rows.set(slot, 1);

                        return [{ Sent: 1 }];
                    }

                    if (current >= ceiling) {
                        return [];
                    }

                    rows.set(slot, current + 1);

                    return [{ Sent: current + 1 }];
                }

                if (sql.startsWith('UPDATE "EmailQuota"')) {
                    const [period, key] = params;
                    const slot = `${period}:${key}`;

                    rows.set(slot, Math.max((rows.get(slot) || 0) - 1, 0));

                    return [];
                }

                throw new Error(`unexpected SQL: ${sql}`);
            })
        };
    };

    const at = (iso) => () => new Date(iso);
    const freeTier = (db, extra = {}) =>
        new MailBudget(db, {
            dailyLimit: 100,
            monthlyLimit: 3000,
            now: at('2026-08-12T14:00:00Z'),
            ...extra
        });

    describe('with no limits set', function () {
        // A paid plan or a relay of your own. Nothing should be counted, and
        // nothing should be refused.
        it('allows everything and never touches the database', async function () {
            const db = createDb();
            const budget = new MailBudget(db, {});

            expect(budget.enabled).toBe(false);
            expect((await budget.claim('bulk')).ok).toBe(true);
            expect((await budget.claim('transactional')).ok).toBe(true);
            expect(db.query).not.toHaveBeenCalled();
        });
    });

    describe('spending the day', function () {
        it('counts each claim against the day and the month together', async function () {
            const db = createDb();
            const budget = freeTier(db);

            await budget.claim('bulk');
            await budget.claim('transactional');

            expect(db.rows.get('day:2026-08-12')).toBe(2);
            expect(db.rows.get('month:2026-08')).toBe(2);
        });

        it('counts in UTC, because that is how the provider counts', async function () {
            const db = createDb();
            // Late evening in the US is already tomorrow in UTC. Counting local
            // would give the provider's day two different keys and let a cap of
            // 100 send 200.
            const budget = freeTier(db, { now: at('2026-08-12T23:30:00Z') });

            await budget.claim('transactional');

            expect(db.rows.get('day:2026-08-12')).toBe(1);
            expect(db.rows.get('month:2026-08')).toBe(1);
        });
    });

    /**
     * The whole point. With a 100/day plan and a 20% reserve, notification mail
     * stops at 80 and the remaining 20 belong to activation and password reset.
     */
    describe('who yields when the plan runs low', function () {
        it('stops notification mail at the reserve and keeps sending the rest', async function () {
            const db = createDb({ 'day:2026-08-12': 80, 'month:2026-08': 80 });
            const budget = freeTier(db);

            const bulk = await budget.claim('bulk');

            expect(bulk.ok).toBe(false);
            expect(bulk.reason).toBe('daily');
            expect(bulk.sentToday).toBe(80);

            // The front door is still open.
            expect((await budget.claim('transactional')).ok).toBe(true);
        });

        it('lets notification mail through while there is room', async function () {
            const db = createDb({ 'day:2026-08-12': 79, 'month:2026-08': 79 });

            expect((await freeTier(db).claim('bulk')).ok).toBe(true);
        });

        it('refuses even transactional mail once the plan is genuinely spent', async function () {
            const db = createDb({ 'day:2026-08-12': 100, 'month:2026-08': 100 });
            const result = await freeTier(db).claim('transactional');

            expect(result.ok).toBe(false);
            expect(result.reason).toBe('daily');
        });

        it('applies the same reserve to the monthly cap', async function () {
            // Under the daily cap, over the monthly bulk ceiling (2400 of 3000).
            const db = createDb({ 'day:2026-08-12': 1, 'month:2026-08': 2400 });
            const budget = freeTier(db);

            const bulk = await budget.claim('bulk');

            expect(bulk.ok).toBe(false);
            expect(bulk.reason).toBe('monthly');
            expect((await budget.claim('transactional')).ok).toBe(true);
        });

        it('honours a reserve of zero as no reserve at all', async function () {
            const db = createDb({ 'day:2026-08-12': 99, 'month:2026-08': 99 });

            expect((await freeTier(db, { reserveFraction: 0 }).claim('bulk')).ok).toBe(true);
        });
    });

    describe('giving a send back', function () {
        // The claim happens before the send, because two sends racing each
        // other must not both read "99 used" and both go. So a send the
        // provider then refuses has to be returned.
        it('returns a claim the provider refused', async function () {
            const db = createDb();
            const budget = freeTier(db);

            await budget.claim('transactional');
            expect(db.rows.get('day:2026-08-12')).toBe(1);

            await budget.release();
            expect(db.rows.get('day:2026-08-12')).toBe(0);
        });

        // Otherwise a provider outage during a degraded read would mint quota.
        it('never drives the count below zero', async function () {
            const db = createDb();
            const budget = freeTier(db);

            await budget.release();
            await budget.release();

            expect(db.rows.get('day:2026-08-12')).toBe(0);
        });
    });

    /**
     * A cap that fails closed would be worse than no cap: losing the limit
     * costs money at the provider, but refusing every activation email because
     * a table is missing locks real people out of a working site.
     */
    describe('when the counter cannot be read', function () {
        it('sends anyway rather than refusing everything', async function () {
            const budget = freeTier({
                query: vi.fn(async () => {
                    throw new Error('relation "EmailQuota" does not exist');
                })
            });

            expect((await budget.claim('bulk')).ok).toBe(true);
            expect((await budget.claim('transactional')).ok).toBe(true);
        });

        it('resumes counting once the database comes back', async function () {
            const db = createDb({ 'day:2026-08-12': 80, 'month:2026-08': 80 });
            let broken = true;
            const flaky = {
                ...db,
                query: async (...args) => {
                    if (broken) {
                        throw new Error('connection terminated');
                    }

                    return db.query(...args);
                }
            };
            const budget = freeTier(flaky);

            expect((await budget.claim('bulk')).ok).toBe(true);

            broken = false;

            expect((await budget.claim('bulk')).ok).toBe(false);
        });
    });

    describe('describing what is left', function () {
        it('reports the state without spending any of it', async function () {
            const db = createDb({ 'day:2026-08-12': 42, 'month:2026-08': 900 });
            const state = await freeTier(db).describe();

            expect(state).toMatchObject({
                enabled: true,
                sentToday: 42,
                sentThisMonth: 900,
                dailyLimit: 100,
                monthlyLimit: 3000,
                bulkDailyCeiling: 80,
                bulkStopped: false
            });
            expect(db.rows.get('day:2026-08-12')).toBe(42);
        });

        it('says when notification mail has stopped', async function () {
            const db = createDb({ 'day:2026-08-12': 85, 'month:2026-08': 85 });

            expect((await freeTier(db).describe()).bulkStopped).toBe(true);
        });
    });
});
