const RatingService = require('../../../../server/services/rating/RatingService');

/**
 * ARCHON (N4): the season archive and the leaderboard activity window.
 */
describe('RatingService season archive', function () {
    let service;
    let db;
    let client;
    let ratingConfig;
    let ratingRows;
    let seasonRows;

    const configService = () => ({
        getValue: (key) => (key === 'rating' ? ratingConfig : undefined)
    });

    beforeEach(function () {
        ratingConfig = {};
        ratingRows = [];
        seasonRows = [];
        client = { release: vi.fn() };

        db = {
            query: vi.fn().mockImplementation(async (sql) => {
                if (sql.includes('FROM "Seasons"')) {
                    return seasonRows;
                }
                if (sql.includes('FROM "Ratings"')) {
                    return ratingRows;
                }
                return [];
            }),
            queryTran: vi.fn().mockImplementation(async (c, sql) => {
                if (sql.includes('INSERT INTO "Seasons"')) {
                    return [{ Id: 4, StartedAt: '2026-08-01T00:00:00Z' }];
                }
                return [];
            }),
            startTransaction: vi.fn().mockResolvedValue(client)
        };

        service = new RatingService(configService(), db);
    });

    const standingsInserts = () =>
        db.queryTran.mock.calls.filter(([, sql]) => sql.includes('INSERT INTO "SeasonStandings"'));

    describe('startNewSeason', function () {
        beforeEach(function () {
            seasonRows = [{ Id: 3, StartedAt: '2026-07-01T00:00:00Z' }];
            ratingRows = [
                { UserId: 1, Pool: 'archon', Rating: 1600, GamesPlayed: 40 },
                { UserId: 2, Pool: 'archon', Rating: 1400, GamesPlayed: 10 },
                // Below the games threshold: unranked, but still reset.
                { UserId: 3, Pool: 'archon', Rating: 1300, GamesPlayed: 1 }
            ];
        });

        it('archives the outgoing ladder before resetting it', async function () {
            const result = await service.startNewSeason();

            expect(result.success).toBe(true);
            expect(result.archived).toBe(3);
            expect(standingsInserts()).toHaveLength(3);

            // Archived against the season that ENDED, not the new one.
            expect(standingsInserts()[0][2][0]).toBe(3);
        });

        it('records both halves of the transition on each row', async function () {
            await service.startNewSeason();

            const [, , params] = standingsInserts()[0];
            const [seasonId, userId, pool, rank, rating, gamesPlayed, afterReset] = params;

            expect({ seasonId, userId, pool, rank, rating, gamesPlayed }).toEqual({
                seasonId: 3,
                userId: 1,
                pool: 'archon',
                rank: 1,
                rating: 1600,
                gamesPlayed: 40
            });
            // Default carry of 0.5 toward a 1200 baseline.
            expect(afterReset).toBe(1400);
        });

        it('ranks only the players the leaderboard would have shown', async function () {
            await service.startNewSeason();

            const ranks = standingsInserts().map(([, , params]) => params[3]);

            // Third player has 1 game against a 5-game threshold: unranked,
            // but archived so their reset rating still seeds the next season.
            expect(ranks).toEqual([1, 2, null]);
        });

        it('stamps an end date on the season that just finished', async function () {
            await service.startNewSeason();

            const close = db.queryTran.mock.calls.find(([, sql]) =>
                sql.includes('UPDATE "Seasons"')
            );

            expect(close[1]).toContain('"EndedAt"');
            expect(close[2]).toEqual([3]);
        });

        it('archives and resets in one transaction', async function () {
            // Standings recording a season nobody was reset out of - or a reset
            // with no record of what came before - would both be worse than
            // either alone.
            await service.startNewSeason();

            expect(db.startTransaction).toHaveBeenCalledTimes(1);
            expect(db.queryTran.mock.calls.some(([, sql]) => sql === 'COMMIT')).toBe(true);
            expect(client.release).toHaveBeenCalled();
        });

        it('rolls back and reports failure if anything goes wrong', async function () {
            db.queryTran.mockImplementation(async (c, sql) => {
                if (sql.includes('UPDATE "Ratings"')) {
                    throw new Error('connection lost');
                }
                return [];
            });

            const result = await service.startNewSeason();

            expect(result.success).toBe(false);
            expect(db.queryTran.mock.calls.some(([, sql]) => sql === 'ROLLBACK')).toBe(true);
        });

        it('archives nothing for the very first season', async function () {
            // getCurrentSeason() reports season 1 for a site that has never
            // started one; there is no ladder behind it to archive.
            seasonRows = [];

            const result = await service.startNewSeason();

            expect(result.archived).toBe(0);
            expect(standingsInserts()).toHaveLength(0);
            // ...but the ratings are still reset.
            expect(
                db.queryTran.mock.calls.filter(([, sql]) => sql.includes('UPDATE "Ratings"'))
            ).toHaveLength(3);
        });
    });

    describe('reading the archive', function () {
        it('returns a season list with the current one flagged', async function () {
            db.query.mockResolvedValue([
                { Id: 3, StartedAt: '2026-07-01', EndedAt: null, ranked: '0' },
                { Id: 2, StartedAt: '2026-06-01', EndedAt: '2026-07-01', ranked: '42' }
            ]);

            const seasons = await service.getSeasons();

            expect(seasons[0]).toMatchObject({ number: 3, current: true, rankedPlayers: 0 });
            expect(seasons[1]).toMatchObject({ number: 2, current: false, rankedPlayers: 42 });
        });

        it('reports what the reset did to each archived finisher', async function () {
            db.query.mockResolvedValue([
                {
                    Rank: 1,
                    Rating: 1600,
                    GamesPlayed: 40,
                    RatingAfterReset: 1400,
                    Username: 'alice',
                    Country: 'US',
                    State: null,
                    Settings_Avatar: null
                }
            ]);

            const standings = await service.getSeasonStandings(2, { pool: 'archon' });

            expect(standings.season).toBe(2);
            expect(standings.entries[0]).toMatchObject({
                rank: 1,
                username: 'alice',
                rating: 1600,
                ratingAfterReset: 1400,
                resetDelta: -200
            });
        });

        it('rejects a season id that is not a number', async function () {
            expect(await service.getSeasonStandings('nonsense')).toBeNull();
            expect(await service.getSeasonStandings(undefined)).toBeNull();
        });

        it('gives a player their own finishes newest first', async function () {
            db.query.mockResolvedValue([
                {
                    SeasonId: 2,
                    Pool: 'archon',
                    Rank: 3,
                    Rating: 1550,
                    GamesPlayed: 30,
                    RatingAfterReset: 1375,
                    StartedAt: '2026-06-01',
                    EndedAt: '2026-07-01'
                }
            ]);

            const history = await service.getSeasonHistoryForUsername('alice');

            expect(history[0]).toMatchObject({
                season: 2,
                pool: 'archon',
                rank: 3,
                rating: 1550,
                ratingAfterReset: 1375,
                resetDelta: -175
            });
        });

        it('returns nothing rather than querying for a missing username', async function () {
            expect(await service.getSeasonHistoryForUsername('')).toEqual([]);
            expect(db.query).not.toHaveBeenCalled();
        });
    });
});

describe('RatingService leaderboard activity window', function () {
    let service;
    let db;
    let ratingConfig;

    const configService = () => ({
        getValue: (key) => (key === 'rating' ? ratingConfig : undefined)
    });

    beforeEach(function () {
        ratingConfig = {};
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new RatingService(configService(), db);
    });

    it('is off by default, so a young ladder shows everyone', async function () {
        await service.getLeaderboard({ pool: 'archon' });

        expect(db.query.mock.calls[0][0]).not.toContain('interval');
    });

    it('filters the board to recently active players when configured', async function () {
        ratingConfig = { leaderboardActivityDays: 45 };

        await service.getLeaderboard({ pool: 'archon' });

        expect(db.query.mock.calls[0][0]).toContain("interval '45 days'");
        expect(db.query.mock.calls[0][0]).toContain('r."UpdatedAt" >=');
    });

    // The property that matters: if the board and the rank disagreed, a player
    // would see "#3 of 40" next to a board that lists a different 40.
    it('applies the same window to the rank and field size on a profile', async function () {
        ratingConfig = { leaderboardActivityDays: 45 };

        await service.getRatingsForUsername('alice');

        const [sql] = db.query.mock.calls[0];
        expect(sql).toContain('r2."UpdatedAt" >=');
        expect(sql).toContain('r3."UpdatedAt" >=');
    });

    it('leaves rank and field size unfiltered when the window is off', async function () {
        await service.getRatingsForUsername('alice');

        expect(db.query.mock.calls[0][0]).not.toContain('interval');
    });

    it('ignores a nonsensical window rather than emitting broken SQL', async function () {
        for (const days of [0, -5, 'abc', null]) {
            ratingConfig = { leaderboardActivityDays: days };
            expect(service.activityWindowSql(service.getConfig(), 'r')).toBe('');
        }
    });
});
