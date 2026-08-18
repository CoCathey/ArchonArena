const db = require('../../../server/db');

/**
 * ARCHON: regression tests for three long-standing query defects.
 *
 * All three were invisible in normal use - they produced wrong numbers or an
 * error on an uncommon path rather than a crash - so each test pins the exact
 * thing that was wrong rather than just asserting the feature works.
 *
 * DeckService holds the db module's exported object (`const db =
 * require('../db')`), so replacing `query` on that object is enough to
 * intercept it. No module mocking needed, and the real code path runs.
 */
describe('deck and game query fixes', function () {
    let DeckService;
    let GameService;
    let queries;
    let originalQuery;
    let originalStartTransaction;
    let originalQueryTran;

    beforeEach(function () {
        queries = [];
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

            // create() reads the new game's id off RETURNING.
            if (/INSERT INTO "Games"/.test(sql)) {
                return [{ Id: 99 }];
            }

            // getById maps the first row, then loads cards/houses; empty rows
            // satisfy those follow-ups.
            if (/FROM "Decks" d/.test(sql)) {
                return [
                    {
                        Id: 7,
                        UserId: 3,
                        Name: 'Test Deck',
                        Identity: 'test-deck',
                        Uuid: 'uuid-1',
                        Expansion: 341,
                        Username: 'alice',
                        DeckCount: '4',
                        WinCount: '6',
                        LoseCount: '2',
                        WinRate: 75
                    }
                ];
            }

            return [];
        });

        DeckService = require('../../../server/services/DeckService');
        GameService = require('../../../server/services/GameService');
    });

    afterEach(function () {
        db.query = originalQuery;
        db.startTransaction = originalStartTransaction;
        db.queryTran = originalQueryTran;
    });

    describe('DeckService.getById win/loss counts', function () {
        it('counts against the deck OWNER, not against the deck id', async function () {
            // The defect: $1 is the deck id, and it was compared to
            // "WinnerId" and "PlayerId", which are USER ids. The record shown
            // on GET /api/decks/:id was therefore meaningless.
            const service = new DeckService({}, {});

            await service.getById(7);

            const { sql } = queries[0];

            expect(sql).toContain('g."WinnerId" = d."UserId"');
            expect(sql).toContain('gp."PlayerId" = d."UserId"');
            // The deck id is still what selects the deck itself...
            expect(sql).toContain('WHERE d."Id" = $1');
            // ...but must never again be compared to a user column.
            expect(sql).not.toMatch(/"WinnerId"\s*(=|!=)\s*\$1/);
            expect(sql).not.toMatch(/"PlayerId"\s*=\s*\$1/);
        });

        it('returns a win rate, like findForUser does', async function () {
            const service = new DeckService({}, {});

            const deck = await service.getById(7);

            expect(queries[0].sql).toContain('AS "WinRate"');
            expect(deck.winRate).toBe(75);
        });

        it('quotes the DeckCount alias so usageCount is populated', async function () {
            // Unquoted, Postgres folds the alias to `deckcount`, mapDeck reads
            // `deck.DeckCount`, gets undefined, and every deck's usage level
            // computed as 0.
            const service = new DeckService({}, {});

            const deck = await service.getById(7);

            expect(queries[0].sql).toContain('AS "DeckCount"');
            expect(queries[0].sql).not.toMatch(/AS DeckCount[,\s]/);
            expect(deck.usageCount).toBe('4');
        });
    });

    describe('DeckService.findForUser', function () {
        it('also quotes the DeckCount alias', async function () {
            const service = new DeckService({}, {});

            await service.findForUser({ id: 3 }, {});

            const listQuery = queries.find((entry) => /FROM "Decks" d/.test(entry.sql));

            expect(listQuery.sql).toContain('AS "DeckCount"');
            expect(listQuery.sql).not.toMatch(/AS DeckCount[,\s]/);
        });
    });

    describe('GameService.create deck resolution', function () {
        it('scopes the deck lookup to the player who owns it', async function () {
            // "Decks" is unique on ("Identity","UserId"). Looking a deck up by
            // Identity alone returns one row per owner, so as soon as two
            // players owned the same deck the INSERT errored and the whole
            // game record was lost to the rollback.
            const service = new GameService(db);

            await service.create({
                gameId: 'game-1',
                gameFormat: 'normal',
                startedAt: new Date(),
                players: [
                    { name: 'alice', deck: 'shared-identity' },
                    { name: 'bob', deck: 'shared-identity' }
                ]
            });

            const inserts = queries.filter((entry) => /INSERT INTO "GamePlayers"/.test(entry.sql));

            expect(inserts).toHaveLength(2);

            for (const insert of inserts) {
                expect(insert.sql).toContain('FROM "Decks" WHERE "Identity" = $3 AND "UserId" =');
                // The unscoped form is what returned multiple rows.
                expect(insert.sql).not.toMatch(/FROM "Decks" WHERE "Identity" = \$3\)/);
            }
        });
    });
});
