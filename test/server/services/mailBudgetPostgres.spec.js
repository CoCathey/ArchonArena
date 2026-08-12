// ESM, and `it` comes from vitest rather than the global: the suite-wide
// helper in test/helpers/integrationhelper.js re-wraps the global `it` and
// drops the per-test timeout argument. Starting a PostgreSQL does not fit in
// the default 5s.
import { it } from 'vitest';
import { createRequire } from 'node:module';

import scratchPostgres from '../../helpers/scratchPostgres.js';

const require = createRequire(import.meta.url);
const MailBudget = require('../../../server/services/MailBudget');
const { Pool } = require('pg');

const DB = 'archonarena_mailbudget';

/**
 * ARCHON: the send cap has to hold when sends arrive together.
 *
 * A budget that reads the count, compares it, and then increments is a race
 * every concurrent send takes part in - and tournament mail is concurrent by
 * construction: pairing a sixteen-player round fires eight notifications at
 * once, and they all read the same "80 used" and all conclude there is room.
 *
 * The in-memory fake used by the unit tests cannot show this. It runs one
 * statement at a time by construction, so it agrees with any implementation,
 * correct or not. The first version of this budget passed all fourteen of those
 * tests and still took a cap of 100 to 121 against a real PostgreSQL, because
 * the check and the increment were separate statements.
 *
 * Skips - it does not fail - where no PostgreSQL is available.
 */
describe('the mail budget, against real PostgreSQL', function () {
    let pg;
    let pool;
    let db;

    const available = scratchPostgres.available();

    beforeAll(async function () {
        if (!available) {
            return;
        }

        pg = await scratchPostgres.start();

        if (!pg) {
            return;
        }

        pg.createDatabase(DB);
        pg.loadSchema(DB);

        pool = new Pool({ connectionString: `${pg.uri}/${DB}` });
        db = { query: async (text, params = []) => (await pool.query(text, params)).rows };
    }, 240000);

    afterAll(async function () {
        if (pool) {
            await pool.end();
        }

        if (pg) {
            pg.stop();
        }
    }, 60000);

    const maybe = (name, body, timeout = 60000) =>
        it(
            name,
            async function () {
                if (!available || !pg) {
                    return;
                }

                await body();
            },
            timeout
        );

    // Each test gets its own day so they cannot interfere.
    let dayCounter = 0;
    const budgetFor = (options = {}) => {
        dayCounter += 1;

        const stamp = new Date(`2026-08-${String(dayCounter).padStart(2, '0')}T14:00:00Z`);

        return new MailBudget(db, {
            dailyLimit: 100,
            monthlyLimit: 3000,
            now: () => stamp,
            ...options
        });
    };

    maybe('never exceeds the cap when sends arrive together', async function () {
        const budget = budgetFor();

        // Fill to one short of the cap, sequentially.
        for (let i = 0; i < 99; i += 1) {
            expect((await budget.claim('transactional')).ok).toBe(true);
        }

        // Now forty at once against the single remaining slot. Exactly one may
        // win. Reading-then-writing lets all forty through.
        const racers = await Promise.all(
            Array.from({ length: 40 }, () => budget.claim('transactional'))
        );

        expect(racers.filter((result) => result.ok)).toHaveLength(1);
        expect((await budget.describe()).sentToday).toBe(100);
    });

    maybe('holds the reserve for transactional mail under concurrency', async function () {
        const budget = budgetFor();

        for (let i = 0; i < 79; i += 1) {
            await budget.claim('bulk');
        }

        // A whole round's pairings landing together on the reserve boundary.
        const pairings = await Promise.all(Array.from({ length: 16 }, () => budget.claim('bulk')));

        // One slot left below the 80 ceiling, so one pairing email goes.
        expect(pairings.filter((result) => result.ok)).toHaveLength(1);

        // And the twenty the reserve exists to protect are all still there.
        const transactional = await Promise.all(
            Array.from({ length: 25 }, () => budget.claim('transactional'))
        );

        expect(transactional.filter((result) => result.ok)).toHaveLength(20);
        expect((await budget.describe()).sentToday).toBe(100);
    });

    maybe('does not spend the day when the month is the one that is full', async function () {
        const budget = budgetFor({ monthlyLimit: 5 });
        // A different month key from the other tests, seeded to its ceiling.
        await db.query(
            'INSERT INTO "EmailQuota" ("Period", "PeriodKey", "Sent") VALUES (\'month\', $1, 5) ' +
                'ON CONFLICT ("Period", "PeriodKey") DO UPDATE SET "Sent" = 5',
            ['2026-08']
        );

        const before = (await budget.describe()).sentToday;
        const result = await budget.claim('transactional');

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('monthly');

        // The day was claimed before the month refused, and had to be given
        // back - otherwise every refused send would still burn a daily slot and
        // the day would run out for reasons nothing can observe.
        expect((await budget.describe()).sentToday).toBe(before);
    });

    maybe('starts a new UTC day clean while the month carries over', async function () {
        const monday = new MailBudget(db, {
            dailyLimit: 100,
            monthlyLimit: 3000,
            now: () => new Date('2026-09-10T23:50:00Z')
        });
        const tuesday = new MailBudget(db, {
            dailyLimit: 100,
            monthlyLimit: 3000,
            now: () => new Date('2026-09-11T00:10:00Z')
        });

        await monday.claim('transactional');
        await monday.claim('transactional');

        const next = await tuesday.describe();

        expect(next.sentToday).toBe(0);
        expect(next.sentThisMonth).toBe(2);
    });
});
