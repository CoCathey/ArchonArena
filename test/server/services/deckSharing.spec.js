const db = require('../../../server/db');

/**
 * ARCHON: sharing a deck is allowed, and the deck page reports both records.
 *
 * Two people can own one physical KeyForge deck, one person can have a second
 * account, and a friend can import your deck to read it. keyteki brands all
 * three Used / Popular / Notorious; ArchonArena does not, unless an operator
 * turns lobby.flagSharedDecks on.
 *
 * The count behind those labels also changed shape. It was COUNT(*) over rows
 * sharing a NAME, and KeyForge generates names from a finite word list, so two
 * unrelated decks can carry the same one - and the loser of that collision was
 * reported as shared with no second owner anywhere.
 *
 * DeckService holds the db module's exported object, so replacing `query` on
 * that object intercepts it and the real code path still runs.
 */
describe('shared decks', function () {
    let DeckService;
    let queries;
    let originalQuery;
    let originalStartTransaction;
    let originalQueryTran;
    let flagSharedDecks;

    const configService = {
        getValue: () => undefined,
        getValueForSection: (section, key) => {
            if (key === 'flagSharedDecks') {
                return flagSharedDecks;
            }

            return { lowerDeckThreshold: 1, middleDeckThreshold: 2, upperDeckThreshold: 3 }[key];
        }
    };

    beforeEach(function () {
        queries = [];
        flagSharedDecks = false;
        originalQuery = db.query;

        // Transactional writes are held on one connection now, so the fake has
        // to answer `startTransaction`/`queryTran` too. Both route back through
        // the stub above, so every assertion here still reads one recorder.
        originalStartTransaction = db.startTransaction;
        originalQueryTran = db.queryTran;
        db.startTransaction = vi.fn(async () => ({ release: vi.fn() }));
        db.queryTran = vi.fn((client, sql, params) => db.query(sql, params));

        db.query = vi.fn(async (sql, params) => {
            queries.push({ sql, params });

            if (/FROM "Decks" d/.test(sql)) {
                const row = {
                    Id: 7,
                    UserId: 3,
                    Name: 'Test Deck',
                    Identity: 'Test Deck',
                    Uuid: 'uuid-1',
                    Expansion: 341,
                    Username: 'alice',
                    DeckCount: '2',
                    WinCount: '4',
                    LoseCount: '1',
                    WinRate: 80
                };

                // Postgres returns the columns the query asked for and no
                // others, so the fake must too - otherwise a query that stopped
                // selecting the pooled record would still appear to return it.
                if (/AS "GlobalWinCount"/.test(sql)) {
                    row.GlobalWinCount = '9';
                    row.GlobalLoseCount = '3';
                    row.GlobalWinRate = 75;
                }

                return [row];
            }

            return [];
        });

        DeckService = require('../../../server/services/DeckService');
    });

    afterEach(function () {
        db.query = originalQuery;
        db.startTransaction = originalStartTransaction;
        db.queryTran = originalQueryTran;
    });

    describe('who counts as an owner', function () {
        it('counts distinct owners of the same uuid, not rows sharing a name', async function () {
            const service = new DeckService(configService, {});

            await service.getById(7);

            const { sql } = queries[0];

            expect(sql).toContain('COUNT(DISTINCT x."UserId")');
            expect(sql).toContain('x."Uuid" = d."Uuid"');
            // The old form, which counted a name collision between two
            // unrelated decks as shared ownership.
            expect(sql).not.toContain('(SELECT COUNT(*) FROM "Decks" WHERE "Name" = d."Name")');
        });

        it('falls back to the name only for a row with no uuid', async function () {
            const service = new DeckService(configService, {});

            await service.getById(7);

            expect(queries[0].sql).toContain(
                'CASE WHEN d."Uuid" IS NULL THEN x."Name" = d."Name" ELSE x."Uuid" = d."Uuid" END'
            );
        });

        it('uses the same definition on the deck list', async function () {
            const service = new DeckService(configService, {});

            await service.findForUser({ id: 3 }, { page: 1, pageSize: 10 });

            const list = queries.find((entry) => /FROM "Decks" d/.test(entry.sql));

            expect(list.sql).toContain('COUNT(DISTINCT x."UserId")');
        });
    });

    describe('the Used / Popular / Notorious level', function () {
        it('is silent about a shared deck by default', async function () {
            const service = new DeckService(configService, {});

            const deck = await service.getById(7);

            // The database says two people own it...
            expect(deck.usageCount).toBe('2');
            // ...and the site says that is nobody's business.
            expect(service.usageLevelFor(deck)).toBe(0);
        });

        it('returns nothing from the flagged-deck list by default', async function () {
            const service = new DeckService(configService, {});

            expect(await service.getFlaggedUnverifiedDecksForUser({ id: 3 })).toEqual([]);
            // And does not go to the database to find that out.
            expect(queries).toHaveLength(0);
        });

        it('still grades a deck when an operator turns the policy on', async function () {
            flagSharedDecks = true;
            const service = new DeckService(configService, {});
            const deck = await service.getById(7);

            expect(service.usageLevelFor({ ...deck, usageCount: '2' })).toBe(1);
            expect(service.usageLevelFor({ ...deck, usageCount: '3' })).toBe(2);
            expect(service.usageLevelFor({ ...deck, usageCount: '4' })).toBe(3);
            // One owner is never a shared deck at any setting.
            expect(service.usageLevelFor({ ...deck, usageCount: '1' })).toBe(0);
        });

        it('queries the flagged-deck list when the policy is on', async function () {
            flagSharedDecks = true;
            const service = new DeckService(configService, {});

            await service.getFlaggedUnverifiedDecksForUser({ id: 3 });

            expect(queries.length).toBeGreaterThan(0);
            expect(queries[0].sql).toContain('COUNT(DISTINCT x."UserId")');
        });
    });

    describe('the record on the deck page', function () {
        it("carries this account's record and every owner's, separately", async function () {
            const service = new DeckService(configService, {});

            const deck = await service.getById(7);

            expect(deck.wins).toBe('4');
            expect(deck.losses).toBe('1');
            expect(deck.globalWins).toBe('9');
            expect(deck.globalLosses).toBe('3');
            expect(deck.globalWinRate).toBe(75);
        });

        it('pools games by deck rather than by owner', async function () {
            const service = new DeckService(configService, {});

            await service.getById(7);

            const { sql } = queries[0];

            expect(sql).toContain('AS "GlobalWinCount"');
            expect(sql).toContain('AS "GlobalLoseCount"');
            // A game nobody won is neither a win nor a loss for anyone.
            expect(sql).toContain('g."WinnerId" IS NOT NULL AND g."WinnerId" != gp."PlayerId"');
        });

        it('counts the uuid the GAME recorded, not a live deck row', async function () {
            // An owner who has since deleted their copy still played those
            // games. Matching through "Decks" dropped them the moment the row
            // went, which took half the deck's history away from the owners
            // who kept theirs.
            const service = new DeckService(configService, {});

            await service.getById(7);

            expect(queries[0].sql).toContain('gp."DeckUuid" = d."Uuid"');
        });

        it('leaves the pooled record off the list, which does not ask for it', async function () {
            const service = new DeckService(configService, {});

            const decks = await service.findForUser({ id: 3 }, { page: 1, pageSize: 10 });

            // Undefined rather than zero, so the UI can tell "not asked" from
            // "nobody has played it".
            expect(decks[0].globalWins).toBeUndefined();
        });
    });

    describe('deleting a deck and importing it again', function () {
        const newDeck = (uuid) => ({
            uuid,
            name: 'Test Deck',
            identity: 'Test Deck',
            expansion: 453,
            isAlliance: false,
            lastUpdated: new Date(),
            houses: ['brobnar', 'dis', 'logos'],
            cards: [{ id: 'sneklifter', count: 1 }]
        });

        const relinkQuery = () =>
            queries.find((entry) => /UPDATE "GamePlayers" SET "DeckId"/.test(entry.sql));

        beforeEach(function () {
            const previous = db.query;

            db.query = vi.fn(async (sql, params) => {
                if (/INSERT INTO "Decks"/.test(sql)) {
                    queries.push({ sql, params });

                    return [{ Id: 42 }];
                }

                return previous(sql, params);
            });
        });

        // THE DEFECT: "GamePlayers"."DeckId" is ON DELETE SET NULL, so deleting
        // a deck cut every game loose, and re-importing wrote a NEW row with a
        // new id that the old games did not point at. The record read zero.
        it('points the orphaned games at the new row', async function () {
            const service = new DeckService(configService, { getAllCards: async () => ({}) });

            await service.insertDeck(newDeck('uuid-1'), { id: 3, username: 'alice' });

            const relink = relinkQuery();

            expect(relink).toBeTruthy();
            expect(relink.params).toEqual([42, 3, 'uuid-1']);
        });

        it("adopts only this account's orphans, and only orphans", async function () {
            const service = new DeckService(configService, { getAllCards: async () => ({}) });

            await service.insertDeck(newDeck('uuid-1'), { id: 3, username: 'alice' });

            const { sql } = relinkQuery();

            // Another owner's games belong to their copy...
            expect(sql).toContain('"PlayerId" = $2');
            // ...and a row that still has a deck is not orphaned.
            expect(sql).toContain('"DeckId" IS NULL');
            expect(sql).toContain('"DeckUuid" = $3');
        });

        it('does not go looking when the deck has no uuid to match on', async function () {
            // Alliance decks are built rather than imported; there is no
            // durable identity to re-link by, and an unscoped UPDATE here
            // would adopt somebody else's orphans.
            const service = new DeckService(configService, { getAllCards: async () => ({}) });

            await service.insertDeck(
                { ...newDeck(undefined), isAlliance: true },
                { id: 3, username: 'alice' }
            );

            expect(relinkQuery()).toBeUndefined();
        });
    });
});
