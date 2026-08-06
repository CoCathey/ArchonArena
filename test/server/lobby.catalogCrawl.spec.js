const Lobby = require('../../server/lobby');
const CatalogService = require('../../server/services/catalog/CatalogService');

// These exercise the real Lobby.runCatalogCrawl against a minimal `this`,
// without standing up the full Lobby (socket.io server, DB services).
//
// The seam is the point. Both sides of it were unit-tested and green while the
// lobby called a method the service did not have: the sweep threw a TypeError
// on every tick, the catch logged it, and the catalog silently stayed empty
// forever. Nothing that tested CatalogService alone, or the lobby against a
// hand-written stub, could see that - so these run the lobby method against a
// REAL CatalogService.

describe('Lobby.runCatalogCrawl', function () {
    let logged;
    let lobby;

    const configService = (catalog) => ({
        getValue: (key) => (key === 'catalog' ? catalog : undefined)
    });

    const settingsService = { getSection: () => ({}) };

    const makeLobby = (catalogService, lastRunMs = 0) => ({
        catalogService,
        lastCatalogCrawlMs: lastRunMs,
        runCatalogCrawl: Lobby.prototype.runCatalogCrawl
    });

    beforeEach(function () {
        logged = { info: [], error: [] };
        const logger = require('../../server/log');
        vi.spyOn(logger, 'info').mockImplementation((msg) => logged.info.push(msg));
        vi.spyOn(logger, 'error').mockImplementation((msg) => logged.error.push(msg));
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    // The regression that motivated this file: the crawl entry point the lobby
    // reaches for has to exist on the service it is actually handed.
    it('calls a crawl method the real CatalogService defines', async function () {
        const service = new CatalogService(
            configService({ enabled: true, crawlIntervalMinutes: 15 }),
            { query: vi.fn().mockResolvedValue([]) },
            settingsService
        );
        const crawl = vi.spyOn(service, 'crawlOnce').mockResolvedValue({ indexed: 0 });

        lobby = makeLobby(service);
        await lobby.runCatalogCrawl();

        expect(crawl).toHaveBeenCalled();
        expect(logged.error).toEqual([]);
    });

    // A default install has the crawl off. It must cost nothing and, above all,
    // must not file an error every interval for a feature nobody enabled.
    it('stays silent when the crawl is turned off', async function () {
        const service = new CatalogService(
            configService({ enabled: false, crawlIntervalMinutes: 15 }),
            { query: vi.fn().mockResolvedValue([]) },
            settingsService
        );

        lobby = makeLobby(service);
        await lobby.runCatalogCrawl();

        expect(logged.error).toEqual([]);
        expect(logged.info).toEqual([]);
    });

    it('waits out the configured interval between runs', async function () {
        const service = new CatalogService(
            configService({ enabled: true, crawlIntervalMinutes: 15 }),
            { query: vi.fn().mockResolvedValue([]) },
            settingsService
        );
        const crawl = vi.spyOn(service, 'crawlOnce').mockResolvedValue({ indexed: 0 });

        lobby = makeLobby(service, Date.now());
        await lobby.runCatalogCrawl();

        expect(crawl).not.toHaveBeenCalled();
    });

    it('never lets a failing crawl escape into the lobby tick', async function () {
        const service = new CatalogService(
            configService({ enabled: true, crawlIntervalMinutes: 15 }),
            { query: vi.fn().mockResolvedValue([]) },
            settingsService
        );
        vi.spyOn(service, 'crawlOnce').mockRejectedValue(new Error('boom'));

        lobby = makeLobby(service);

        await expect(lobby.runCatalogCrawl()).resolves.toBeUndefined();
        expect(logged.error.length).toBe(1);
    });
});
