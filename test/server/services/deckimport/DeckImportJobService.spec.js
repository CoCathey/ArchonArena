const DeckImportJobService = require('../../../../server/services/deckimport/DeckImportJobService');

describe('DeckImportJobService', function () {
    let service;
    let db;
    let config;

    const defaultConfig = {
        decksPerTick: 5,
        maxJobDecks: 1000,
        backoffBaseMs: 1000,
        backoffMaxMs: 8000
    };

    const uuid = (n) => `${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;

    const configService = () => ({
        getValue: (key) => (key === 'deckImport' ? config : undefined)
    });

    const jobRow = (overrides = {}) => ({
        Id: 7,
        UserId: 42,
        Username: 'Onyx',
        Status: 'pending',
        Uuids: JSON.stringify([uuid(1), uuid(2)]),
        Cursor: 0,
        Imported: 0,
        AlreadyOwned: 0,
        Failed: 0,
        Reasons: '{}',
        LastError: null,
        PausedUntil: null,
        ConsecutiveFailures: 0,
        ...overrides
    });

    const callsMatching = (fragment) =>
        db.query.mock.calls.filter(([sql]) => sql.includes(fragment));

    beforeEach(function () {
        config = { ...defaultConfig };
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new DeckImportJobService(configService(), db);
    });

    describe('feature flags', function () {
        // The opposite default to the catalog crawl, and deliberately so: this
        // is the machinery behind a button players already press, not an
        // outbound crawler an operator has to opt into.
        it('is on unless an operator turns it off', function () {
            expect(service.isEnabled()).toBe(true);

            config = {};
            expect(service.isEnabled()).toBe(true);

            config = { enabled: false };
            expect(service.isEnabled()).toBe(false);
        });

        it('imports a small batch per sweep by default', function () {
            delete config.decksPerTick;

            expect(service.getDecksPerTick()).toBe(5);

            config.decksPerTick = 12;
            expect(service.getDecksPerTick()).toBe(12);
        });

        // A configured 0 would leave every job claimed and never finished,
        // which from the player's side is the feature being broken. An
        // operator who wants imports stopped has `enabled`.
        it('never lets the batch size reach zero', function () {
            config.decksPerTick = 0;
            expect(service.getDecksPerTick()).toBe(1);

            config.decksPerTick = -5;
            expect(service.getDecksPerTick()).toBe(1);
        });
    });

    describe('createJob', function () {
        beforeEach(function () {
            db.query.mockImplementation(async (sql) =>
                sql.includes('INSERT INTO "DeckImportJobs"') ? [jobRow()] : []
            );
        });

        // The schema carries a partial unique index over live jobs per user,
        // so inserting first would be refused by the index rather than
        // replacing the old job.
        it('supersedes the previous live job BEFORE inserting the new one', async function () {
            const job = await service.createJob({
                userId: 42,
                username: 'Onyx',
                uuids: [uuid(1), uuid(2)]
            });

            const [cancelSql, cancelParams] = db.query.mock.calls[0];
            const [insertSql, insertParams] = db.query.mock.calls[1];

            expect(cancelSql).toContain('"Status" = \'cancelled\'');
            expect(cancelSql).toContain("\"Status\" IN ('pending', 'running')");
            expect(cancelParams).toEqual([42]);
            expect(insertSql).toContain('INSERT INTO "DeckImportJobs"');
            expect(insertSql).toContain("'pending'");
            expect(insertParams).toEqual([42, 'Onyx', JSON.stringify([uuid(1), uuid(2)])]);
            expect(job).toEqual(expect.objectContaining({ Id: 7, Status: 'pending' }));
        });

        it('caps the collection at the configured maximum', async function () {
            config.maxJobDecks = 3;

            await service.createJob({
                userId: 42,
                uuids: [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)]
            });

            expect(JSON.parse(callsMatching('INSERT INTO')[0][1][2])).toEqual([
                uuid(1),
                uuid(2),
                uuid(3)
            ]);
        });

        it('defaults the cap when it is not configured', async function () {
            delete config.maxJobDecks;

            await service.createJob({
                userId: 42,
                uuids: Array.from({ length: 1200 }, (_unused, i) => uuid(i))
            });

            expect(JSON.parse(callsMatching('INSERT INTO')[0][1][2])).toHaveLength(1000);
        });

        // The cursor walks this list blindly, so a duplicate is a Master Vault
        // request that can only come back "Deck already exists" - spending the
        // player's rate limit to inflate their own already-owned count.
        it('drops duplicates and anything that is not a uuid string', async function () {
            await service.createJob({
                userId: 42,
                uuids: [uuid(1), uuid(1), null, 12345, uuid(2), undefined]
            });

            expect(JSON.parse(callsMatching('INSERT INTO')[0][1][2])).toEqual([uuid(1), uuid(2)]);
        });

        it('still creates a job for a collection with nothing left to import', async function () {
            await service.createJob({ userId: 42, uuids: [] });

            expect(JSON.parse(callsMatching('INSERT INTO')[0][1][2])).toEqual([]);
        });

        it('returns null rather than throwing when the insert fails', async function () {
            db.query.mockRejectedValue(new Error('db down'));

            await expect(service.createJob({ userId: 42, uuids: [uuid(1)] })).resolves.toBeNull();
        });
    });

    describe('getActiveJob', function () {
        it('reads only a live job for that user', async function () {
            db.query.mockResolvedValue([jobRow({ Status: 'running' })]);

            const job = await service.getActiveJob(42);

            const [sql, params] = db.query.mock.calls[0];

            expect(sql).toContain("\"Status\" IN ('pending', 'running')");
            expect(params).toEqual([42]);
            expect(job.Status).toBe('running');
        });

        it('answers null when the user has nothing running', async function () {
            expect(await service.getActiveJob(42)).toBeNull();
        });

        it('answers null rather than throwing when the query fails', async function () {
            db.query.mockRejectedValue(new Error('db down'));

            await expect(service.getActiveJob(42)).resolves.toBeNull();
        });
    });

    // A finished import is still the answer to "what happened to my
    // collection?" - the per-deck failure summary is the point of having run
    // it, and it must not vanish the moment the last deck lands.
    describe('getLatestJob', function () {
        it('reads the newest job whatever became of it', async function () {
            db.query.mockResolvedValue([jobRow({ Status: 'done' })]);

            const job = await service.getLatestJob(42);

            const [sql, params] = db.query.mock.calls[0];

            expect(sql).not.toContain('"Status" IN');
            expect(sql).toContain('ORDER BY "CreatedAt" DESC LIMIT 1');
            expect(params).toEqual([42]);
            expect(job.Status).toBe('done');
        });

        it('answers null rather than throwing when the query fails', async function () {
            db.query.mockRejectedValue(new Error('db down'));

            await expect(service.getLatestJob(42)).resolves.toBeNull();
        });
    });

    describe('claimNextJob', function () {
        // Two lobby processes run this sweep. A SELECT then an UPDATE would
        // let both read the same oldest row and import the same collection in
        // parallel, doubling that player's Master Vault request rate at the
        // exact moment the pacing exists to reduce it.
        it('claims in one statement that another process cannot claim too', async function () {
            db.query.mockResolvedValue([jobRow({ Status: 'running' })]);

            const job = await service.claimNextJob();

            const [sql] = db.query.mock.calls[0];

            expect(sql).toContain('UPDATE "DeckImportJobs"');
            expect(sql).toContain('FOR UPDATE SKIP LOCKED');
            expect(sql).toContain('"Status" = \'running\'');
            expect(sql).toContain('ORDER BY "CreatedAt" ASC LIMIT 1');
            expect(sql).toContain('RETURNING *');
            expect(db.query).toHaveBeenCalledTimes(1);
            expect(job.Id).toBe(7);
        });

        // A lobby that died mid-batch leaves its job marked running with
        // nobody working it; filtering on 'pending' would strand it forever.
        it('considers a job left running by a dead lobby, not only pending ones', async function () {
            await service.claimNextJob();

            expect(db.query.mock.calls[0][0]).toContain("\"Status\" IN ('pending', 'running')");
        });

        it('leaves a rate-limited job alone until its backoff expires', async function () {
            await service.claimNextJob();

            expect(db.query.mock.calls[0][0]).toContain(
                '("PausedUntil" IS NULL OR "PausedUntil" <= now()'
            );
        });

        it('answers null when there is nothing to do', async function () {
            expect(await service.claimNextJob()).toBeNull();
        });

        it('answers null rather than throwing when the claim fails', async function () {
            db.query.mockRejectedValue(new Error('db down'));

            await expect(service.claimNextJob()).resolves.toBeNull();
        });
    });

    // jsonb hands back a decoded array/object, text hands back a string, and
    // which one the column happens to be must not be able to break an import.
    describe('parsing the job payload', function () {
        it('reads uuids from the raw text and from a decoded array alike', function () {
            expect(service.parseUuids(jobRow())).toEqual([uuid(1), uuid(2)]);
            expect(service.parseUuids(jobRow({ Uuids: [uuid(3)] }))).toEqual([uuid(3)]);
        });

        it('reads reasons from the raw text and from a decoded object alike', function () {
            expect(service.parseReasons(jobRow({ Reasons: '{"a":"already"}' }))).toEqual({
                a: 'already'
            });
            expect(service.parseReasons(jobRow({ Reasons: { a: 'already' } }))).toEqual({
                a: 'already'
            });
        });

        it('degrades to empty rather than throwing inside a sweep', function () {
            expect(service.parseUuids(jobRow({ Uuids: null }))).toEqual([]);
            expect(service.parseUuids(jobRow({ Uuids: '' }))).toEqual([]);
            expect(service.parseUuids(jobRow({ Uuids: '   ' }))).toEqual([]);
            expect(service.parseUuids(jobRow({ Uuids: '[not json' }))).toEqual([]);
            expect(service.parseUuids(jobRow({ Uuids: '{"not":"a list"}' }))).toEqual([]);
            expect(service.parseUuids(null)).toEqual([]);

            expect(service.parseReasons(jobRow({ Reasons: null }))).toEqual({});
            expect(service.parseReasons(jobRow({ Reasons: '' }))).toEqual({});
            expect(service.parseReasons(jobRow({ Reasons: '{oops' }))).toEqual({});
            // An array is JSON, and is still not a uuid -> reason map.
            expect(service.parseReasons(jobRow({ Reasons: '[]' }))).toEqual({});
            expect(service.parseReasons(null)).toEqual({});
        });
    });

    describe('recordProgress', function () {
        // The worker holds the running totals for the job it claimed, so it
        // writes what they now ARE. Incrementing in SQL would double-count a
        // retried batch and would need the read and the write to be one
        // transaction to be correct at all.
        it('writes absolute totals rather than deltas', async function () {
            await service.recordProgress(7, {
                cursor: 15,
                imported: 11,
                alreadyOwned: 3,
                failed: 1,
                reasons: { [uuid(4)]: 'Deck already exists.' }
            });

            const [sql, params] = db.query.mock.calls[0];

            expect(sql).toContain('"Cursor" = $2');
            expect(sql).not.toContain('"Imported" = "Imported" +');
            expect(sql).toContain('"UpdatedAt" = now()');
            expect(params).toEqual([
                7,
                15,
                11,
                3,
                1,
                JSON.stringify({ [uuid(4)]: 'Deck already exists.' })
            ]);
        });

        // Master Vault answering is the only evidence that matters: a failure
        // count left standing from an outage half an hour ago would pause a
        // job that is plainly fine.
        it('clears the circuit breaker on a batch that worked', async function () {
            await service.recordProgress(7, { cursor: 5, imported: 5 });

            const [sql] = db.query.mock.calls[0];

            expect(sql).toContain('"ConsecutiveFailures" = 0');
            expect(sql).toContain('"PausedUntil" = NULL');
            expect(sql).toContain('"LastError" = NULL');
        });

        it('never writes null into a counter column', async function () {
            await service.recordProgress(7, {});

            expect(db.query.mock.calls[0][1]).toEqual([7, 0, 0, 0, 0, '{}']);
        });

        it('reports failure rather than throwing when the write fails', async function () {
            db.query.mockRejectedValue(new Error('db down'));

            await expect(service.recordProgress(7, { cursor: 1 })).resolves.toBe(false);
        });
    });

    describe('pauseJob', function () {
        const pause = (overrides = {}) =>
            service.pauseJob(7, {
                untilMs: 1700000000000,
                error: 'Master Vault is rate limiting deck imports.',
                consecutiveFailures: 2,
                cursor: 9,
                imported: 7,
                alreadyOwned: 2,
                failed: 0,
                reasons: {},
                ...overrides
            });

        // Two statements would make either half a bug nobody could see:
        // losing the progress re-imports decks from the origin that just rate
        // limited us, and losing the pause makes the job due again next tick -
        // hammering Master Vault precisely because it told us to stop.
        it('persists the progress and the backoff in one statement', async function () {
            await pause();

            expect(db.query).toHaveBeenCalledTimes(1);

            const [sql, params] = db.query.mock.calls[0];

            expect(sql).toContain('"Cursor" = $2');
            expect(sql).toContain('"ConsecutiveFailures" = $7');
            expect(sql).toContain('"PausedUntil" = $8');
            expect(sql).toContain('"LastError" = $9');
            // The status is untouched: a paused job is a waiting job, so the
            // sweep reclaims it once the backoff expires.
            expect(sql).not.toContain('"Status"');
            expect(params.slice(0, 7)).toEqual([7, 9, 7, 2, 0, '{}', 2]);
            expect(params[7].getTime()).toBe(1700000000000);
            expect(params[8]).toContain('rate limiting');
        });

        it('accepts a pause with no deadline rather than writing an invalid date', async function () {
            await pause({ untilMs: undefined });

            expect(db.query.mock.calls[0][1][7]).toBeNull();
        });

        it('reports failure rather than throwing when the write fails', async function () {
            db.query.mockRejectedValue(new Error('db down'));

            await expect(pause()).resolves.toBe(false);
        });
    });

    describe('finishJob', function () {
        it('retires a job as done by default', async function () {
            await service.finishJob(7);

            const [sql, params] = db.query.mock.calls[0];

            expect(sql).toContain('"Status" = $2');
            expect(sql).toContain('"UpdatedAt" = now()');
            expect(params).toEqual([7, 'done']);
        });

        it('retires a job under another status when asked', async function () {
            await service.finishJob(7, 'cancelled');

            expect(db.query.mock.calls[0][1]).toEqual([7, 'cancelled']);
        });

        it('reports failure rather than throwing when the write fails', async function () {
            db.query.mockRejectedValue(new Error('db down'));

            await expect(service.finishJob(7)).resolves.toBe(false);
        });
    });

    describe('cancelActive', function () {
        it('cancels every live job for the user and counts them', async function () {
            db.query.mockResolvedValue([{ Id: 7 }]);

            expect(await service.cancelActive(42)).toBe(1);

            const [sql, params] = db.query.mock.calls[0];

            expect(sql).toContain('"Status" = \'cancelled\'');
            expect(sql).toContain("\"Status\" IN ('pending', 'running')");
            expect(sql).toContain('RETURNING "Id"');
            expect(params).toEqual([42]);
        });

        it('counts nothing when the user had nothing running', async function () {
            expect(await service.cancelActive(42)).toBe(0);
        });

        it('counts nothing rather than throwing when the update fails', async function () {
            db.query.mockRejectedValue(new Error('db down'));

            await expect(service.cancelActive(42)).resolves.toBe(0);
        });
    });

    describe('backoffMs', function () {
        it('doubles per consecutive failure and stops at the ceiling', function () {
            expect(service.backoffMs(1)).toBe(1000);
            expect(service.backoffMs(2)).toBe(2000);
            expect(service.backoffMs(3)).toBe(4000);
            expect(service.backoffMs(4)).toBe(8000);
            expect(service.backoffMs(20)).toBe(8000);
        });

        // A player is watching this job: a backoff that keeps doubling through
        // the night turns "Master Vault was busy" into an import that never
        // visibly resumes.
        it('falls back to a minute doubling up to half an hour', function () {
            config = {};

            expect(service.backoffMs(1)).toBe(60000);
            expect(service.backoffMs(2)).toBe(120000);
            expect(service.backoffMs(99)).toBe(1800000);
        });
    });
});
