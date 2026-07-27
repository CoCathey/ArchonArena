const StatisticsService = require('../../../server/services/StatisticsService');
const { winRate, sasBandLabel, sasBandCaseSql } = StatisticsService;

describe('StatisticsService pure helpers', function () {
    describe('winRate', function () {
        it('returns a one-decimal percentage', function () {
            expect(winRate(3, 4)).toBe(75);
            expect(winRate(1, 3)).toBe(33.3);
            expect(winRate(2, 2)).toBe(100);
        });

        it('returns null when there are no games', function () {
            expect(winRate(0, 0)).toBeNull();
            expect(winRate(5, 0)).toBeNull();
        });

        it('coerces string counts (node-postgres bigints)', function () {
            expect(winRate('3', '4')).toBe(75);
        });
    });

    describe('sasBandLabel', function () {
        it('buckets ratings into the right band', function () {
            expect(sasBandLabel(45)).toBe('<50');
            expect(sasBandLabel(50)).toBe('50-59');
            expect(sasBandLabel(69)).toBe('60-69');
            expect(sasBandLabel(89)).toBe('80-89');
            expect(sasBandLabel(90)).toBe('90+');
            expect(sasBandLabel(140)).toBe('90+');
            expect(sasBandLabel('75')).toBe('70-79');
        });

        it('returns null for missing or non-numeric input', function () {
            expect(sasBandLabel(null)).toBeNull();
            expect(sasBandLabel(undefined)).toBeNull();
            expect(sasBandLabel('')).toBeNull();
            expect(sasBandLabel('abc')).toBeNull();
        });
    });

    describe('sasBandCaseSql', function () {
        it('builds a CASE that mirrors sasBandLabel', function () {
            expect(sasBandCaseSql('col')).toBe(
                "CASE WHEN col < 50 THEN '<50' WHEN col < 60 THEN '50-59' " +
                    "WHEN col < 70 THEN '60-69' WHEN col < 80 THEN '70-79' " +
                    "WHEN col < 90 THEN '80-89' ELSE '90+' END"
            );
        });
    });
});

describe('StatisticsService.getMetaStats', function () {
    let db;
    let service;

    const metaMock = () => async (sql) => {
        if (sql.includes('"finishedGames"')) {
            return [
                {
                    finishedGames: '10',
                    decidedGames: '8',
                    avgDurationSec: '605.4',
                    avgKeys: '1.875'
                }
            ];
        }
        if (sql.includes('AS "house"')) {
            return [
                { house: 'Logos', games: '6', wins: '4' },
                { house: 'Brobnar', games: '6', wins: '2' }
            ];
        }
        if (sql.includes('AS "format"')) {
            return [
                { format: 'normal', games: '6' },
                { format: 'sealed', games: '2' }
            ];
        }
        if (sql.includes('AS "band"')) {
            return [
                { band: '60-69', games: '4', wins: '3' },
                { band: '<50', games: '4', wins: '1' }
            ];
        }
        return [];
    };

    beforeEach(function () {
        db = { query: vi.fn().mockImplementation(metaMock()) };
        service = new StatisticsService(db);
    });

    it('shapes totals, houses (win-rate desc), formats (share) and SAS bands (ascending)', async function () {
        const stats = await service.getMetaStats();

        expect(stats.totals).toEqual({
            finishedGames: 10,
            decidedGames: 8,
            avgDurationSec: 605,
            avgKeys: 1.88
        });

        expect(stats.houses.map((h) => h.house)).toEqual(['Logos', 'Brobnar']);
        expect(stats.houses[0].winRate).toBe(66.7);
        expect(stats.houses[1].winRate).toBe(33.3);

        expect(stats.formats).toEqual([
            { format: 'normal', games: 6, share: 75 },
            { format: 'sealed', games: 2, share: 25 }
        ]);

        // Sorted back into ascending band order regardless of query order.
        expect(stats.sasBands.map((b) => b.band)).toEqual(['<50', '60-69']);
        expect(stats.sasBands[1].winRate).toBe(75);
    });

    it('handles an empty database without throwing', async function () {
        db.query.mockResolvedValue([]);

        const stats = await service.getMetaStats();

        expect(stats.totals.finishedGames).toBe(0);
        expect(stats.houses).toEqual([]);
        expect(stats.formats).toEqual([]);
        expect(stats.sasBands).toEqual([]);
    });
});

describe('StatisticsService.getPlayerStats', function () {
    let db;
    let service;

    const playerMock = () => async (sql) => {
        if (sql.includes('FROM "Users"')) {
            return [{ Id: 7, Username: 'Alice' }];
        }
        if (sql.includes('AS "avgKeys"')) {
            return [{ games: '5', wins: '3', avgKeys: '1.6', avgDurationSec: '720' }];
        }
        if (sql.includes('AS "format"')) {
            return [
                { format: 'sealed', games: '2', wins: '1' },
                { format: 'normal', games: '3', wins: '2' }
            ];
        }
        if (sql.includes('AS "house"')) {
            return [{ house: 'Mars', games: '5', wins: '3' }];
        }
        return [];
    };

    beforeEach(function () {
        db = { query: vi.fn().mockImplementation(playerMock()) };
        service = new StatisticsService(db);
    });

    it('returns null without querying when no username is given', async function () {
        expect(await service.getPlayerStats('')).toBeNull();
        expect(db.query).not.toHaveBeenCalled();
    });

    it('returns null for an unknown player', async function () {
        db.query.mockResolvedValue([]);

        expect(await service.getPlayerStats('ghost')).toBeNull();
    });

    it('shapes overall, by-format (games desc) and by-house records', async function () {
        const stats = await service.getPlayerStats('alice');

        expect(stats.username).toBe('Alice');
        expect(stats.overall).toEqual({
            games: 5,
            wins: 3,
            losses: 2,
            winRate: 60,
            avgKeys: 1.6,
            avgDurationSec: 720
        });

        expect(stats.formats.map((f) => f.format)).toEqual(['normal', 'sealed']);
        expect(stats.formats[0]).toEqual({
            format: 'normal',
            games: 3,
            wins: 2,
            losses: 1,
            winRate: 66.7
        });

        expect(stats.houses[0]).toEqual({ house: 'Mars', games: 5, wins: 3, winRate: 60 });
    });
});

describe('StatisticsService TTL cache', function () {
    let db;
    let service;
    let clock;

    beforeEach(function () {
        clock = 1000;
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new StatisticsService(db, { ttlMs: 1000, now: () => clock });
    });

    it('serves a cached answer within the TTL and recomputes after it expires', async function () {
        await service.getMetaStats();
        const afterFirst = db.query.mock.calls.length;
        expect(afterFirst).toBeGreaterThan(0);

        // Still within the TTL: no new queries.
        await service.getMetaStats();
        expect(db.query.mock.calls.length).toBe(afterFirst);

        // Past the TTL: recompute (same number of queries again).
        clock += 1001;
        await service.getMetaStats();
        expect(db.query.mock.calls.length).toBe(afterFirst * 2);
    });

    it('caches meta and player answers under separate keys', async function () {
        db.query.mockImplementation(async (sql) =>
            sql.includes('FROM "Users"') ? [{ Id: 1, Username: 'Bob' }] : []
        );

        await service.getMetaStats();
        await service.getPlayerStats('bob');
        const total = db.query.mock.calls.length;

        // Both are now cached; neither re-queries.
        await service.getMetaStats();
        await service.getPlayerStats('bob');
        expect(db.query.mock.calls.length).toBe(total);
    });
});

describe('StatisticsService.getDeckStats', function () {
    const StatisticsService = require('../../../server/services/StatisticsService');

    const serviceWith = (deckRows, bandRows, user = { Id: 7, Username: 'Player1' }) => {
        const db = {
            query: vi.fn(async (sql) => {
                if (sql.includes('FROM "Users"')) {
                    return user ? [user] : [];
                }
                if (sql.includes('GROUP BY d."Id"')) {
                    return deckRows;
                }
                if (sql.includes('GROUP BY "band"')) {
                    return bandRows;
                }
                return [];
            })
        };

        return new StatisticsService(db, { ttlMs: 0 });
    };

    it('reports each deck record and its delta against its SAS band', async function () {
        const service = serviceWith(
            [
                {
                    Id: 1,
                    Name: 'Overperformer',
                    Identity: 'a',
                    SasRating: 75,
                    games: '10',
                    wins: '8',
                    lastPlayed: new Date()
                },
                {
                    Id: 2,
                    Name: 'Underperformer',
                    Identity: 'b',
                    SasRating: 75,
                    games: '10',
                    wins: '2',
                    lastPlayed: new Date()
                }
            ],
            // Decks in the 70-79 band win 50% of the time site-wide.
            [{ band: '70-79', games: '100', wins: '50' }]
        );

        const stats = await service.getDeckStats('player1');

        expect(stats.username).toBe('Player1');
        expect(stats.decks[0]).toMatchObject({
            name: 'Overperformer',
            games: 10,
            wins: 8,
            losses: 2,
            winRate: 80,
            sasBand: '70-79',
            expectedWinRate: 50,
            sasDelta: 30
        });
        expect(stats.decks[1].sasDelta).toBe(-30);
    });

    // An unrated deck has no band, so there is nothing to compare it against —
    // better to say so than to invent an expectation.
    it('leaves the delta null for a deck with no SAS', async function () {
        const service = serviceWith(
            [
                {
                    Id: 3,
                    Name: 'Unrated',
                    Identity: 'c',
                    SasRating: null,
                    games: '4',
                    wins: '2',
                    lastPlayed: null
                }
            ],
            []
        );

        const stats = await service.getDeckStats('player1');

        expect(stats.decks[0].winRate).toBe(50);
        expect(stats.decks[0].sasBand).toBeNull();
        expect(stats.decks[0].expectedWinRate).toBeNull();
        expect(stats.decks[0].sasDelta).toBeNull();
    });

    it('returns null for an unknown player', async function () {
        expect(await serviceWith([], [], null).getDeckStats('nobody')).toBeNull();
    });

    it('returns null without querying when no username is given', async function () {
        const service = serviceWith([], []);

        expect(await service.getDeckStats('')).toBeNull();
        expect(service.db.query).not.toHaveBeenCalled();
    });

    it('returns an empty list for a player who has never finished a game', async function () {
        const stats = await serviceWith([], []).getDeckStats('player1');

        expect(stats.decks).toEqual([]);
    });
});
