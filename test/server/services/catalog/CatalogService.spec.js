const CatalogService = require('../../../../server/services/catalog/CatalogService');

describe('CatalogService', function () {
    let service;
    let db;
    let config;
    let fetchMock;

    const enabledConfig = {
        enabled: true,
        mvApiUrl: 'https://mv.example/api/decks/v2',
        pageSize: 2,
        requestTimeoutMs: 1000,
        // Crawl tests must never actually wait out the politeness delay.
        requestDelayMs: 0,
        pagesPerRun: 5,
        maxConsecutiveFailures: 3,
        backoffBaseMs: 1000,
        backoffMaxMs: 8000
    };

    const uuid = (n) => `${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;

    const configService = () => ({
        getValue: (key) => (key === 'catalog' ? config : undefined)
    });

    // One page row as Master Vault sends it: id, name, expansion and the
    // houses hanging off _links.
    const mvDeck = (n, overrides = {}) => ({
        id: uuid(n),
        name: `Deck ${n}`,
        expansion: 341,
        _links: { houses: ['Brobnar', 'Dis', 'Untamed'] },
        ...overrides
    });

    const stateRow = (overrides = {}) => ({
        CurrentPage: 0,
        TotalIndexed: 0,
        LastRunAt: null,
        LastError: null,
        PausedUntil: null,
        ConsecutiveFailures: 0,
        CaughtUp: false,
        ...overrides
    });

    // The cursor read answers with a row; every write answers with nothing.
    const mockState = (overrides = {}) =>
        db.query.mockImplementation(async (sql) =>
            sql.startsWith('SELECT') ? [stateRow(overrides)] : []
        );

    const mockPages = (pages) =>
        fetchMock.mockImplementation(async (url) => {
            const page = Number(new URL(url).searchParams.get('page'));

            return { ok: true, json: async () => ({ count: 9999, data: pages[page] || [] }) };
        });

    const updatesMatching = (fragment) =>
        db.query.mock.calls.filter(([sql]) => sql.includes(fragment));

    beforeEach(function () {
        config = { ...enabledConfig };
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new CatalogService(configService(), db);
        fetchMock = vi.spyOn(global, 'fetch');
    });

    afterEach(function () {
        fetchMock.mockRestore();
    });

    describe('feature flags', function () {
        it('is enabled by the config flag', function () {
            expect(service.isEnabled()).toBe(true);

            config.enabled = false;
            expect(service.isEnabled()).toBe(false);
        });

        // Two switches, because hiding the search box and stopping outbound
        // crawling are different decisions by different people.
        it('leaves search on by default and lets it be turned off on its own', function () {
            expect(service.isSearchEnabled()).toBe(true);

            config.searchEnabled = false;
            expect(service.isSearchEnabled()).toBe(false);
            expect(service.isEnabled()).toBe(true);
        });
    });

    describe('fetchPage', function () {
        it('asks Master Vault for a dated page and never for the cards', async function () {
            mockPages([[mvDeck(1)]]);

            await service.fetchPage(3);

            const [url, options] = fetchMock.mock.calls[0];

            expect(url).toBe('https://mv.example/api/decks/v2?page=3&page_size=2&ordering=date');
            // The catalog stores no cards, and asking for them would multiply
            // every response by two orders of magnitude.
            expect(url).not.toContain('links=cards');
            expect(options.headers).toEqual({ 'cache-control': 'no-cache' });
        });

        it('falls back to the real Master Vault endpoint when unconfigured', async function () {
            delete config.mvApiUrl;
            mockPages([[]]);

            await service.fetchPage(0);

            expect(fetchMock.mock.calls[0][0]).toBe(
                'https://www.keyforgegame.com/api/decks/v2?page=0&page_size=2&ordering=date'
            );
        });

        it('parses the catalog columns and joins the houses', async function () {
            mockPages([[mvDeck(1, { expansion: '452' })]]);

            const result = await service.fetchPage(0);

            expect(result.decks).toEqual([
                {
                    uuid: uuid(1),
                    name: 'Deck 1',
                    expansion: 452,
                    houses: 'Brobnar,Dis,Untamed'
                }
            ]);
        });

        it('keeps a deck whose houses Master Vault did not send', async function () {
            mockPages([[mvDeck(1, { _links: undefined })]]);

            expect((await service.fetchPage(0)).decks[0].houses).toBeNull();
        });

        it('drops rows that could not be stored rather than losing the page', async function () {
            mockPages([
                [
                    mvDeck(1),
                    { id: 12345, name: 'numeric id' },
                    { id: 'not-a-uuid', name: 'junk id' },
                    { id: uuid(9), expansion: 341 },
                    { id: uuid(8), name: 'no expansion' }
                ]
            ]);

            const result = await service.fetchPage(0);

            expect(result.decks.map((deck) => deck.uuid)).toEqual([uuid(1)]);
            // Fullness is still measured on what Master Vault sent.
            expect(result.rowCount).toBe(5);
        });

        it('reports the status so a rate limit can be told from a server error', async function () {
            fetchMock.mockResolvedValue({ ok: false, status: 429 });

            expect(await service.fetchPage(0)).toEqual({ error: 'HTTP 429', status: 429 });
        });

        it('never throws when the network fails', async function () {
            fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

            const result = await service.fetchPage(0);

            expect(result.error).toContain('could not connect');
            expect(result.status).toBeNull();
        });

        it('rejects a response that is not a deck list', async function () {
            fetchMock.mockResolvedValue({ ok: true, json: async () => ({ decks: [] }) });

            expect((await service.fetchPage(0)).error).toContain('unexpected response shape');
        });
    });

    describe('upsertDecks', function () {
        const deck = (n) => ({
            uuid: uuid(n),
            name: `Deck ${n}`,
            expansion: 341,
            houses: 'Brobnar,Dis,Untamed'
        });

        it('indexes a whole page in one statement and never clobbers a row', async function () {
            expect(await service.upsertDecks([deck(1), deck(2)])).toBe(2);

            const [sql, params] = db.query.mock.calls[0];

            expect(sql).toContain('INSERT INTO "DeckCatalog"');
            expect(sql).toContain('($1, $2, $3, $4');
            expect(sql).toContain('($5, $6, $7, $8');
            expect(sql).toContain('ON CONFLICT ("Uuid") DO NOTHING');
            expect(params).toEqual([
                uuid(1),
                'Deck 1',
                341,
                'Brobnar,Dis,Untamed',
                uuid(2),
                'Deck 2',
                341,
                'Brobnar,Dis,Untamed'
            ]);
            expect(db.query).toHaveBeenCalledTimes(1);
        });

        it('does not query for an empty page', async function () {
            expect(await service.upsertDecks([])).toBe(0);
            expect(db.query).not.toHaveBeenCalled();
        });

        it('reports nothing indexed when the insert fails, and never throws', async function () {
            db.query.mockRejectedValue(new Error('db down'));

            await expect(service.upsertDecks([deck(1)])).resolves.toBe(0);
        });
    });

    describe('getState', function () {
        it('reads the single cursor row', async function () {
            mockState({ CurrentPage: 12 });

            expect((await service.getState()).CurrentPage).toBe(12);
            expect(db.query.mock.calls[0][0]).toContain('"DeckCatalogState" WHERE "Id" = 1');
        });

        it('returns a zeroed cursor rather than throwing when the row cannot be read', async function () {
            db.query.mockRejectedValue(new Error('db down'));

            expect(await service.getState()).toEqual(
                expect.objectContaining({ CurrentPage: 0, ConsecutiveFailures: 0, CaughtUp: false })
            );
        });
    });

    describe('crawlOnce', function () {
        it('does nothing at all while the crawl is turned off', async function () {
            config.enabled = false;

            expect(await service.crawlOnce()).toEqual(
                expect.objectContaining({ indexed: 0, skipped: true })
            );
            expect(fetchMock).not.toHaveBeenCalled();
            expect(db.query).not.toHaveBeenCalled();
        });

        it('resumes from the persisted cursor', async function () {
            mockState({ CurrentPage: 7 });
            mockPages([]);

            await service.crawlOnce();

            expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('page')).toBe('7');
        });

        it('advances and persists the cursor after a full page', async function () {
            mockState();
            mockPages([[mvDeck(1), mvDeck(2)], [mvDeck(3)]]);

            const result = await service.crawlOnce();

            const progress = updatesMatching('"CurrentPage" = $1');

            expect(progress[0][1]).toEqual([1, 2, false]);
            expect(result.indexed).toBe(3);
            expect(result.pagesRequested).toBe(2);
        });

        // Fullness is Master Vault's row count, not ours: otherwise one deck
        // we cannot parse reads as the end of the list and pins the crawl.
        it('advances past a full page even when a row could not be parsed', async function () {
            mockState();
            mockPages([[mvDeck(1), { id: 'junk' }], []]);

            await service.crawlOnce();

            expect(updatesMatching('"CurrentPage" = $1')[0][1]).toEqual([1, 1, false]);
        });

        it('stops on a short page without advancing past it', async function () {
            mockState({ CurrentPage: 4 });
            mockPages({ 4: [mvDeck(1)] });

            const result = await service.crawlOnce();

            // Page 4 was short, so page 4 is where the next run starts: the
            // decks registered since then land on that same page.
            expect(updatesMatching('"CurrentPage" = $1')[0][1]).toEqual([4, 1, true]);
            expect(result).toEqual(
                expect.objectContaining({
                    indexed: 1,
                    pagesRequested: 1,
                    caughtUp: true,
                    paused: false,
                    budgetExhausted: false
                })
            );
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('spends no more than its page budget per run', async function () {
            mockState();
            mockPages([
                [mvDeck(1), mvDeck(2)],
                [mvDeck(3), mvDeck(4)],
                [mvDeck(5), mvDeck(6)]
            ]);

            const result = await service.crawlOnce({ pagesPerRun: 2 });

            expect(result.pagesRequested).toBe(2);
            expect(result.caughtUp).toBe(false);
            expect(result.budgetExhausted).toBe(true);
        });

        it('spaces requests out between pages but not before the first', async function () {
            config.requestDelayMs = 5000;
            mockState();
            mockPages([[mvDeck(1), mvDeck(2)], [mvDeck(3)]]);
            const sleep = vi.spyOn(service, 'sleep').mockResolvedValue();

            await service.crawlOnce();

            expect(sleep).toHaveBeenCalledTimes(1);
            expect(sleep).toHaveBeenCalledWith(5000);
        });

        // The load-bearing property of the breaker: the crawler shares an
        // origin with every user-facing deck import, so a 429 must stop the
        // crawl at once rather than after two more requests.
        it('trips the breaker on the first 429', async function () {
            mockState();
            fetchMock.mockResolvedValue({ ok: false, status: 429 });

            const before = Date.now();
            const result = await service.crawlOnce();

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(result.paused).toBe(true);

            const [, params] = updatesMatching('"ConsecutiveFailures" = $1')[0];

            expect(params[0]).toBe(1);
            expect(params[1]).toBe('HTTP 429');
            expect(params[2].getTime()).toBeGreaterThanOrEqual(before + 1000);
        });

        it('escalates through the failure threshold before pausing', async function () {
            mockState();
            fetchMock.mockResolvedValue({ ok: false, status: 500 });

            const before = Date.now();
            const result = await service.crawlOnce();

            expect(fetchMock).toHaveBeenCalledTimes(3);
            expect(result.paused).toBe(true);

            const failures = updatesMatching('"ConsecutiveFailures" = $1');

            expect(failures.map(([, params]) => params[0])).toEqual([1, 2, 3]);
            // Only the trip pauses; the first two just record what happened.
            expect(failures[0][1][2]).toBeNull();
            expect(failures[1][1][2]).toBeNull();
            // Third consecutive failure: base * 2^2.
            expect(failures[2][1][2].getTime()).toBeGreaterThanOrEqual(before + 4000);
            expect(failures[2][1][2].getTime()).toBeLessThan(before + 8000);
        });

        it('counts failures across runs, not just within one', async function () {
            mockState({ ConsecutiveFailures: 2 });
            fetchMock.mockResolvedValue({ ok: false, status: 500 });

            const result = await service.crawlOnce();

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(result.paused).toBe(true);
            expect(updatesMatching('"ConsecutiveFailures" = $1')[0][1][0]).toBe(3);
        });

        it('backs off exponentially and stops at the ceiling', function () {
            expect(service.backoffMs(1)).toBe(1000);
            expect(service.backoffMs(2)).toBe(2000);
            expect(service.backoffMs(3)).toBe(4000);
            expect(service.backoffMs(4)).toBe(8000);
            expect(service.backoffMs(20)).toBe(8000);
        });

        it('does not touch Master Vault while the breaker is open', async function () {
            mockState({ PausedUntil: new Date(Date.now() + 60000), ConsecutiveFailures: 3 });

            const result = await service.crawlOnce();

            expect(result).toEqual(
                expect.objectContaining({ paused: true, skipped: true, indexed: 0 })
            );
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('resumes once the pause has expired', async function () {
            mockState({ PausedUntil: new Date(Date.now() - 1000), ConsecutiveFailures: 3 });
            mockPages([[mvDeck(1)]]);

            const result = await service.crawlOnce();

            expect(result.paused).toBe(false);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('clears the failure count and the pause on a successful page', async function () {
            mockState({ ConsecutiveFailures: 2, LastError: 'HTTP 500' });
            mockPages([[mvDeck(1)]]);

            await service.crawlOnce();

            const [sql] = updatesMatching('"CurrentPage" = $1')[0];

            expect(sql).toContain('"ConsecutiveFailures" = 0');
            expect(sql).toContain('"PausedUntil" = NULL');
            expect(sql).toContain('"LastError" = NULL');
            expect(sql).toContain('"LastRunAt" = now()');
        });

        it('never throws when the database is down', async function () {
            db.query.mockRejectedValue(new Error('db down'));
            mockPages([[mvDeck(1)]]);

            await expect(service.crawlOnce()).resolves.toEqual(
                expect.objectContaining({ indexed: 0, pagesRequested: 1 })
            );
        });
    });

    describe('search', function () {
        const catalogRow = (n) => ({
            Uuid: uuid(n),
            Name: `Deck ${n}`,
            Expansion: 341,
            Houses: 'Brobnar,Dis,Untamed'
        });

        // Most of these assert the shape of the search query itself, so they
        // pin the substring mode on and leave index detection to its own block
        // below - otherwise every assertion would have to count past the
        // detection round-trip to find the query it cares about.
        beforeEach(function () {
            config.substringSearch = true;
        });

        it('matches a name substring case-insensitively', async function () {
            db.query.mockResolvedValue([catalogRow(1)]);

            const decks = await service.search('  onyx  ');

            const [sql, params] = db.query.mock.calls[0];

            expect(sql).toContain('lower("Name") LIKE $1');
            expect(sql).toContain('ORDER BY lower("Name")');
            expect(params[0]).toBe('%onyx%');
            expect(decks).toEqual([
                {
                    uuid: uuid(1),
                    name: 'Deck 1',
                    expansion: 341,
                    houses: 'Brobnar,Dis,Untamed'
                }
            ]);
        });

        // The query text is a player's keystrokes on a public endpoint; it
        // reaches the database as a parameter or not at all.
        it('parameterises the query text rather than interpolating it', async function () {
            await service.search('\'; DROP TABLE "DeckCatalog"; --');

            const [sql, params] = db.query.mock.calls[0];

            expect(sql).not.toContain('DROP');
            // Case-folded because the pattern is lowercased in JS rather than
            // by lower($1), so the btree prefix index can serve it.
            expect(params[0].toLowerCase()).toContain('drop table');
        });

        it('treats LIKE wildcards a player typed as literal characters', async function () {
            await service.search('100%');

            expect(db.query.mock.calls[0][1][0]).toBe('%100\\%%');
        });

        it('refuses a query too short to be worth a scan', async function () {
            expect(await service.search('a')).toEqual([]);
            expect(await service.search('   ')).toEqual([]);
            expect(await service.search(undefined)).toEqual([]);
            expect(db.query).not.toHaveBeenCalled();
        });

        it('returns nothing when search is turned off', async function () {
            config.searchEnabled = false;

            expect(await service.search('onyx')).toEqual([]);
            expect(db.query).not.toHaveBeenCalled();
        });

        it('clamps the caller limit to the configured maximum', async function () {
            config.maxSearchResults = 10;

            await service.search('onyx', { limit: 500 });

            const [, params] = db.query.mock.calls[0];

            expect(params[params.length - 1]).toBe(10);
        });

        it('defaults to a modest page of results', async function () {
            await service.search('onyx');

            const [, params] = db.query.mock.calls[0];

            expect(params[params.length - 1]).toBe(25);
        });

        it('filters by expansion when asked', async function () {
            await service.search('onyx', { expansion: 452, limit: 5 });

            const [sql, params] = db.query.mock.calls[0];

            expect(sql).toContain('AND "Expansion" = $2');
            expect(params).toEqual(['%onyx%', 452, 5]);
        });

        it('returns no results rather than throwing when the query fails', async function () {
            db.query.mockRejectedValue(new Error('db down'));

            await expect(service.search('onyx')).resolves.toEqual([]);
        });
    });

    // The migration creates the pg_trgm index where it can and carries on with
    // a NOTICE where it cannot, so both databases exist in the wild. Searching
    // for a substring on the one without it is a sequential scan of every deck
    // in existence, which is exactly what the prefix index is there to prevent.
    describe('search index detection', function () {
        const trigramPresent = (present) =>
            db.query.mockImplementation((sql) =>
                Promise.resolve(
                    sql.includes('pg_indexes') ? (present ? [{ '?column?': 1 }] : []) : []
                )
            );

        it('matches a substring when the trigram index exists', async function () {
            trigramPresent(true);

            await service.search('onyx');

            const searchCall = db.query.mock.calls.find(([sql]) =>
                sql.includes('FROM "DeckCatalog"')
            );

            expect(searchCall[1][0]).toBe('%onyx%');
        });

        it('falls back to a prefix the btree can serve when it does not', async function () {
            trigramPresent(false);

            await service.search('onyx');

            const searchCall = db.query.mock.calls.find(([sql]) =>
                sql.includes('FROM "DeckCatalog"')
            );

            expect(searchCall[1][0]).toBe('onyx%');
        });

        it('checks for the index once and remembers the answer', async function () {
            trigramPresent(true);

            await service.search('onyx');
            await service.search('scarlet');

            const detections = db.query.mock.calls.filter(([sql]) => sql.includes('pg_indexes'));

            expect(detections).toHaveLength(1);
        });

        // Guessing "no trigram" costs a narrower search; guessing "trigram"
        // when there is none costs a table scan per keystroke.
        it('assumes the narrow query when it cannot tell', async function () {
            db.query.mockImplementation((sql) =>
                sql.includes('pg_indexes')
                    ? Promise.reject(new Error('permission denied'))
                    : Promise.resolve([])
            );

            await service.search('onyx');

            const searchCall = db.query.mock.calls.find(([sql]) =>
                sql.includes('FROM "DeckCatalog"')
            );

            expect(searchCall[1][0]).toBe('onyx%');
        });

        it('lets an operator force either mode without a probe', async function () {
            config.substringSearch = false;
            trigramPresent(true);

            await service.search('onyx');

            expect(db.query.mock.calls.some(([sql]) => sql.includes('pg_indexes'))).toBe(false);
            expect(db.query.mock.calls[0][1][0]).toBe('onyx%');
        });
    });
});
