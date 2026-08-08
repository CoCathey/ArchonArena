const Lobby = require('../../server/lobby');
const TournamentService = require('../../server/services/tournament/TournamentService');

/**
 * ARCHON (N14): the lobby's asynchronous-tournament deadline tick.
 *
 * This holds the REAL Lobby.runRoundDeadlineSweep against the REAL
 * TournamentService, in the same style as the crawl and import-sweep specs -
 * because the bug this catches has already shipped twice on this project: an
 * interval wired to a service method that does not exist, both halves unit
 * tested and green, the sweep throwing a TypeError into its own catch on every
 * tick forever. Only a test holding both real halves can see that.
 */
describe('Lobby.runRoundDeadlineSweep', function () {
    let db;
    let tournamentService;

    const makeLobby = (service) => ({
        tournamentService: service,
        runRoundDeadlineSweep: Lobby.prototype.runRoundDeadlineSweep
    });

    beforeEach(function () {
        db = { query: vi.fn().mockResolvedValue([]) };
        tournamentService = new TournamentService(db, {
            settingsService: { getSection: () => ({}) }
        });
    });

    it('calls a method the tournament service actually has', async function () {
        expect(typeof tournamentService.sweepRoundDeadlines).toBe('function');

        const lobby = makeLobby(tournamentService);

        await lobby.runRoundDeadlineSweep();

        // It reached the service and issued the scan, rather than dying in the
        // catch on an undefined method.
        expect(db.query).toHaveBeenCalled();
        expect(db.query.mock.calls[0][0]).toContain('"Pacing" = \'async\'');
    });

    it('asks only for active async events whose deadline has passed', async function () {
        const lobby = makeLobby(tournamentService);

        await lobby.runRoundDeadlineSweep();

        const [sql] = db.query.mock.calls[0];
        expect(sql).toContain('"Status" = \'active\'');
        expect(sql).toContain('"RoundEndsAt" <');
        expect(sql).toContain('"DeadlineNotifiedAt" IS NULL');
    });

    it('does nothing when there is no tournament service', async function () {
        const lobby = makeLobby(undefined);

        await expect(lobby.runRoundDeadlineSweep()).resolves.toBeUndefined();
    });

    it('does not run two sweeps at once', async function () {
        let release;
        db.query.mockImplementation(() => new Promise((resolve) => (release = () => resolve([]))));

        const lobby = makeLobby(tournamentService);
        const first = lobby.runRoundDeadlineSweep();

        // The in-flight flag is set synchronously, so a second tick landing
        // mid-sweep returns without starting a second scan.
        await lobby.runRoundDeadlineSweep();
        expect(db.query).toHaveBeenCalledTimes(1);

        release();
        await first;
    });

    // A failing sweep must not take the interval down with it: the next tick
    // has to be able to try again.
    it('survives a database failure', async function () {
        db.query.mockRejectedValue(new Error('db down'));

        const lobby = makeLobby(tournamentService);

        await expect(lobby.runRoundDeadlineSweep()).resolves.toBeUndefined();

        db.query.mockResolvedValue([]);
        await lobby.runRoundDeadlineSweep();

        expect(db.query).toHaveBeenCalledTimes(2);
    });
});
