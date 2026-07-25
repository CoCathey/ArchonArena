const RatingService = require('../../../../server/services/rating/RatingService');

describe('RatingService', function () {
    let service;
    let db;
    let client;
    let ratingConfig;

    const GAME_UUID = 'game-uuid-1';

    const gameRows = (overrides = {}) => [
        {
            GameDbId: 10,
            GameFormat: 'archon',
            WinnerId: 1,
            WinReason: 'keys',
            PlayerId: 1,
            Keys: 3,
            DeckUuid: 'deck-a',
            SasRating: 70,
            ...overrides.winner
        },
        {
            GameDbId: 10,
            GameFormat: 'archon',
            WinnerId: 1,
            WinReason: 'keys',
            PlayerId: 2,
            Keys: 1,
            DeckUuid: 'deck-b',
            SasRating: 70,
            ...overrides.loser
        }
    ];

    const configService = () => ({
        getValue: (key) => (key === 'rating' ? ratingConfig : undefined)
    });

    beforeEach(function () {
        ratingConfig = {};
        client = { release: vi.fn() };
        db = {
            query: vi.fn().mockResolvedValue([]),
            // The winner's RatingHistory insert is the idempotency gate and
            // uses RETURNING "Id"; a real insert yields one row. Other tran
            // statements (Ratings upserts, loser history, COMMIT/ROLLBACK)
            // don't have their return value inspected.
            queryTran: vi.fn().mockImplementation(async (c, sql) => {
                if (sql && sql.includes('INSERT INTO "RatingHistory"')) {
                    return [{ Id: 1 }];
                }
                return [];
            }),
            startTransaction: vi.fn().mockResolvedValue(client)
        };
        service = new RatingService(configService(), db);
    });

    const primeHappyPath = (rows) => {
        db.query.mockImplementation(async (sql) => {
            if (sql.includes('FROM "Games"')) {
                return rows;
            }
            if (sql.includes('FROM "RatingHistory"')) {
                return []; // not yet rated
            }
            if (sql.includes('FROM "Ratings"')) {
                return []; // no rating yet -> defaults
            }
            return [];
        });
    };

    describe('resultTypeFromWinReason', function () {
        it('maps engine reasons onto calculator result types', function () {
            expect(service.resultTypeFromWinReason('keys')).toBe('keys');
            expect(service.resultTypeFromWinReason('concede')).toBe('concede');
            expect(service.resultTypeFromWinReason('clock')).toBe('timeout');
            expect(service.resultTypeFromWinReason('keys after time')).toBe('timeout');
            expect(service.resultTypeFromWinReason('first player after time')).toBe('timeout');
            expect(service.resultTypeFromWinReason(undefined)).toBe('keys');
        });
    });

    describe('processGame', function () {
        it('rates a finished 2 player game', async function () {
            primeHappyPath(gameRows());

            await service.processGame(GAME_UUID);

            // Two rating upserts + two history inserts + COMMIT
            const tranSql = db.queryTran.mock.calls.map(([, sql]) => sql || '');
            expect(tranSql.filter((sql) => sql.includes('INSERT INTO "Ratings"')).length).toBe(2);
            expect(
                tranSql.filter((sql) => sql.includes('INSERT INTO "RatingHistory"')).length
            ).toBe(2);
            expect(db.queryTran).toHaveBeenCalledWith(client, 'COMMIT');
            expect(client.release).toHaveBeenCalled();
        });

        it('writes symmetric rating changes for even new players', async function () {
            primeHappyPath(gameRows());

            await service.processGame(GAME_UUID);

            const ratingInserts = db.queryTran.mock.calls.filter(([, sql]) =>
                (sql || '').includes('INSERT INTO "Ratings"')
            );
            const winnerParams = ratingInserts[0][2];
            const loserParams = ratingInserts[1][2];

            // Even 1200 vs 1200, 3-1 keys, provisional K=64: 64*1.1*0.5 ~ 35
            expect(winnerParams[2]).toBe(1235);
            expect(loserParams[2]).toBe(1165);
            expect(winnerParams[3]).toBe(1); // games played incremented
        });

        it('rates every 2 player game regardless of any former game type', async function () {
            // Game types (beginner/casual/competitive) have been removed: a
            // finished 2-player game with a winner always rates now.
            primeHappyPath(gameRows());

            await service.processGame(GAME_UUID);

            const tranSql = db.queryTran.mock.calls.map(([, sql]) => sql || '');
            expect(tranSql.filter((sql) => sql.includes('INSERT INTO "Ratings"')).length).toBe(2);
            expect(db.queryTran).toHaveBeenCalledWith(client, 'COMMIT');
        });

        it('skips games from unrated tournaments', async function () {
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "Games"')) {
                    return gameRows();
                }
                if (sql.includes('FROM "TournamentMatchGames"')) {
                    return [{ RatedGames: false }];
                }
                return [];
            });

            await service.processGame(GAME_UUID);

            expect(db.startTransaction).not.toHaveBeenCalled();
        });

        it('applies the tournament K multiplier for rated tournaments', async function () {
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "Games"')) {
                    return gameRows();
                }
                if (sql.includes('FROM "TournamentMatchGames"')) {
                    return [{ RatedGames: true }];
                }
                return [];
            });

            await service.processGame(GAME_UUID);

            const ratingInserts = db.queryTran.mock.calls.filter(([, sql]) =>
                (sql || '').includes('INSERT INTO "Ratings"')
            );

            expect(ratingInserts.length).toBe(2);

            // Same even matchup as the base case (~+35) but boosted by
            // the default tournamentKMultiplier (1.1): 64*1.1*1.1*0.5 ~ 39.
            const winnerParams = ratingInserts[0][2];
            expect(winnerParams[2]).toBeGreaterThan(1235);
        });

        it('skips games with no winner', async function () {
            primeHappyPath(gameRows({ winner: { WinnerId: null }, loser: { WinnerId: null } }));

            await service.processGame(GAME_UUID);

            expect(db.startTransaction).not.toHaveBeenCalled();
        });

        it('skips games without exactly two players', async function () {
            db.query.mockResolvedValue([gameRows()[0]]);

            await service.processGame(GAME_UUID);

            expect(db.startTransaction).not.toHaveBeenCalled();
        });

        it('skips already-rated games (idempotency)', async function () {
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "Games"')) {
                    return gameRows();
                }
                if (sql.includes('FROM "RatingHistory"')) {
                    return [{ 1: 1 }];
                }
                return [];
            });

            await service.processGame(GAME_UUID);

            expect(db.startTransaction).not.toHaveBeenCalled();
        });

        it('does not touch Ratings when the history insert conflicts (concurrent gate)', async function () {
            // Pre-check passes (not yet rated) but a concurrent run committed
            // the history row first, so our RETURNING insert yields no rows.
            primeHappyPath(gameRows());
            db.queryTran.mockImplementation(async (c, sql) => {
                if (sql && sql.includes('INSERT INTO "RatingHistory"')) {
                    return []; // ON CONFLICT DO NOTHING -> already rated
                }
                return [];
            });

            await service.processGame(GAME_UUID);

            const tranSql = db.queryTran.mock.calls.map(([, sql]) => sql || '');
            expect(tranSql.filter((sql) => sql.includes('INSERT INTO "Ratings"')).length).toBe(0);
            expect(db.queryTran).toHaveBeenCalledWith(client, 'ROLLBACK');
            expect(client.release).toHaveBeenCalled();
        });

        it('skips rematch-overwritten results', async function () {
            primeHappyPath(
                gameRows({ winner: { WinReason: 'rematch' }, loser: { WinReason: 'rematch' } })
            );

            await service.processGame(GAME_UUID);

            expect(db.startTransaction).not.toHaveBeenCalled();
        });

        it('does nothing when disabled by config', async function () {
            ratingConfig = { enabled: false };

            await service.processGame(GAME_UUID);

            expect(db.query).not.toHaveBeenCalled();
        });

        it('rolls back and releases on persistence failure without throwing', async function () {
            primeHappyPath(gameRows());
            db.queryTran.mockRejectedValueOnce(new Error('db down'));

            await expect(service.processGame(GAME_UUID)).resolves.toBeUndefined();

            expect(db.queryTran).toHaveBeenCalledWith(client, 'ROLLBACK');
            expect(client.release).toHaveBeenCalled();
        });

        it('uses stored ratings and SAS to favor the underdog', async function () {
            const rows = gameRows({
                winner: { SasRating: 55 },
                loser: { SasRating: 90 }
            });
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "Games"')) {
                    return rows;
                }
                if (sql.includes('FROM "RatingHistory"')) {
                    return [];
                }
                if (sql.includes('FROM "Ratings"')) {
                    // Both established at 1200 so provisional K does not apply
                    return [{ Rating: 1200, GamesPlayed: 50 }];
                }
                return [];
            });

            await service.processGame(GAME_UUID);

            const ratingInserts = db.queryTran.mock.calls.filter(([, sql]) =>
                (sql || '').includes('INSERT INTO "Ratings"')
            );
            const winnerNewRating = ratingInserts[0][2][2];

            // Winning with a 35-SAS-weaker deck must pay more than the
            // even-deck exchange (32*1.1*0.5 ~ 18)
            expect(winnerNewRating).toBeGreaterThan(1218);
        });
    });

    describe('getRatingsForUsername', function () {
        it('returns pools with provisional flags, rank, field size and W-L', async function () {
            db.query.mockResolvedValue([
                {
                    Pool: 'archon',
                    Rating: 1250,
                    GamesPlayed: 3,
                    Rank: '12',
                    TotalRated: '340',
                    Wins: '2',
                    Losses: '1'
                },
                {
                    Pool: 'sealed',
                    Rating: 1400,
                    GamesPlayed: 40,
                    Rank: '3',
                    TotalRated: '88',
                    Wins: '25',
                    Losses: '15'
                }
            ]);

            const ratings = await service.getRatingsForUsername('Player1');

            expect(ratings).toEqual([
                {
                    pool: 'archon',
                    rating: 1250,
                    gamesPlayed: 3,
                    provisional: true,
                    rank: 12,
                    totalRated: 340,
                    wins: 2,
                    losses: 1
                },
                {
                    pool: 'sealed',
                    rating: 1400,
                    gamesPlayed: 40,
                    provisional: false,
                    rank: 3,
                    totalRated: 88,
                    wins: 25,
                    losses: 15
                }
            ]);
        });
    });

    describe('admin rating tools', function () {
        const primeUserLookup = (id) => {
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "Users"')) {
                    return id ? [{ Id: id }] : [];
                }
                return [];
            });
        };

        it('adminSetRating upserts the rating for a known player', async function () {
            primeUserLookup(7);

            const result = await service.adminSetRating('Player1', 'archon', 1500, 20);

            expect(result.success).toBe(true);
            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO "Ratings"'),
                [7, 'archon', 1500, 20]
            );
        });

        it('adminSetRating keeps existing games when none given', async function () {
            primeUserLookup(7);

            await service.adminSetRating('Player1', 'archon', 1500);

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('COALESCE($4, "Ratings"."GamesPlayed")'),
                [7, 'archon', 1500, null]
            );
        });

        it('adminSetRating validates player and value', async function () {
            primeUserLookup(null);
            expect((await service.adminSetRating('Ghost', 'archon', 1500)).success).toBe(false);

            primeUserLookup(7);
            expect((await service.adminSetRating('Player1', 'archon', -5)).success).toBe(false);
            expect((await service.adminSetRating('Player1', 'archon', 'lots')).success).toBe(false);
        });

        it('adminResetRatings deletes one pool or all pools', async function () {
            primeUserLookup(7);

            await service.adminResetRatings('Player1', 'archon');
            expect(db.query).toHaveBeenCalledWith(expect.stringContaining('AND "Pool" = $2'), [
                7,
                'archon'
            ]);

            await service.adminResetRatings('Player1');
            expect(db.query).toHaveBeenCalledWith('DELETE FROM "Ratings" WHERE "UserId" = $1', [7]);
        });
    });

    describe('setLocation', function () {
        it('stores a valid country uppercased with its state', async function () {
            const result = await service.setLocation(5, 'us', 'Texas');

            expect(result).toEqual({
                success: true,
                country: 'US',
                state: 'Texas',
                region: 'NA'
            });
            expect(db.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE "Users"'), [
                'US',
                'Texas',
                5
            ]);
        });

        it('rejects unknown country codes without writing', async function () {
            const result = await service.setLocation(5, 'ZZ', 'Somewhere');

            expect(result.success).toBe(false);
            expect(db.query).not.toHaveBeenCalled();
        });

        it('clears state when country is cleared', async function () {
            const result = await service.setLocation(5, null, 'Texas');

            expect(result.success).toBe(true);
            expect(db.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE "Users"'), [
                null,
                null,
                5
            ]);
        });
    });

    describe('getLeaderboard', function () {
        const leaderboardRow = (username, rating, extra = {}) => ({
            Username: username,
            Country: 'US',
            State: 'TX',
            Rating: rating,
            GamesPlayed: 20,
            ...extra
        });

        it('returns ranked world entries', async function () {
            db.query.mockResolvedValue([
                leaderboardRow('Alice', 1500),
                leaderboardRow('Bob', 1400)
            ]);

            const board = await service.getLeaderboard({ pool: 'archon' });

            expect(board.entries[0]).toMatchObject({
                rank: 1,
                username: 'Alice',
                rating: 1500,
                provisional: false
            });
            expect(board.entries[1].rank).toBe(2);

            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('"GamesPlayed" >= $2');
            expect(params[0]).toBe('archon');
        });

        it('continues rank numbers across pages', async function () {
            db.query.mockResolvedValue([leaderboardRow('Cara', 1300)]);

            const board = await service.getLeaderboard({ pool: 'archon', offset: 50 });

            expect(board.entries[0].rank).toBe(51);
        });

        it('filters region scope by that regions country list', async function () {
            db.query.mockResolvedValue([]);

            await service.getLeaderboard({ pool: 'archon', scope: 'region', region: 'NA' });

            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('= ANY($3)');
            expect(params[2]).toEqual(expect.arrayContaining(['US', 'CA', 'MX']));
        });

        it('returns empty for an unknown region without querying', async function () {
            const board = await service.getLeaderboard({
                pool: 'archon',
                scope: 'region',
                region: 'NOPE'
            });

            expect(board.entries).toEqual([]);
            expect(db.query).not.toHaveBeenCalled();
        });

        it('filters state scope by country and state', async function () {
            db.query.mockResolvedValue([]);

            await service.getLeaderboard({
                pool: 'archon',
                scope: 'state',
                country: 'us',
                state: 'Texas'
            });

            const [sql, params] = db.query.mock.calls[0];
            expect(sql).toContain('u."Country" = $3');
            expect(sql).toContain('lower(u."State") = lower($4)');
            expect(params[2]).toBe('US');
            expect(params[3]).toBe('Texas');
        });

        it('caps the limit at the configured maximum', async function () {
            db.query.mockResolvedValue([]);

            await service.getLeaderboard({ pool: 'archon', limit: 5000 });

            const [sql, params] = db.query.mock.calls[0];
            const limitParam = params[params.length - 2];
            expect(limitParam).toBe(100);
            expect(sql).toContain('LIMIT');
        });
    });
});
