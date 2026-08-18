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

            // Never throws - and now reports the failure rather than leaving a
            // caller unable to tell it from a deck that was enriched.
            await expect(service.enrichDeck('uuid-1')).resolves.toBe(false);
        });
    });

    describe('listMyDecks', function () {
        // DoK answers /my-decks with an array of PublicMyDeckInfo: ownership
        // flags wrapped around the deck itself.
        const entry = (deck) => ({ deck, ownedByMe: true });

        const mockPages = (pages) => {
            let call = 0;
            fetchMock.mockImplementation(async () => ({
                ok: true,
                json: async () => (pages[call++] || []).map(entry)
            }));
        };

        it('derives the my-decks URL from the apiUrl origin and sends the user key', async function () {
            mockPages([[{ keyforgeId: uuid(1), name: 'Deck One', sasRating: 70.4 }], []]);

            const result = await service.listMyDecks('user-key');

            expect(result.configured).toBe(true);
            expect(result.decks).toEqual([{ uuid: uuid(1), name: 'Deck One', sasRating: 70 }]);
            expect(fetchMock).toHaveBeenCalledWith(
                'https://dok.example/public-api/v1/my-decks?page=0',
                expect.objectContaining({
                    method: 'GET',
                    headers: { 'Api-Key': 'user-key' }
                })
            );
        });

        it('prefers an explicitly configured my-decks URL', async function () {
            config.myDecksUrl = 'https://other.example/api/mine';
            mockPages([[], []]);

            await service.listMyDecks('user-key');

            expect(fetchMock).toHaveBeenCalledWith(
                'https://other.example/api/mine?page=0',
                expect.anything()
            );
        });

        it('reads the deck out of the wrapper and tolerates a flat entry', async function () {
            fetchMock.mockImplementation(async () => ({
                ok: true,
                json: async () => [
                    { deck: { keyforgeId: uuid(1), name: 'Wrapped', sasRating: 70.6 } },
                    { keyforgeId: uuid(2), name: 'Flat', sasRating: 61.2 }
                ]
            }));

            const result = await service.listMyDecks('user-key', { maxDecks: 2 });

            expect(result.decks).toEqual([
                { uuid: uuid(1), name: 'Wrapped', sasRating: 71 },
                { uuid: uuid(2), name: 'Flat', sasRating: 61 }
            ]);
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

            const result = await service.listMyDecks('user-key');

            expect(result.decks.map((d) => d.uuid)).toEqual([uuid(1), uuid(2), uuid(3)]);
            expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
                'https://dok.example/public-api/v1/my-decks?page=0',
                'https://dok.example/public-api/v1/my-decks?page=1',
                'https://dok.example/public-api/v1/my-decks?page=2'
            ]);
        });

        it('honours the maxDecks cap and reports truncation', async function () {
            mockPages([
                [{ keyforgeId: uuid(1) }, { keyforgeId: uuid(2) }, { keyforgeId: uuid(3) }]
            ]);

            const result = await service.listMyDecks('user-key', { maxDecks: 2 });

            expect(result.decks).toHaveLength(2);
            expect(result.truncated).toBe(true);
        });

        // A collection that is exactly the cap came back whole. Calling it
        // truncated sends the player back for decks that do not exist.
        it('does not call a collection that exactly fills the cap truncated', async function () {
            mockPages([[{ keyforgeId: uuid(1) }, { keyforgeId: uuid(2) }], []]);

            const result = await service.listMyDecks('user-key', { maxDecks: 2 });

            expect(result.decks).toHaveLength(2);
            expect(result.truncated).toBe(false);
        });

        // The cap counts decks still to import, not decks DoK reported, so the
        // run after a truncated one returns the decks the first one refused.
        it('lets a capped sync continue where the last one stopped', async function () {
            const page = [
                { keyforgeId: uuid(1) },
                { keyforgeId: uuid(2) },
                { keyforgeId: uuid(3) },
                { keyforgeId: uuid(4) }
            ];

            mockPages([page, []]);
            const first = await service.listMyDecks('user-key', { maxDecks: 2 });

            expect(first.decks.map((deck) => deck.uuid)).toEqual([uuid(1), uuid(2)]);
            expect(first.truncated).toBe(true);

            mockPages([page, []]);
            const second = await service.listMyDecks('user-key', {
                maxDecks: 2,
                skipUuids: new Set([uuid(1), uuid(2)])
            });

            expect(second.decks.map((deck) => deck.uuid)).toEqual([uuid(3), uuid(4)]);
            expect(second.skipped).toBe(2);
            expect(second.truncated).toBe(false);
        });

        it('counts decks the caller already owns without importing them', async function () {
            mockPages([[{ keyforgeId: uuid(1) }, { keyforgeId: uuid(2) }], []]);

            const result = await service.listMyDecks('user-key', {
                skipUuids: [uuid(1)]
            });

            expect(result.decks.map((deck) => deck.uuid)).toEqual([uuid(2)]);
            expect(result.skipped).toBe(1);
        });

        // Paging on the parsed array would let one unreadable page end the
        // listing, quietly dropping every deck after it.
        it('keeps paging past a page whose rows could not be read', async function () {
            mockPages([
                [{ keyforgeId: uuid(1) }],
                [{ id: 'no keyforge id' }, { keyforgeId: 'not-a-uuid' }],
                [{ keyforgeId: uuid(3) }],
                []
            ]);

            const result = await service.listMyDecks('user-key');

            expect(result.decks.map((deck) => deck.uuid)).toEqual([uuid(1), uuid(3)]);
        });

        // A cut-off collection presented as a whole one reads as "you own 100
        // decks" to someone who owns 700.
        it('flags a listing cut short by a failing page', async function () {
            let call = 0;
            fetchMock.mockImplementation(async () => {
                call++;
                if (call === 1) {
                    return { ok: true, json: async () => [{ keyforgeId: uuid(1) }] };
                }

                return { ok: false, status: 502 };
            });

            const result = await service.listMyDecks('user-key');

            expect(result.error).toBeUndefined();
            expect(result.partial).toBe(true);
            expect(result.decks).toHaveLength(1);
        });

        it('skips deck entries without a valid Master Vault uuid', async function () {
            mockPages([
                [
                    { id: 12345, name: 'no keyforge id' },
                    { keyforgeId: 'not-a-uuid', name: 'junk id' },
                    { keyforgeId: uuid(5), name: 'good' }
                ],
                []
            ]);

            const result = await service.listMyDecks('user-key');

            expect(result.decks).toEqual([{ uuid: uuid(5), name: 'good', sasRating: null }]);
        });

        it('reports an error when the first page fails', async function () {
            fetchMock.mockResolvedValue({ ok: false, status: 500 });

            const result = await service.listMyDecks('user-key');

            expect(result).toMatchObject({ configured: true, error: true });
            expect(result.errorDetail).toContain('HTTP 500');
        });

        it('surfaces a helpful hint for auth, endpoint and rate-limit failures', async function () {
            fetchMock.mockResolvedValue({ ok: false, status: 401 });
            expect((await service.listMyDecks('user-key')).errorDetail).toContain(
                'API key rejected'
            );

            fetchMock.mockResolvedValue({ ok: false, status: 404 });
            expect((await service.listMyDecks('user-key')).errorDetail).toContain(
                'endpoint not found'
            );

            fetchMock.mockResolvedValue({ ok: false, status: 429 });
            expect((await service.listMyDecks('user-key')).errorDetail).toContain('DoK rate limit');
        });

        it('reports a connection failure detail', async function () {
            fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

            const result = await service.listMyDecks('user-key');

            expect(result.error).toBe(true);
            expect(result.errorDetail).toContain('could not connect');
        });

        it('names a timeout rather than reporting a raw abort', async function () {
            const timeout = new Error('The operation was aborted due to timeout');
            timeout.name = 'TimeoutError';
            fetchMock.mockRejectedValue(timeout);

            expect((await service.listMyDecks('user-key')).errorDetail).toContain(
                'request timed out'
            );
        });

        it('rejects a response that is not an array of decks', async function () {
            fetchMock.mockResolvedValue({ ok: true, json: async () => ({ decks: [] }) });

            expect((await service.listMyDecks('user-key')).errorDetail).toContain(
                'unexpected response shape'
            );
        });

        it('returns a partial list when a later page fails', async function () {
            let call = 0;
            fetchMock.mockImplementation(async () => {
                call++;
                if (call === 1) {
                    return { ok: true, json: async () => [entry({ keyforgeId: uuid(1) })] };
                }
                return { ok: false, status: 502 };
            });

            const result = await service.listMyDecks('user-key');

            expect(result.error).toBeUndefined();
            expect(result.decks).toEqual([{ uuid: uuid(1), name: null, sasRating: null }]);
        });

        it('does not call the API when DoK is disabled', async function () {
            config.enabled = false;

            const result = await service.listMyDecks('user-key');

            expect(result).toEqual({ configured: false, decks: [] });
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('does not call the API without a user key', async function () {
            const result = await service.listMyDecks('   ');

            expect(result).toEqual({ configured: true, decks: [] });
            expect(fetchMock).not.toHaveBeenCalled();
        });

        // The whole point of /my-decks: it authenticates as the player, so a
        // site that never bought its own DoK key can still offer the import.
        it('works on a server with no site api key of its own', async function () {
            config.apiKey = '';
            mockPages([[{ keyforgeId: uuid(1), name: 'A', sasRating: 65 }], []]);

            const result = await service.listMyDecks('user-key');

            expect(service.isEnabled()).toBe(false);
            expect(result.decks).toEqual([{ uuid: uuid(1), name: 'A', sasRating: 65 }]);
            expect(fetchMock).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ headers: { 'Api-Key': 'user-key' } })
            );
        });

        it('caches SAS from the listing with no extra API calls', async function () {
            mockPages([[{ keyforgeId: uuid(1), name: 'A', sasRating: 65 }], []]);

            await service.listMyDecks('user-key');

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('ON CONFLICT ("Uuid") DO NOTHING'),
                expect.arrayContaining([uuid(1), 65])
            );
        });

        it('gives up a page rather than exceeding the user rate limit', async function () {
            const wait = vi.spyOn(service, 'waitForRequestSlot').mockResolvedValue(false);

            const result = await service.listMyDecks('user-key');

            expect(wait).toHaveBeenCalledWith(8000, 'user-key');
            expect(result.errorDetail).toBe('per-minute rate limit reached');
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });

    describe('rate limiting', function () {
        // Everyone runs at DoK's free tier. Config may lower it; nothing
        // may raise it, because these windows are per lobby process and the
        // tier a key actually holds is DoK's business rather than our config's.
        it('clamps a configured limit down to the free tier', function () {
            config.maxRequestsPerMinute = 250;

            expect(service.getRateLimit()).toBe(25);
        });

        it('still lets an operator go below the free tier', function () {
            config.maxRequestsPerMinute = 5;

            expect(service.getRateLimit()).toBe(5);
        });

        it('refuses a 26th request in a minute even when config says 250', function () {
            config.maxRequestsPerMinute = 250;

            for (let i = 0; i < 25; i++) {
                expect(service.reserveRequestSlot('a-key')).toBe(true);
            }

            expect(service.reserveRequestSlot('a-key')).toBe(false);
        });

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

        // The load-bearing property of the per-key window: DoK meters each key
        // separately, so a player paging their own collection must not eat into
        // the site key's budget for SAS enrichment (or any other player's).
        it('budgets each api key separately', async function () {
            config.maxRequestsPerMinute = 1;

            expect(service.reserveRequestSlot('user-a')).toBe(true);
            expect(service.reserveRequestSlot('user-a')).toBe(false);

            expect(service.reserveRequestSlot('user-b')).toBe(true);
            expect(service.reserveRequestSlot()).toBe(true);
            expect(service.reserveRequestSlot()).toBe(false);
            expect(await service.waitForRequestSlot(0, 'user-a')).toBe(false);
        });

        /**
         * ARCHON (N27): the headroom background work leaves for members.
         *
         * Two sweeps spend this budget on nobody's behalf - the stale-SAS
         * refresh, and the Gauntlet asking about the pool decks the Master Vault
         * crawl brought in. Both yield rather than queue, but yielding alone only
         * protects whoever asked FIRST: a sweep is otherwise entitled to the
         * minute's last slot, and a member arriving a second later gets nothing,
         * which from their side is indistinguishable from DoK being down.
         */
        describe('background headroom', function () {
            it('stops background work short of the last few requests', function () {
                config.maxRequestsPerMinute = 10;
                config.backgroundHeadroom = 3;

                for (let i = 0; i < 7; i++) {
                    expect(service.reserveRequestSlot(undefined, { headroom: 3 })).toBe(true);
                }

                expect(service.reserveRequestSlot(undefined, { headroom: 3 })).toBe(false);
                // The three it left are still there for a member.
                expect(service.reserveRequestSlot()).toBe(true);
                expect(service.reserveRequestSlot()).toBe(true);
                expect(service.reserveRequestSlot()).toBe(true);
                expect(service.reserveRequestSlot()).toBe(false);
            });

            it('defaults to holding five back', function () {
                expect(service.getBackgroundHeadroom()).toBe(5);
            });

            it('never holds back so much that a sweep cannot move at all', function () {
                config.maxRequestsPerMinute = 2;
                config.backgroundHeadroom = 25;

                expect(service.getBackgroundHeadroom()).toBe(1);
                expect(service.reserveRequestSlot(undefined, { headroom: 25 })).toBe(true);
            });

            it('takes a headroom of zero at face value', function () {
                config.maxRequestsPerMinute = 2;
                config.backgroundHeadroom = 0;

                expect(service.getBackgroundHeadroom()).toBe(0);
                expect(service.reserveRequestSlot(undefined, { headroom: 0 })).toBe(true);
                expect(service.reserveRequestSlot(undefined, { headroom: 0 })).toBe(true);
                expect(service.reserveRequestSlot()).toBe(false);
            });

            it('spends the headroom on a member-facing enrichment', async function () {
                config.maxRequestsPerMinute = 2;
                config.backgroundHeadroom = 1;
                mockDokResponse({ sasRating: 70 });

                // Background gets one of the two; the second is a member's.
                expect(await service.enrichDeck('uuid-1', { background: true })).toBe(true);
                expect(await service.enrichDeck('uuid-2', { background: true })).toBe(false);
                expect(await service.enrichDeck('uuid-3')).toBe(true);
            });

            it('reports whether stats were actually stored', async function () {
                fetchMock.mockResolvedValue({ ok: false, status: 404 });

                // DoK does not rate this deck. The caller has to be able to tell,
                // or it asks again on every sweep forever.
                expect(await service.enrichDeck('uuid-1')).toBe(false);
            });

            it('holds the refresh sweep to the same headroom', async function () {
                config.maxRequestsPerMinute = 3;
                config.backgroundHeadroom = 2;
                mockDokResponse({ sasRating: 70 });
                vi.spyOn(service, 'findStaleDeckUuids').mockResolvedValue(['a', 'b', 'c']);

                const result = await service.refreshStaleDecks();

                expect(result.attempted).toBe(1);
                expect(result.budgetExhausted).toBe(true);
            });
        });

        it('still enriches SAS after a user has spent their own key budget', async function () {
            config.maxRequestsPerMinute = 1;
            fetchMock.mockImplementation(async (url) =>
                String(url).includes('my-decks')
                    ? { ok: true, json: async () => [] }
                    : { ok: true, json: async () => ({ deck: { sasRating: 70 } }) }
            );

            await service.listMyDecks('user-key');

            expect(await service.fetchDeckStats('uuid-1')).not.toBeNull();
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

describe('DokService.getAercBreakdown', function () {
    const RAW = {
        amberControl: 8.4,
        expectedAmber: 9.1,
        artifactControl: 1.2,
        creatureControl: 6.7,
        efficiency: 4.3,
        recursion: 0.5,
        disruption: 2.1,
        effectivePower: 55,
        creatureProtection: 1.1,
        other: 0.3,
        sasPercentile: 72.4,
        synergyRating: 12,
        antisynergyRating: 3
    };

    const serviceWith = (rows) =>
        new DokService(
            { getValue: () => ({ enabled: false }) },
            { query: vi.fn(async () => rows) }
        );

    it('returns the components DoK supplied, in order', async function () {
        const service = serviceWith([
            { SasRating: 78, AercScore: 88, AercVersion: 24, RawData: RAW, FetchedAt: new Date() }
        ]);

        const aerc = await service.getAercBreakdown('deck-uuid');

        expect(aerc.sasRating).toBe(78);
        expect(aerc.aercScore).toBe(88);
        expect(aerc.components[0]).toEqual({
            key: 'amberControl',
            label: 'Amber Control',
            value: 8.4
        });
        expect(aerc.components).toHaveLength(10);
        expect(aerc.sasPercentile).toBe(72.4);
    });

    it('parses RawData when the driver hands back a JSON string', async function () {
        const service = serviceWith([
            {
                SasRating: 78,
                AercScore: 88,
                AercVersion: 24,
                RawData: JSON.stringify(RAW),
                FetchedAt: new Date()
            }
        ]);

        const aerc = await service.getAercBreakdown('deck-uuid');

        expect(aerc.components).toHaveLength(10);
    });

    // A missing component means DoK did not report it; showing 0 would claim
    // the deck has none of that quality, which is a different statement.
    it('omits components DoK did not supply rather than reporting zero', async function () {
        const service = serviceWith([
            {
                SasRating: 60,
                AercScore: 70,
                AercVersion: 24,
                RawData: { amberControl: 5, efficiency: 2 },
                FetchedAt: new Date()
            }
        ]);

        const aerc = await service.getAercBreakdown('deck-uuid');

        expect(aerc.components.map((c) => c.key)).toEqual(['amberControl', 'efficiency']);
        expect(aerc.sasPercentile).toBeNull();
    });

    it('returns null for a deck with no stored stats', async function () {
        expect(await serviceWith([]).getAercBreakdown('deck-uuid')).toBeNull();
    });

    it('returns null for a row with no RawData', async function () {
        const service = serviceWith([{ SasRating: 60, AercScore: 70, RawData: null }]);

        expect(await service.getAercBreakdown('deck-uuid')).toBeNull();
    });

    it('returns null without querying when no uuid is given', async function () {
        expect(await serviceWith([]).getAercBreakdown(undefined)).toBeNull();
    });
});

describe('DokService background SAS refresh sweep', function () {
    let service;
    let db;
    let config;
    let fetchMock;

    const uuid = (n) => `${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;

    beforeEach(function () {
        config = {
            enabled: true,
            apiKey: 'test-key',
            apiUrl: 'https://dok.example/public-api/v3/decks/',
            requestTimeoutMs: 1000,
            refreshDays: 30,
            maxRequestsPerMinute: 25,
            sweepBatchSize: 5
        };
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new DokService({ getValue: (key) => (key === 'dok' ? config : undefined) }, db);
        fetchMock = vi.spyOn(global, 'fetch');
        DokService._resetRateLimiter();
    });

    afterEach(function () {
        fetchMock.mockRestore();
    });

    const staleDecks = (count) =>
        db.query.mockImplementation((sql) => {
            if (sql.includes('LEFT JOIN "DeckSas"')) {
                return Promise.resolve(
                    Array.from({ length: count }, (_unused, i) => ({
                        uuid: uuid(i + 1),
                        fetchedAt: null
                    }))
                );
            }

            return Promise.resolve([]);
        });

    const dokReturns = (sasRating) =>
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ deck: { sasRating } }) });

    it('refreshes the stale decks it finds and stores the result', async function () {
        staleDecks(3);
        dokReturns(72);

        const result = await service.refreshStaleDecks();

        expect(result.refreshed).toBe(3);
        expect(result.budgetExhausted).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(db.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO "DeckSas"'))).toBe(
            true
        );
    });

    it('asks for the stalest decks first', async function () {
        staleDecks(1);
        dokReturns(60);

        await service.refreshStaleDecks();

        const [sql] = db.query.mock.calls[0];
        expect(sql).toContain('ORDER BY ds."FetchedAt" ASC NULLS FIRST');
    });

    it('yields the moment live traffic has taken the per-minute budget', async function () {
        // The load-bearing property: the sweep must never starve a deck import
        // or a pre-game SAS lookup by queueing ahead of them. Headroom off, so
        // this measures the budget itself; the reserve has its own tests.
        config.maxRequestsPerMinute = 2;
        config.backgroundHeadroom = 0;
        staleDecks(10);
        dokReturns(60);

        const result = await service.refreshStaleDecks();

        expect(result.attempted).toBe(2);
        expect(result.budgetExhausted).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('spends exactly one request per deck, not two', async function () {
        // fetchDeckStats reserves a slot of its own; the sweep already holds
        // one, and double-spending would halve the effective budget.
        config.maxRequestsPerMinute = 3;
        config.backgroundHeadroom = 0;
        staleDecks(3);
        dokReturns(60);

        const result = await service.refreshStaleDecks();

        expect(result.attempted).toBe(3);
        expect(result.refreshed).toBe(3);
    });

    it('keeps going after one deck fails', async function () {
        staleDecks(3);
        fetchMock
            .mockResolvedValueOnce({ ok: false, status: 500 })
            .mockResolvedValue({ ok: true, json: async () => ({ deck: { sasRating: 65 } }) });

        const result = await service.refreshStaleDecks();

        expect(result.attempted).toBe(3);
        expect(result.refreshed).toBe(2);
    });

    it('does nothing while DoK is not configured', async function () {
        config.apiKey = undefined;

        expect(await service.refreshStaleDecks()).toEqual(
            expect.objectContaining({ refreshed: 0, skipped: true })
        );
        expect(db.query).not.toHaveBeenCalled();
    });

    it('does nothing while an admin has turned the sweep off', async function () {
        config.sweepEnabled = false;

        expect(await service.refreshStaleDecks()).toEqual(
            expect.objectContaining({ refreshed: 0, skipped: true })
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never throws when the deck query fails', async function () {
        db.query.mockRejectedValue(new Error('db down'));

        expect(await service.refreshStaleDecks()).toEqual(
            expect.objectContaining({ refreshed: 0, attempted: 0 })
        );
    });
});
