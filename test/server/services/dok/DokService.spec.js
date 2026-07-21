const DokService = require('../../../../server/services/dok/DokService');

describe('DokService', function () {
    let service;
    let db;
    let config;
    let fetchMock;

    const enabledConfig = {
        enabled: true,
        apiKey: 'test-key',
        apiUrl: 'https://dok.example/decks/',
        requestTimeoutMs: 1000,
        refreshDays: 30
    };

    const configService = () => ({
        getValue: (key) => (key === 'dok' ? config : undefined)
    });

    beforeEach(function () {
        config = { ...enabledConfig };
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new DokService(configService(), db);
        fetchMock = vi.spyOn(global, 'fetch');
    });

    afterEach(function () {
        fetchMock.mockRestore();
    });

    const mockDokResponse = (deck) =>
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({ deck })
        });

    describe('isEnabled', function () {
        it('is enabled with a key and the enabled flag', function () {
            expect(service.isEnabled()).toBe(true);
        });

        it('is disabled without an api key', function () {
            config.apiKey = '';
            expect(service.isEnabled()).toBe(false);
        });

        it('is disabled when turned off by config', function () {
            config.enabled = false;
            expect(service.isEnabled()).toBe(false);
        });
    });

    describe('fetchDeckStats', function () {
        it('extracts and rounds stats from the DoK response', async function () {
            mockDokResponse({ sasRating: 74.6, aercScore: 68.2, aercVersion: 42 });

            const stats = await service.fetchDeckStats('uuid-1');

            expect(stats.sasRating).toBe(75);
            expect(stats.aercScore).toBe(68);
            expect(stats.aercVersion).toBe(42);
            expect(fetchMock).toHaveBeenCalledWith(
                'https://dok.example/decks/uuid-1',
                expect.objectContaining({ headers: { 'Api-Key': 'test-key' } })
            );
        });

        it('returns null when disabled without calling the API', async function () {
            config.enabled = false;

            expect(await service.fetchDeckStats('uuid-1')).toBeNull();
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('returns null on a non-2xx response', async function () {
            fetchMock.mockResolvedValue({ ok: false, status: 429 });

            expect(await service.fetchDeckStats('uuid-1')).toBeNull();
        });

        it('returns null when the network fails', async function () {
            fetchMock.mockRejectedValue(new Error('boom'));

            expect(await service.fetchDeckStats('uuid-1')).toBeNull();
        });

        it('returns null when the response has no sas rating', async function () {
            mockDokResponse({ someOtherField: 1 });

            expect(await service.fetchDeckStats('uuid-1')).toBeNull();
        });
    });

    describe('enrichDeck', function () {
        it('stores fetched stats', async function () {
            mockDokResponse({ sasRating: 70, aercScore: 65, aercVersion: 40 });

            await service.enrichDeck('uuid-1');

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO "DeckSas"'),
                expect.arrayContaining(['uuid-1', 70, 65, 40])
            );
        });

        it('stores nothing when the fetch fails', async function () {
            fetchMock.mockRejectedValue(new Error('down'));

            await service.enrichDeck('uuid-1');

            expect(db.query).not.toHaveBeenCalled();
        });

        it('swallows database errors', async function () {
            mockDokResponse({ sasRating: 70 });
            db.query.mockRejectedValue(new Error('db down'));

            await expect(service.enrichDeck('uuid-1')).resolves.toBeUndefined();
        });
    });

    describe('needsRefresh', function () {
        it('wants a refresh when nothing was ever fetched', function () {
            expect(service.needsRefresh(null)).toBe(true);
        });

        it('does not refresh fresh rows', function () {
            expect(service.needsRefresh(new Date().toISOString())).toBe(false);
        });

        it('refreshes rows older than the configured window', function () {
            const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
            expect(service.needsRefresh(old.toISOString())).toBe(true);
        });
    });

    describe('attachStats', function () {
        it('attaches stored stats to matching decks', async function () {
            db.query.mockResolvedValue([
                { Uuid: 'uuid-1', SasRating: 72, AercScore: 66, FetchedAt: new Date() }
            ]);

            const decks = [{ uuid: 'uuid-1' }, { uuid: 'uuid-2' }];
            await service.attachStats(decks);

            expect(decks[0].sasRating).toBe(72);
            expect(decks[0].aercScore).toBe(66);
            expect(decks[1].sasRating).toBeUndefined();
        });

        it('kicks off background fetches for missing decks when enabled', async function () {
            db.query.mockResolvedValue([]);
            const enrich = vi.spyOn(service, 'enrichDeck').mockResolvedValue();

            await service.attachStats([{ uuid: 'uuid-1' }, { uuid: 'uuid-2' }]);

            expect(enrich).toHaveBeenCalledWith('uuid-1');
            expect(enrich).toHaveBeenCalledWith('uuid-2');
        });

        it('bounds the number of background fetches per call', async function () {
            db.query.mockResolvedValue([]);
            const enrich = vi.spyOn(service, 'enrichDeck').mockResolvedValue();

            const decks = Array.from({ length: 10 }, (_, i) => ({ uuid: `uuid-${i}` }));
            await service.attachStats(decks, { maxBackgroundFetches: 3 });

            expect(enrich).toHaveBeenCalledTimes(3);
        });

        it('never fetches in the background when disabled', async function () {
            config.enabled = false;
            db.query.mockResolvedValue([]);
            const enrich = vi.spyOn(service, 'enrichDeck');

            await service.attachStats([{ uuid: 'uuid-1' }]);

            expect(enrich).not.toHaveBeenCalled();
        });

        it('handles decks without uuids and db failures gracefully', async function () {
            db.query.mockRejectedValue(new Error('db down'));

            const decks = [{ uuid: 'uuid-1' }, { name: 'no uuid' }];
            await expect(service.attachStats(decks)).resolves.toBe(decks);
        });
    });
});
