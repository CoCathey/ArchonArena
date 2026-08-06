const Lobby = require('../../server/lobby');
const DeckImportJobService = require('../../server/services/deckimport/DeckImportJobService');

// These run the real Lobby.runDeckImportSweep against a REAL DeckImportJobService
// and a stub DeckService, without standing up the full Lobby.
//
// The seam is the point, and it has already bitten once: the catalog crawl
// shipped with the lobby calling a method the service did not define, both
// sides unit-tested and green, the sweep throwing a TypeError into its own
// catch on every tick. Exactly the same thing happened again while this file
// was being written - the interval was wired before the method existed. A test
// that stubs the service cannot see that; only one that holds both real halves
// can.

describe('Lobby.runDeckImportSweep', function () {
    let logged;
    let db;
    let deckImportService;

    const configService = (deckImport) => ({
        getValue: (key) => (key === 'deckImport' ? deckImport : undefined)
    });

    const settingsService = { getSection: () => ({}) };

    const uuid = (n) => `${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;

    const jobRow = (overrides = {}) => ({
        Id: 7,
        UserId: 3,
        Username: 'player',
        Status: 'running',
        Uuids: JSON.stringify([uuid(1), uuid(2), uuid(3)]),
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

    // claimNextJob is the only read the sweep makes; everything else is a write.
    const withJob = (job) =>
        db.query.mockImplementation(async (sql) =>
            sql.includes('UPDATE') && sql.includes('RETURNING') && sql.includes("'running'")
                ? [job]
                : []
        );

    const makeLobby = (deckService, service) => ({
        deckImportService: service,
        deckService,
        lastDeckImportSweepMs: 0,
        sleep: () => Promise.resolve(),
        runDeckImportSweep: Lobby.prototype.runDeckImportSweep
    });

    const writesMatching = (fragment) =>
        db.query.mock.calls.filter(([sql]) => sql.includes(fragment));

    beforeEach(function () {
        logged = { info: [], error: [] };
        const logger = require('../../server/log');
        vi.spyOn(logger, 'info').mockImplementation((msg) => logged.info.push(msg));
        vi.spyOn(logger, 'error').mockImplementation((msg) => logged.error.push(msg));

        db = { query: vi.fn().mockResolvedValue([]) };
        deckImportService = new DeckImportJobService(
            configService({ enabled: true, decksPerTick: 5, requestSpacingMs: 0 }),
            db,
            settingsService
        );
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    // The regression that motivated this file.
    it('is a method the lobby actually defines', function () {
        expect(typeof Lobby.prototype.runDeckImportSweep).toBe('function');
    });

    it('imports the batch and finishes a job it completes', async function () {
        withJob(jobRow());
        const deckService = { create: vi.fn().mockResolvedValue({ success: true }) };

        await makeLobby(deckService, deckImportService).runDeckImportSweep();

        expect(deckService.create).toHaveBeenCalledTimes(3);
        // Imported under the job's user, not some ambient one.
        expect(deckService.create.mock.calls[0][0]).toEqual({ id: 3, username: 'player' });
        expect(writesMatching('"Status" = $2').length).toBeGreaterThan(0);
        expect(logged.error).toEqual([]);
    });

    it('counts a deck the player already owns apart from a failure', async function () {
        withJob(jobRow({ Uuids: JSON.stringify([uuid(1)]) }));
        const deckService = {
            create: vi.fn().mockResolvedValue({ success: false, message: 'Deck already exists.' })
        };

        await makeLobby(deckService, deckImportService).runDeckImportSweep();

        const [, params] = writesMatching('"AlreadyOwned"')[0];
        // recordProgress writes cursor, imported, alreadyOwned, failed, reasons.
        // [jobId, cursor, imported, alreadyOwned, failed]
        expect(params.slice(0, 5)).toEqual([7, 1, 0, 1, 0]);
    });

    // The load-bearing property: a throttled deck must be retried, not lost.
    it('stops on a rate limit without advancing past the deck it never read', async function () {
        withJob(jobRow());
        const rateLimited = Object.assign(new Error('Master Vault is rate limiting'), {
            code: 'upstream_rate_limited'
        });
        const deckService = {
            create: vi
                .fn()
                .mockResolvedValueOnce({ success: true })
                .mockRejectedValueOnce(rateLimited)
        };

        await makeLobby(deckService, deckImportService).runDeckImportSweep();

        // Two attempts: one imported, one refused. The cursor advances by ONE.
        expect(deckService.create).toHaveBeenCalledTimes(2);
        // Matched on the pause-specific placeholder: recordProgress mentions
        // "PausedUntil" too, because success is what clears it.
        const paused = writesMatching('"PausedUntil" = $8')[0];
        // params[1] is the cursor: one deck consumed, not two.
        expect(paused[1][1]).toBe(1);
        expect(logged.info.join(' ')).toMatch(/paused/i);
    });

    it('does nothing when there is no job to claim', async function () {
        db.query.mockResolvedValue([]);
        const deckService = { create: vi.fn() };

        await makeLobby(deckService, deckImportService).runDeckImportSweep();

        expect(deckService.create).not.toHaveBeenCalled();
        expect(logged.error).toEqual([]);
    });

    it('does nothing while the feature is switched off', async function () {
        const off = new DeckImportJobService(
            configService({ enabled: false }),
            db,
            settingsService
        );
        const deckService = { create: vi.fn() };

        await makeLobby(deckService, off).runDeckImportSweep();

        expect(db.query).not.toHaveBeenCalled();
    });

    it('never lets a failure escape into the lobby tick', async function () {
        withJob(jobRow());
        const deckService = {
            create: vi.fn().mockRejectedValue(new Error('boom'))
        };

        const lobby = makeLobby(deckService, deckImportService);

        await expect(lobby.runDeckImportSweep()).resolves.toBeUndefined();
    });
});
