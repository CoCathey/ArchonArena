const DokService = require('../../../../server/services/dok/DokService');

describe('DokService', function () {
    let service;
    let db;
    let config;
    let fetchMock;

    const enabledConfig = {
        enabled: true,
        apiKey: 'test-key',
        apiUrl: 'https://dok.example/public-api/v3/decks/',
        requestTimeoutMs: 1000,
        refreshDays: 30
    };

    const uuid = (n) => `${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;

    const configService = () => ({
        getValue: (key) => (key === 'dok' ? config : undefined)
    });

    beforeEach(function () {
        config = { ...enabledConfig };
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new DokService(configService(), db);
        fetchMock = vi.spyOn(global, 'fetch');
        // Shared rate-limit window is process-wide - clear it per test.
        DokService._resetRateLimiter();
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
                'https://dok.example/public-api/v3/decks/uuid-1',
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

            expect(db.query).not.toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO "DeckSas"'),
                expect.anything()
            );
        });

        it('skips the API call when fresh stats already exist', async function () {
            db.query.mockResolvedValue([
                { Uuid: 'uuid-1', SasRating: 70, AercScore: 65, FetchedAt: new Date() }
            ]);

            await service.enrichDeck('uuid-1');

            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('swallows database errors', async function () {
            mockDokResponse({ sasRating: 70 });
            db.query.mockRejectedValue(new Error('db down'));

            await expect(service.enrichDeck('uuid-1')).resolves.toBeUndefined();
        });
    });

    describe('listOwnerDecks', function () {
        const mockPages = (pages) => {
            let call = 0;
            fetchMock.mockImplementation(async () => ({
                ok: true,
                json: async () => ({ decks: pages[call++] || [] })
            }));
        };

        it('derives the filter URL from the apiUrl origin and posts the owner', async function () {
            mockPages([[{ keyforgeId: uuid(1), name: 'Deck One', sasRating: 70.4 }], []]);

            const result = await service.listOwnerDecks('someplayer');

            expect(result.configured).toBe(true);
            expect(result.decks).toEqual([{ uuid: uuid(1), name: 'Deck One', sasRating: 70 }]);
            expect(fetchMock).toHaveBeenCalledWith(
                'https://dok.example/public-api/v1/decks/filter',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({ 'Api-Key': 'test-key' })
                })
            );
            const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
            expect(firstBody.owner).toBe('someplayer');
            expect(firstBody.page).toBe(0);
        });

        it('pages until the collection runs dry and dedupes ids', async function () {
            mockPages([
                [
                    { keyforgeId: uuid(1), name: 'A', sasRating: 60 },
                    { keyforgeId: uuid(2), name: 'B', sasRating: 61 }
                ],
                [
                    { keyforgeId: uuid(2), name: 'B dup', sasRating: 61 },
                    { keyforgeId: uuid(3), name: 'C', sasRating: 62 }
                ],
                []
            ]);

            const result = await service.listOwnerDecks('p');

            expect(result.decks.map((d) => d.uuid)).toEqual([uuid(1), uuid(2), uuid(3)]);
        });

        it('honours the maxDecks cap and reports truncation', async function () {
            mockPages([
                [{ keyforgeId: uuid(1) }, { keyforgeId: uuid(2) }, { keyforgeId: uuid(3) }]
            ]);

            const result = await service.listOwnerDecks('p', { maxDecks: 2 });

            expect(result.decks).toHaveLength(2);
            expect(result.truncated).toBe(true);
        });

        it('skips deck entries without a valid Master Vault uuid', async function () {
            mockPages([
                [
                    { id: 12345, name: 'no keyforge id' },
                    { keyforgeId: uuid(5), name: 'good' }
                ],
                []
            ]);

            const result = await service.listOwnerDecks('p');

            expect(result.decks).toEqual([{ uuid: uuid(5), name: 'good', sasRating: null }]);
        });

        it('reports an error when the first page fails', async function () {
            fetchMock.mockResolvedValue({ ok: false, status: 500 });

            const result = await service.listOwnerDecks('p');

            expect(result).toMatchObject({ configured: true, error: true });
            expect(result.errorDetail).toContain('HTTP 500');
        });

        it('surfaces a helpful hint for auth and endpoint failures', async function () {
            fetchMock.mockResolvedValue({ ok: false, status: 401 });
            expect((await service.listOwnerDecks('p')).errorDetail).toContain('API key rejected');

            fetchMock.mockResolvedValue({ ok: false, status: 404 });
            expect((await service.listOwnerDecks('p')).errorDetail).toContain(
                'filterUrl may be wrong'
            );
        });

        it('reports a connection failure detail', async function () {
            fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

            const result = await service.listOwnerDecks('p');

            expect(result.error).toBe(true);
            expect(result.errorDetail).toContain('could not connect');
        });

        it('returns a partial list when a later page fails', async function () {
            let call = 0;
            fetchMock.mockImplementation(async () => {
                call++;
                if (call === 1) {
                    return { ok: true, json: async () => ({ decks: [{ keyforgeId: uuid(1) }] }) };
                }
                return { ok: false, status: 502 };
            });

            const result = await service.listOwnerDecks('p');

            expect(result.error).toBeUndefined();
            expect(result.decks).toEqual([{ uuid: uuid(1), name: null, sasRating: null }]);
        });

        it('does not call the API when DoK is disabled', async function () {
            config.enabled = false;

            const result = await service.listOwnerDecks('p');

            expect(result).toEqual({ configured: false, decks: [] });
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('caches SAS from the filter response with no extra API calls', async function () {
            mockPages([[{ keyforgeId: uuid(1), name: 'A', sasRating: 65 }], []]);

            await service.listOwnerDecks('p');

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('ON CONFLICT ("Uuid") DO NOTHING'),
                expect.arrayContaining([uuid(1), 65])
            );
        });
    });

    describe('rate limiting', function () {
        it('reserves up to the configured number of requests per minute', function () {
            config.maxRequestsPerMinute = 3;

            expect(service.reserveRequestSlot()).toBe(true);
            expect(service.reserveRequestSlot()).toBe(true);
            expect(service.reserveRequestSlot()).toBe(true);
            expect(service.reserveRequestSlot()).toBe(false);
        });

        it('defaults to 25 requests per minute when unconfigured', function () {
            delete config.maxRequestsPerMinute;

            expect(service.getRateLimit()).toBe(25);
        });

        it('skips best-effort SAS fetches once the budget is spent', async function () {
            config.maxRequestsPerMinute = 1;
            mockDokResponse({ sasRating: 70 });

            expect(await service.fetchDeckStats('uuid-1')).not.toBeNull();
            expect(await service.fetchDeckStats('uuid-2')).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('gives up waiting for a slot when the budget stays spent', async function () {
            config.maxRequestsPerMinute = 1;

            expect(service.reserveRequestSlot()).toBe(true);
            expect(await service.waitForRequestSlot(0)).toBe(false);
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
