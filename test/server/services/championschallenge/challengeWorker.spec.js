const ChampionsChallengeService = require('../../../../server/services/championschallenge/ChampionsChallengeService');
const ChallengeWorker = require('../../../../server/challengeworker/ChallengeWorker');

/**
 * ARCHON (N24): the Champion's Challenge on a node of its own.
 *
 * Sparring is solid CPU with nobody waiting on it, so it can be moved off the
 * lobby. The moment that is possible, two processes can both believe it is their
 * job - and a doubled sweeper is not a harmless duplicate: every deck would
 * quietly play twice its daily budget, in results nobody can audit.
 *
 * So what is pinned here is the mutual exclusion, not the plumbing:
 *
 *  - the lease is claimed in ONE statement, with no read-then-write window;
 *  - a process that cannot get the lease does not sweep;
 *  - a process that is not the configured host does not even try;
 *  - a database that cannot answer means NOBODY sweeps (a quiet lab is
 *    recoverable; a double-played one corrupts the numbers);
 *  - a misconfigured value falls back to the lobby, which is how this shipped -
 *    a typo must not stop every member's games silently.
 */
describe('Champion’s Challenge sweep hosting', function () {
    let db;
    let service;
    let config;

    const configService = { getValue: () => ({}) };
    const settingsService = {
        getSectionWithDefaults: () => ({ ...config }),
        getSection: () => ({})
    };

    beforeEach(function () {
        config = { enabled: true, sweepOwner: 'lobby', sweepLeaseSeconds: 120 };
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new ChampionsChallengeService(configService, db, settingsService);
        service.runSweep = vi.fn().mockResolvedValue({ played: 3, abandoned: 0 });
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    describe('the lease', function () {
        it('claims it in a single atomic statement', async function () {
            db.query.mockResolvedValue([{ Owner: 'worker@host:1' }]);

            expect(await service.claimSweepLease('worker@host:1', 120)).toBe(true);

            const [sql, params] = db.query.mock.calls[0];

            // One statement: the upsert either wins or returns nothing. A
            // SELECT-then-UPDATE would leave a window for a second sweeper.
            expect(db.query).toHaveBeenCalledTimes(1);
            expect(sql).toContain('INSERT INTO "ChallengeSweepLease"');
            expect(sql).toContain('ON CONFLICT');
            expect(sql).toContain('RETURNING');
            expect(params).toEqual(['worker@host:1', 120]);
        });

        it('renews its own lease and takes over a stale one', async function () {
            db.query.mockResolvedValue([{ Owner: 'me' }]);

            await service.claimSweepLease('me', 120);

            const [sql] = db.query.mock.calls[0];

            expect(sql).toContain('"ChallengeSweepLease"."Owner" = $1');
            expect(sql).toContain('"HeartbeatAt" <');
        });

        it('refuses when another process holds a fresh lease', async function () {
            // No row returned: the WHERE clause rejected the takeover.
            db.query.mockResolvedValue([]);

            expect(await service.claimSweepLease('me', 120)).toBe(false);
        });

        it('refuses rather than risk two sweepers when the database errors', async function () {
            db.query.mockRejectedValue(new Error('connection lost'));

            expect(await service.claimSweepLease('me', 120)).toBe(false);
        });

        it('holds a floor under the lease window', async function () {
            db.query.mockResolvedValue([{ Owner: 'me' }]);

            await service.claimSweepLease('me', 1);

            // A one-second lease would let a slow sweep lose its own lease
            // mid-game and a second process start playing over the top of it.
            expect(db.query.mock.calls[0][1][1]).toBe(30);
        });
    });

    describe('which node plays', function () {
        it('lets the lobby sweep by default', function () {
            config.sweepOwner = undefined;

            expect(service.maySweepAs('lobby')).toBe(true);
            expect(service.maySweepAs('worker')).toBe(false);
        });

        it('hands the sweep to the worker when configured', function () {
            config.sweepOwner = 'worker';

            expect(service.maySweepAs('worker')).toBe(true);
            expect(service.maySweepAs('lobby')).toBe(false);
        });

        it('lets either node race for it on "any"', function () {
            config.sweepOwner = 'any';

            expect(service.maySweepAs('lobby')).toBe(true);
            expect(service.maySweepAs('worker')).toBe(true);
        });

        // A typo must not silently stop every member's games.
        it('falls back to the lobby on an unrecognised value', function () {
            config.sweepOwner = 'wokrer';

            expect(service.maySweepAs('lobby')).toBe(true);
            expect(service.maySweepAs('worker')).toBe(false);
        });
    });

    describe('runSweepAs', function () {
        it('sweeps when it is the configured host and gets the lease', async function () {
            db.query.mockResolvedValue([{ Owner: 'lobby@host' }]);

            expect(await service.runSweepAs('lobby', 'lobby@host')).toEqual({
                played: 3,
                abandoned: 0
            });
            expect(service.runSweep).toHaveBeenCalled();
        });

        it('does not even ask for the lease on the wrong node', async function () {
            config.sweepOwner = 'worker';

            expect(await service.runSweepAs('lobby', 'lobby@host')).toEqual({
                played: 0,
                abandoned: 0,
                skipped: 'not-this-node'
            });
            expect(db.query).not.toHaveBeenCalled();
            expect(service.runSweep).not.toHaveBeenCalled();
        });

        it('stands down when the lease is held elsewhere', async function () {
            db.query.mockResolvedValue([]);

            expect(await service.runSweepAs('lobby', 'lobby@host')).toEqual({
                played: 0,
                abandoned: 0,
                skipped: 'lease-held-elsewhere'
            });
            expect(service.runSweep).not.toHaveBeenCalled();
        });
    });

    describe('the worker process', function () {
        let worker;

        beforeEach(function () {
            config.sweepOwner = 'worker';
            worker = new ChallengeWorker({
                configService,
                championsChallengeService: service,
                owner: 'worker@test:1'
            });
        });

        afterEach(function () {
            worker.stop();
        });

        it('sweeps as the worker, under its own identity', async function () {
            service.runSweepAs = vi.fn().mockResolvedValue({ played: 1, abandoned: 0 });

            await worker.tick();

            expect(service.runSweepAs).toHaveBeenCalledWith('worker', 'worker@test:1');
        });

        it('keeps ticking after a sweep throws', async function () {
            service.runSweepAs = vi.fn().mockRejectedValue(new Error('engine exploded'));

            await worker.tick();

            expect(worker.running).toBe(false);
            expect(worker.timer).not.toBeNull();
        });

        // Overlap is impossible by construction: the next tick is scheduled only
        // once this one finishes, so a slow sweep slows the cadence rather than
        // stacking sweeps on top of each other.
        it('will not run two sweeps at once', async function () {
            let release;
            service.runSweepAs = vi.fn(
                () => new Promise((resolve) => (release = () => resolve({ played: 0 })))
            );

            const first = worker.tick();

            await worker.tick();

            expect(service.runSweepAs).toHaveBeenCalledTimes(1);

            release();
            await first;
        });

        it('stops ticking when told to', async function () {
            service.runSweepAs = vi.fn().mockResolvedValue({ played: 0, abandoned: 0 });

            worker.stop();
            await worker.tick();

            expect(service.runSweepAs).not.toHaveBeenCalled();
            expect(worker.timer).toBeNull();
        });
    });
});
