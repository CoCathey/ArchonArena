const GauntletService = require('../../../../server/services/championschallenge/GauntletService');
const { STRATEGIES } = require('../../../../server/services/championschallenge/GauntletService');

/**
 * ARCHON (N24): the Gauntlet - Champion's Challenge against the field.
 *
 * What is pinned here:
 *
 *  - the draw never returns a deck the member owns or a friend owns, which is
 *    the whole meaning of "the field";
 *  - filters reach the SQL, and the COUNT the page shows is built from the same
 *    clauses as the draw - a count that disagrees with the draw is how a member
 *    comes to be told 300 decks match while every game stays a mirror;
 *  - hydration keeps what it can simulate and REMEMBERS what it cannot, so an
 *    unplayable deck never costs a second Master Vault request;
 *  - Gauntlet SQL never mentions the official tables, the same property the
 *    mirror lab is held to.
 */
describe('GauntletService', function () {
    let db;
    let service;
    let config;

    const USER = 42;
    const configService = { getValue: () => ({}) };
    const settingsService = {
        getSectionWithDefaults: (name) => (name === 'championsChallenge' ? { ...config } : {}),
        getSection: () => ({})
    };

    const answer = (handlers) =>
        db.query.mockImplementation(async (sql, params) => {
            for (const [fragment, rows] of handlers) {
                if (sql.includes(fragment)) {
                    return typeof rows === 'function' ? rows(sql, params) : rows;
                }
            }

            return [];
        });

    const queriesMatching = (fragment) =>
        db.query.mock.calls.filter(([sql]) => sql.includes(fragment));

    // Stubbing fetch means putting the REAL one back afterwards, not deleting
    // it: spec files share a worker process, so `delete global.fetch` left every
    // later file's `vi.spyOn(global, 'fetch')` throwing "not defined on the
    // object" - 35 unrelated Patreon tests, failing only in a full run.
    let realFetch;

    beforeEach(function () {
        realFetch = global.fetch;
        config = {
            gauntletEnabled: true,
            gauntletDecksPerRun: 3,
            gauntletTargetPoolSize: 100,
            gauntletRequestDelayMs: 0,
            gauntletEnrichPerRun: 2
        };
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new GauntletService(configService, db, settingsService);
        // Nothing here should ever sleep for real.
        service.sleep = () => Promise.resolve();
    });

    afterEach(function () {
        global.fetch = realFetch;
        vi.restoreAllMocks();
    });

    describe('settings', function () {
        it('defaults a member who has never configured it', async function () {
            const settings = await service.settingsFor(USER);

            expect(settings).toEqual({
                enabled: false,
                fieldSharePct: 50,
                sets: [],
                houses: [],
                strategies: [],
                minSas: null,
                maxSas: null
            });
        });

        it('reads stored filters back as lists', async function () {
            answer([
                [
                    'FROM "GauntletSettings"',
                    [
                        {
                            Enabled: true,
                            FieldSharePct: 80,
                            Sets: '341,435',
                            Houses: 'dis,logos',
                            Strategies: 'amber,speed',
                            MinSas: 60,
                            MaxSas: 90
                        }
                    ]
                ]
            ]);

            const settings = await service.settingsFor(USER);

            expect(settings.enabled).toBe(true);
            expect(settings.sets).toEqual([341, 435]);
            expect(settings.houses).toEqual(['dis', 'logos']);
            expect(settings.strategies).toEqual(['amber', 'speed']);
            expect(settings.minSas).toBe(60);
        });

        it('drops strategy keys it does not know', async function () {
            answer([['FROM "GauntletSettings"', []]]);

            await service.saveSettings(USER, {
                enabled: true,
                strategies: ['amber', 'wishful-thinking']
            });

            const [insert] = queriesMatching('INSERT INTO "GauntletSettings"');

            expect(insert[1][5]).toBe('amber');
        });

        it('reads a backwards SAS window as the typo it is', async function () {
            answer([['FROM "GauntletSettings"', []]]);

            await service.saveSettings(USER, { minSas: 90, maxSas: 60 });

            const [insert] = queriesMatching('INSERT INTO "GauntletSettings"');

            expect(insert[1][6]).toBe(60);
            expect(insert[1][7]).toBe(90);
        });
    });

    describe('the draw', function () {
        const poolRow = {
            Uuid: 'deck-uuid',
            Name: 'Stranger’s Deck',
            Expansion: 700,
            Houses: 'dis,logos,mars',
            Cards: [{ id: 'anger', count: 1 }],
            SasRating: 72
        };

        const emptyFilters = {
            sets: [],
            houses: [],
            strategies: [],
            minSas: null,
            maxSas: null
        };

        it('excludes the member’s own decks and their friends’ decks', async function () {
            answer([['FROM "GauntletDecks" g', [poolRow]]]);

            await service.drawOpponent(USER, emptyFilters);

            const [draw] = queriesMatching('FROM "GauntletDecks" g');

            // Own decks...
            expect(draw[0]).toContain('FROM "Decks" d WHERE d."Uuid" = g."Uuid"');
            expect(draw[0]).toContain('d."UserId" = $1');
            // ...and friends', in either direction of the friendship row.
            expect(draw[0]).toContain('"Friendships"');
            expect(draw[0]).toContain('f."Status" = \'accepted\'');
            expect(draw[0]).toContain('f."RequesterId" = $1');
            expect(draw[0]).toContain('f."AddresseeId" = $1');
        });

        it('returns an engine-ready deck with no dbId', async function () {
            answer([['FROM "GauntletDecks" g', [poolRow]]]);

            const drawn = await service.drawOpponent(USER, emptyFilters);

            expect(drawn.uuid).toBe('deck-uuid');
            expect(drawn.sas).toBe(72);
            expect(drawn.deck.houses).toEqual(['dis', 'logos', 'mars']);
            // ENGINE-ready, which means the card data is attached: the row
            // stores ids, and the engine silently plays an empty deck when an
            // entry arrives without its card. See fieldDeckCards.spec.js.
            expect(drawn.deck.cards).toHaveLength(1);
            expect(drawn.deck.cards[0].id).toBe('anger');
            expect(drawn.deck.cards[0].card.id).toBe('anger');
            // A foreign deck has no row in "Decks"; nothing downstream may
            // treat it as if it did.
            expect(drawn.deck.dbId).toBeUndefined();
        });

        it('parses a cards column that arrives as text', async function () {
            answer([
                ['FROM "GauntletDecks" g', [{ ...poolRow, Cards: '[{"id":"anger","count":2}]' }]]
            ]);

            const drawn = await service.drawOpponent(USER, emptyFilters);

            expect(drawn.deck.cards[0].count).toBe(2);
            expect(drawn.deck.cards[0].card.id).toBe('anger');
        });

        it('says nothing rather than guessing when the pool has no match', async function () {
            answer([['FROM "GauntletDecks" g', []]]);

            expect(await service.drawOpponent(USER, emptyFilters)).toBeNull();
        });

        it('puts every filter into the query', async function () {
            answer([['FROM "GauntletDecks" g', [poolRow]]]);

            await service.drawOpponent(USER, {
                sets: [700, 800],
                houses: ['dis'],
                strategies: ['amber'],
                minSas: 60,
                maxSas: 90
            });

            const [draw] = queriesMatching('FROM "GauntletDecks" g');

            expect(draw[0]).toContain('g."Expansion" = ANY(');
            expect(draw[0]).toContain('string_to_array(g."Houses"');
            expect(draw[0]).toContain('ds."SasRating" >=');
            expect(draw[0]).toContain('ds."SasRating" <=');
            // The strategy's AERC component, read out of the cached DoK payload.
            expect(draw[0]).toContain("'amberControl'");
            expect(draw[1]).toContain(STRATEGIES.amber.thresholds.amberControl);
        });

        /**
         * ARCHON (N30): a strategy filter that works with no DoK key.
         *
         * The filter used to read AERC out of the cached DoK payload and nothing
         * else, so on a server with no key it matched no decks at all - the most
         * configurable part of the Gauntlet, silently inert.
         */
        it('falls back to the deck’s own cards where DoK has not rated it', async function () {
            answer([['FROM "GauntletDecks" g', [poolRow]]]);

            await service.drawOpponent(USER, {
                sets: [],
                houses: [],
                strategies: ['amber'],
                minSas: null,
                maxSas: null
            });

            const [draw] = queriesMatching('FROM "GauntletDecks" g');

            // DoK's number when the deck has one...
            expect(draw[0]).toContain('ds."RawData" IS NOT NULL');
            expect(draw[0]).toContain("ds.\"RawData\" -> 'deck' ->> 'amberControl'");
            // ...the local reading when it does not. Not "either passes": a deck
            // DoK has rated is judged by DoK, or the filter silently loosens for
            // exactly the decks we know most about.
            expect(draw[0]).toContain('g."Profile" ->> \'amberControl\'');
            expect(draw[0]).not.toMatch(/RawData[^C]*OR[^C]*Profile/);
            expect(draw[1]).toContain(STRATEGIES.amber.thresholds.amberControl);
            expect(draw[1]).toContain(STRATEGIES.amber.localThresholds.amberControl);
        });

        it('counts matches with the same clauses it draws with', async function () {
            answer([['FROM "GauntletDecks" g', [{ Count: 12 }]]]);

            const filters = {
                sets: [700],
                houses: ['dis'],
                strategies: ['speed'],
                minSas: 50,
                maxSas: null
            };

            await service.drawOpponent(USER, filters);
            await service.countMatching(USER, filters);

            const [draw, count] = queriesMatching('FROM "GauntletDecks" g');
            const whereOf = (sql) => sql.slice(sql.indexOf('WHERE'));

            // Identical WHERE clauses: a count that filters differently from
            // the draw advertises decks the draw cannot find.
            expect(whereOf(count[0]).startsWith(whereOf(draw[0]).split(' ORDER BY')[0])).toBe(true);
            expect(count[1]).toEqual(draw[1]);
        });
    });

    describe('hydration', function () {
        const catalogRow = { Uuid: 'u-1', Name: 'Catalog Deck', Expansion: 700, Houses: 'dis' };

        beforeEach(function () {
            service.deckService = {
                parseDeckResponse: vi.fn().mockResolvedValue({
                    name: 'Catalog Deck',
                    expansion: 700,
                    houses: ['dis', 'logos', 'mars'],
                    // Real card ids, so the pack index can actually clone them.
                    cards: [
                        { id: 'anger', count: 1 },
                        { id: 'hand-of-dis', count: 1 },
                        { id: 'foggify', count: 1 }
                    ]
                })
            };
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ data: { id: 'u-1' }, _linked: { cards: [] } })
            });
        });

        it('stores a simulatable deck as playable, with its cards', async function () {
            expect(await service.hydrateDeck(catalogRow)).toBe('hydrated');

            const [insert] = queriesMatching('INSERT INTO "GauntletDecks"');

            expect(insert[0]).toContain('true');
            expect(JSON.parse(insert[1][4])).toHaveLength(3);
            expect(insert[1][3]).toBe('dis,logos,mars');
        });

        it('remembers a deck it cannot simulate instead of retrying it forever', async function () {
            service.deckService.parseDeckResponse.mockResolvedValue({
                name: 'Future Deck',
                expansion: 999,
                houses: ['dis', 'logos', 'mars'],
                cards: [{ id: 'a-card-from-2027', count: 1 }]
            });

            expect(await service.hydrateDeck(catalogRow)).toBe('unplayable');

            const [insert] = queriesMatching('INSERT INTO "GauntletDecks"');

            expect(insert[0]).toContain('false');
            expect(insert[1][4]).toContain('a-card-from-2027');
        });

        it('treats a deck without three houses as unplayable', async function () {
            service.deckService.parseDeckResponse.mockResolvedValue({
                name: 'Odd Deck',
                expansion: 700,
                houses: ['dis', 'logos'],
                cards: [{ id: 'anger', count: 1 }]
            });

            expect(await service.hydrateDeck(catalogRow)).toBe('unplayable');
            expect(queriesMatching('INSERT INTO "GauntletDecks"')[0][1][4]).toBe('house-count');
        });

        it('reports an upstream failure without storing anything', async function () {
            global.fetch.mockResolvedValue({ ok: false, status: 429 });

            expect(await service.hydrateDeck(catalogRow)).toBe('failed');
            expect(queriesMatching('INSERT INTO "GauntletDecks"')).toHaveLength(0);
        });

        it('stops the run on the first failure rather than burning the budget', async function () {
            answer([
                ['COUNT(*)::int AS "Count"', [{ Count: 0 }]],
                [
                    'FROM "DeckCatalog" c',
                    [
                        { Uuid: 'u-1', Name: 'A', Expansion: 700, Houses: 'dis' },
                        { Uuid: 'u-2', Name: 'B', Expansion: 700, Houses: 'dis' },
                        { Uuid: 'u-3', Name: 'C', Expansion: 700, Houses: 'dis' }
                    ]
                ]
            ]);
            global.fetch.mockResolvedValue({ ok: false, status: 429 });

            const outcome = await service.hydratePool();

            expect(outcome).toEqual({ hydrated: 0, unplayable: 0, failed: 1 });
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        it('stops hydrating once the pool is big enough', async function () {
            answer([['COUNT(*)::int AS "Count"', [{ Count: 100 }]]]);

            expect(await service.hydratePool()).toEqual({
                hydrated: 0,
                unplayable: 0,
                failed: 0
            });
            expect(queriesMatching('FROM "DeckCatalog" c')).toHaveLength(0);
        });

        it('draws pool candidates at random, not in crawl order', async function () {
            answer([
                ['COUNT(*)::int AS "Count"', [{ Count: 0 }]],
                ['FROM "DeckCatalog" c', []]
            ]);

            await service.hydratePool();

            // The catalog is ordered by registration date; taking its head would
            // build a pool entirely out of the oldest decks in existence.
            expect(queriesMatching('FROM "DeckCatalog" c')[0][0]).toContain('ORDER BY random()');
        });
    });

    describe('the record', function () {
        it('records a loss from the member’s point of view', async function () {
            await service.recordGame({
                userId: USER,
                deckId: 7,
                opponent: { uuid: 'u-1', name: 'Stranger', sas: 80 },
                won: false,
                result: {
                    winnerKeys: 3,
                    loserKeys: 1,
                    turns: 20,
                    winnerWentFirst: true,
                    winnerFirstHouse: 'dis',
                    loserFirstHouse: 'logos',
                    durationMs: 500
                }
            });

            const [insert] = queriesMatching('INSERT INTO "GauntletGames"');
            const params = insert[1];

            expect(params[5]).toBe(false);
            // My keys are the LOSER's keys, and I did not go first because the
            // winner did.
            expect(params[6]).toBe(1);
            expect(params[7]).toBe(3);
            expect(params[9]).toBe(false);
            expect(params[10]).toBe('logos');
            expect(params[11]).toBe('dis');
        });

        it('folds games into a per-deck field record', async function () {
            answer([
                [
                    'FROM "GauntletGames" WHERE "UserId"',
                    [{ DeckId: 7, Played: 20, Wins: 13, AvgOpponentSas: 71.44 }]
                ]
            ]);

            const records = await service.recordsFor(USER);

            expect(records[7]).toEqual({
                games: 20,
                wins: 13,
                losses: 7,
                winRate: 0.65,
                avgOpponentSas: 71.4
            });
        });
    });

    describe('pool upkeep', function () {
        it('grows the pool only while somebody plays the field', async function () {
            answer([['FROM "GauntletSettings" WHERE "Enabled" = true', []]]);

            expect(await service.anyoneWantsField()).toBe(false);
        });

        it('asks for enrichment only for playable decks with no stats', async function () {
            service.dokService = {
                isEnabled: () => true,
                enrichDeck: vi.fn().mockResolvedValue(true)
            };
            answer([['ds."Uuid" IS NULL', [{ Uuid: 'u-1' }, { Uuid: 'u-2' }]]]);

            expect(await service.enrichPool()).toEqual({ asked: 2, enriched: 2 });
            // Background: the pool growing is worth less than a member waiting on
            // the same per-minute budget.
            expect(service.dokService.enrichDeck).toHaveBeenCalledWith('u-1', {
                background: true
            });

            const [query] = queriesMatching('ds."Uuid" IS NULL');

            expect(query[0]).toContain('g."Playable" = true');
        });

        /**
         * ARCHON (N30): reading the pool costs nothing but CPU - the cards are
         * already stored - which is why it runs before enrichment and why a
         * server with no DoK key is not a server with no strategy filters.
         */
        it('reads stored decks from their own cards, with no outbound request', async function () {
            const realFetchDuringProfile = global.fetch;

            global.fetch = vi.fn();
            answer([
                [
                    'WHERE "Playable" = true AND "Profile" IS NULL',
                    [
                        {
                            Uuid: 'u-1',
                            Cards: JSON.stringify([{ id: 'anger', count: 3 }])
                        }
                    ]
                ]
            ]);

            expect(await service.profilePool()).toBe(1);
            expect(global.fetch).not.toHaveBeenCalled();

            const [update] = queriesMatching('SET "Profile"');
            const stored = JSON.parse(update[1][1]);

            expect(update[1][0]).toBe('u-1');
            // Three copies of a one-amber card: the printed facts, multiplied.
            expect(stored.expectedAmber).toBe(3);
            expect(Object.keys(stored)).toContain('creatureControl');

            global.fetch = realFetchDuringProfile;
        });

        it('skips a stored deck whose cards it cannot read', async function () {
            answer([
                [
                    'WHERE "Playable" = true AND "Profile" IS NULL',
                    [{ Uuid: 'u-2', Cards: JSON.stringify([{ id: 'not-a-card' }]) }]
                ]
            ]);

            expect(await service.profilePool()).toBe(0);
            expect(queriesMatching('SET "Profile"')).toHaveLength(0);
        });

        it('does nothing when the server has no DoK key', async function () {
            service.dokService = { isEnabled: () => false, enrichDeck: vi.fn() };

            expect(await service.enrichPool()).toEqual({ asked: 0, enriched: 0 });
            expect(service.dokService.enrichDeck).not.toHaveBeenCalled();
        });

        /**
         * ARCHON (N27): the ask is stamped whether or not DoK answers.
         *
         * Master Vault registers decks Decks of KeyForge has no rating for, and
         * "no DeckSas row" is also what a deck nobody has asked about looks like.
         * With no stamp, the pass spent its whole per-run budget re-asking the
         * same unanswerable decks on every sweep and never reached the pool
         * behind them - the one shape of "hammering somebody else's API" that
         * looks like ordinary progress from the inside.
         */
        it('remembers every ask, including the ones DoK cannot answer', async function () {
            service.dokService = {
                isEnabled: () => true,
                // DoK has no rating for this deck: no row is written, so the
                // deck still has no stats after the ask.
                enrichDeck: vi.fn().mockResolvedValue(false)
            };
            answer([['ds."Uuid" IS NULL', [{ Uuid: 'u-1' }]]]);

            expect(await service.enrichPool()).toEqual({ asked: 1, enriched: 0 });

            const [stamp] = queriesMatching('SET "SasAskedAt"');

            expect(stamp[0]).toContain('WHERE "Uuid" = $1');
            expect(stamp[1]).toEqual(['u-1']);
        });

        it('stamps before asking, so a timeout still counts as a request', async function () {
            const order = [];

            service.dokService = {
                isEnabled: () => true,
                enrichDeck: vi.fn(async () => {
                    order.push('ask');

                    return false;
                })
            };
            answer([
                ['ds."Uuid" IS NULL', [{ Uuid: 'u-1' }]],
                [
                    'SET "SasAskedAt"',
                    () => {
                        order.push('stamp');

                        return [];
                    }
                ]
            ]);

            await service.enrichPool();

            expect(order).toEqual(['stamp', 'ask']);
        });

        it('leaves a deck alone until the retry window has passed', async function () {
            service.dokService = { isEnabled: () => true, enrichDeck: vi.fn() };
            config.gauntletEnrichRetryDays = 30;
            answer([['ds."Uuid" IS NULL', []]]);

            await service.enrichPool();

            const [query] = queriesMatching('ds."Uuid" IS NULL');

            expect(query[0]).toContain('g."SasAskedAt" IS NULL OR g."SasAskedAt" < $2');
            // Never asked first; among those, the decks the draw keeps picking.
            expect(query[0]).toContain('ORDER BY g."SasAskedAt" ASC NULLS FIRST');
            expect(query[0]).toContain('g."GamesPlayed" DESC');

            const cutoff = query[1][1];
            const daysAgo = (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000);

            expect(daysAgo).toBeCloseTo(30, 1);
        });
    });

    // The property the whole Challenge stands on, extended to the Gauntlet.
    it('never touches the official games, players or rating tables', async function () {
        const official = /"(Games|GamePlayers|RatingHistory)"/;

        service.deckService = { parseDeckResponse: vi.fn().mockResolvedValue(null) };
        global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

        await service.settingsFor(USER);
        await service.saveSettings(USER, { enabled: true });
        await service.drawOpponent(USER, {
            sets: [],
            houses: [],
            strategies: [],
            minSas: null,
            maxSas: null
        });
        await service.recordsFor(USER);
        await service.recentGames(USER);
        await service.hydratePool();
        await service.noteOpponentPlayed('u-1');

        for (const [sql] of db.query.mock.calls) {
            expect(sql).not.toMatch(official);
        }
    });
});
