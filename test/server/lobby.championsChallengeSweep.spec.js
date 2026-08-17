const Lobby = require('../../server/lobby');
const ChampionsChallengeService = require('../../server/services/championschallenge/ChampionsChallengeService');

// The real Lobby.runChampionsChallengeSweep against a REAL ChampionsChallengeService
// with a mocked db - the same seam the deck-import sweep pins, for the same
// reason: an interval wired to a method the service does not define is green
// in both halves' unit tests and a TypeError every tick in production.

describe('Lobby.runChampionsChallengeSweep', function () {
    let logged;
    let db;
    let service;
    let config;

    const configService = { getValue: () => ({}) };
    const settingsService = {
        getSectionWithDefaults: (name) => (name === 'championsChallenge' ? { ...config } : {}),
        getSection: () => ({})
    };

    const makeLobby = (championsChallengeService, lastSweepMs = 0) => ({
        championsChallengeService,
        lastChampionsChallengeSweepMs: lastSweepMs,
        runChampionsChallengeSweep: Lobby.prototype.runChampionsChallengeSweep
    });

    beforeEach(function () {
        logged = { info: [], warn: [], error: [] };
        const logger = require('../../server/log');
        vi.spyOn(logger, 'info').mockImplementation((msg) => logged.info.push(msg));
        vi.spyOn(logger, 'warn').mockImplementation((msg) => logged.warn.push(msg));
        vi.spyOn(logger, 'error').mockImplementation((msg) => logged.error.push(msg));

        config = {
            enabled: true,
            sweepIntervalSeconds: 60,
            gamesPerSweep: 2,
            gamesPerDeckPerDay: 12,
            maxEnrolledPerUser: 8,
            maxTurnsPerGame: 80
        };
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new ChampionsChallengeService(configService, db, settingsService);
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    // The regression this file exists to prevent.
    it('is a method the lobby actually defines', function () {
        expect(typeof Lobby.prototype.runChampionsChallengeSweep).toBe('function');
    });

    it('calls a sweep method the real service defines', async function () {
        const runSweep = vi.spyOn(service, 'runSweep').mockResolvedValue({
            played: 1,
            abandoned: 0
        });

        await makeLobby(service).runChampionsChallengeSweep();

        expect(runSweep).toHaveBeenCalled();
        expect(logged.info.join(' ')).toMatch(/played 1 simulated game/i);
        expect(logged.error).toEqual([]);
    });

    it('does nothing for a lobby built without the service', async function () {
        const lobby = makeLobby(null);

        await expect(lobby.runChampionsChallengeSweep()).resolves.toBeUndefined();
    });

    it('waits out the admin-configured cadence between sweeps', async function () {
        const runSweep = vi.spyOn(service, 'runSweep').mockResolvedValue({
            played: 0,
            abandoned: 0
        });

        await makeLobby(service, Date.now()).runChampionsChallengeSweep();

        expect(runSweep).not.toHaveBeenCalled();
    });

    it('reports abandoned games where an operator will see them', async function () {
        vi.spyOn(service, 'runSweep').mockResolvedValue({ played: 0, abandoned: 2 });

        await makeLobby(service).runChampionsChallengeSweep();

        expect(logged.warn.join(' ')).toMatch(/abandoned 2/i);
    });

    it('never lets a failing sweep escape into the lobby tick', async function () {
        vi.spyOn(service, 'runSweep').mockRejectedValue(new Error('boom'));

        const lobby = makeLobby(service);

        await expect(lobby.runChampionsChallengeSweep()).resolves.toBeUndefined();
        expect(logged.error.length).toBe(1);
    });
});
