const RatingService = require('../../../../server/services/rating/RatingService');

/**
 * ARCHON (N4): the rating recalculation tool.
 *
 * The load-bearing properties are that it is a dry run unless told otherwise,
 * that replaying under an unchanged config is a no-op, and that it does not
 * quietly undo season resets.
 */
describe('RatingService.recalculateRatings', function () {
    let service;
    let db;
    let client;
    let ratingConfig;

    // One replayable game per entry: winner beat loser in `pool`.
    let historyRows;
    let ratingRows;
    let seasonRows;
    let standingsRows;

    const configService = () => ({
        getValue: (key) => (key === 'rating' ? ratingConfig : undefined)
    });

    const historyRow = (overrides = {}) => ({
        GameId: 1,
        Pool: 'archon',
        WinnerId: 1,
        LoserId: 2,
        WinnerSas: 70,
        LoserSas: 70,
        KeyDiff: 3,
        ResultType: 'keys',
        CreatedAt: '2026-07-01T10:00:00Z',
        IsTournament: false,
        ...overrides
    });

    beforeEach(function () {
        ratingConfig = {};
        historyRows = [];
        ratingRows = [];
        seasonRows = [];
        standingsRows = [];
        client = { release: vi.fn() };

        db = {
            query: vi.fn().mockImplementation(async (sql) => {
                if (sql.includes('FROM "Seasons"')) {
                    return seasonRows;
                }
                if (sql.includes('FROM "SeasonStandings"')) {
                    return standingsRows;
                }
                if (sql.includes('FROM "RatingHistory"')) {
                    return historyRows;
                }
                if (sql.includes('FROM "Ratings"')) {
                    return ratingRows;
                }
                return [];
            }),
            queryTran: vi.fn().mockResolvedValue([]),
            startTransaction: vi.fn().mockResolvedValue(client)
        };

        service = new RatingService(configService(), db);
    });

    describe('safety', function () {
        it('is a dry run by default and writes nothing', async function () {
            historyRows = [historyRow()];
            ratingRows = [
                { UserId: 1, Pool: 'archon', Rating: 1200, GamesPlayed: 1, Username: 'alice' }
            ];

            const result = await service.recalculateRatings();

            expect(result.dryRun).toBe(true);
            expect(result.committed).toBe(false);
            expect(db.startTransaction).not.toHaveBeenCalled();
        });

        it('only commits when confirmation is exactly true', async function () {
            historyRows = [historyRow()];
            ratingRows = [
                { UserId: 1, Pool: 'archon', Rating: 999, GamesPlayed: 1, Username: 'alice' }
            ];

            // Anything truthy-but-not-true must still be a dry run: this
            // rewrites every player's standing and there is no undo.
            for (const confirm of ['true', 1, {}, 'yes']) {
                const result = await service.recalculateRatings({ commit: confirm });
                expect(result.committed).toBe(false);
            }

            expect(db.startTransaction).not.toHaveBeenCalled();
        });

        it('refuses an invalid Elo config before replaying anything', async function () {
            historyRows = [historyRow()];

            const result = await service.recalculateRatings({
                elo: { kFactor: -5 },
                commit: true
            });

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/Invalid Elo configuration/);
            expect(db.startTransaction).not.toHaveBeenCalled();
        });

        it('reports what would change before it changes it', async function () {
            historyRows = [historyRow()];
            ratingRows = [
                { UserId: 1, Pool: 'archon', Rating: 1000, GamesPlayed: 1, Username: 'alice' },
                { UserId: 2, Pool: 'archon', Rating: 1400, GamesPlayed: 1, Username: 'bob' }
            ];

            const result = await service.recalculateRatings();

            expect(result.gamesReplayed).toBe(1);
            expect(result.ratingsCompared).toBe(2);
            expect(result.changed).toBe(2);
            expect(result.movers.map((m) => m.username).sort()).toEqual(['alice', 'bob']);
            expect(result.movers[0]).toHaveProperty('before');
            expect(result.movers[0]).toHaveProperty('after');
            expect(result.movers[0]).toHaveProperty('delta');
        });
    });

    describe('idempotency', function () {
        // The acceptance criterion: replaying under the config that produced
        // the ladder must not move anybody.
        it('is a no-op when the config has not changed', async function () {
            historyRows = [historyRow()];

            // Replay once to find out where the game lands...
            ratingRows = [];
            const first = await service.recalculateRatings();
            expect(first.changed).toBe(0); // nothing to compare against yet

            // ...then set the ladder to exactly that and replay again.
            const replayed = await service.recalculateRatings();
            expect(replayed.gamesReplayed).toBe(1);

            // Derive the settled values by committing once against a known state.
            ratingRows = [
                { UserId: 1, Pool: 'archon', Rating: 1200, GamesPlayed: 1, Username: 'alice' },
                { UserId: 2, Pool: 'archon', Rating: 1200, GamesPlayed: 1, Username: 'bob' }
            ];
            const diff = await service.recalculateRatings();
            const settled = Object.fromEntries(
                diff.movers.map((mover) => [mover.username, mover.after])
            );

            ratingRows = [
                {
                    UserId: 1,
                    Pool: 'archon',
                    Rating: settled.alice,
                    GamesPlayed: 1,
                    Username: 'alice'
                },
                { UserId: 2, Pool: 'archon', Rating: settled.bob, GamesPlayed: 1, Username: 'bob' }
            ];

            const second = await service.recalculateRatings();

            expect(second.changed).toBe(0);
            expect(second.unchanged).toBe(2);
        });

        it('moves ratings when the config genuinely changes', async function () {
            historyRows = [historyRow()];
            ratingRows = [
                { UserId: 1, Pool: 'archon', Rating: 1200, GamesPlayed: 1, Username: 'alice' },
                { UserId: 2, Pool: 'archon', Rating: 1200, GamesPlayed: 1, Username: 'bob' }
            ];

            // provisionalKFactor, not kFactor: a replay starts every player at
            // zero games played, so they are provisional for their first games
            // and the established K never applies to them here.
            const gentle = await service.recalculateRatings({ elo: { provisionalKFactor: 8 } });
            const harsh = await service.recalculateRatings({ elo: { provisionalKFactor: 64 } });

            const gentleWinner = gentle.movers.find((m) => m.username === 'alice');
            const harshWinner = harsh.movers.find((m) => m.username === 'alice');

            // A bigger K must move the winner further from the same start.
            expect(harshWinner.after).toBeGreaterThan(gentleWinner.after);
        });

        it('applies the established K once a seeded player is past provisional', async function () {
            // Seeded from an archived season with plenty of games behind them,
            // so kFactor - not provisionalKFactor - governs.
            seasonRows = [{ Id: 2, StartedAt: '2026-06-01T00:00:00Z' }];
            standingsRows = [
                { UserId: 1, Pool: 'archon', RatingAfterReset: 1200, GamesPlayed: 100 },
                { UserId: 2, Pool: 'archon', RatingAfterReset: 1200, GamesPlayed: 100 }
            ];
            historyRows = [historyRow()];
            ratingRows = [
                { UserId: 1, Pool: 'archon', Rating: 1200, GamesPlayed: 101, Username: 'alice' }
            ];

            const gentle = await service.recalculateRatings({ elo: { kFactor: 8 } });
            const harsh = await service.recalculateRatings({ elo: { kFactor: 64 } });

            expect(harsh.movers[0].after).toBeGreaterThan(gentle.movers[0].after);
        });
    });

    describe('replay', function () {
        it('replays only the winner row, not both sides of a game', async function () {
            historyRows = [historyRow()];

            await service.recalculateRatings();

            const [sql] = db.query.mock.calls.find(([text]) =>
                text.includes('FROM "RatingHistory"')
            );
            // Double-counting every game would be silent and catastrophic.
            expect(sql).toContain('"Won" = true');
        });

        it('replays in chronological order', async function () {
            historyRows = [historyRow()];

            await service.recalculateRatings();

            const [sql] = db.query.mock.calls.find(([text]) =>
                text.includes('FROM "RatingHistory"')
            );
            // Out of order, each game would be fed the wrong "rating before".
            expect(sql).toContain('ORDER BY w."CreatedAt" ASC');
        });

        it('re-derives whether a game was a tournament game', async function () {
            // isTournament is not stored on the history row but changes K, so
            // it has to come back from somewhere.
            historyRows = [historyRow()];

            await service.recalculateRatings();

            const [sql] = db.query.mock.calls.find(([text]) =>
                text.includes('FROM "RatingHistory"')
            );
            expect(sql).toContain('TournamentMatchGames');
        });

        it('accumulates across several games in a pool', async function () {
            historyRows = [
                historyRow({ GameId: 1, CreatedAt: '2026-07-01T10:00:00Z' }),
                historyRow({ GameId: 2, CreatedAt: '2026-07-01T11:00:00Z' }),
                historyRow({ GameId: 3, CreatedAt: '2026-07-01T12:00:00Z' })
            ];
            ratingRows = [
                { UserId: 1, Pool: 'archon', Rating: 1200, GamesPlayed: 3, Username: 'alice' }
            ];

            const result = await service.recalculateRatings();
            const alice = result.movers.find((m) => m.username === 'alice');

            // Three wins from the same start must end above one win.
            historyRows = [historyRow()];
            const single = await service.recalculateRatings();
            const aliceOnce = single.movers.find((m) => m.username === 'alice');

            expect(alice.after).toBeGreaterThan(aliceOnce.after);
        });

        it('keeps pools independent', async function () {
            historyRows = [
                historyRow({ GameId: 1, Pool: 'archon' }),
                historyRow({ GameId: 2, Pool: 'sealed', CreatedAt: '2026-07-01T11:00:00Z' })
            ];
            ratingRows = [
                { UserId: 1, Pool: 'archon', Rating: 1200, GamesPlayed: 1, Username: 'alice' },
                { UserId: 1, Pool: 'sealed', Rating: 1200, GamesPlayed: 1, Username: 'alice' }
            ];

            const result = await service.recalculateRatings();
            const archon = result.movers.find((m) => m.pool === 'archon');
            const sealed = result.movers.find((m) => m.pool === 'sealed');

            // One win in each pool: neither should have accumulated the other's.
            expect(archon.after).toBe(sealed.after);
        });

        it('leaves a rating with no replayed games exactly as it is', async function () {
            // Seeded by a season reset or set by an admin. Inventing a value
            // for it would be a change this tool never actually made.
            historyRows = [];
            ratingRows = [
                { UserId: 9, Pool: 'archon', Rating: 1337, GamesPlayed: 0, Username: 'carol' }
            ];

            const result = await service.recalculateRatings();

            expect(result.changed).toBe(0);
            expect(result.unchanged).toBe(1);
        });
    });

    describe('seasons', function () {
        // The trap this whole design exists to avoid: a season soft-reset moves
        // ratings without writing RatingHistory, so a replay from the beginning
        // of time would hand back Amber a season deliberately took away.
        it('seeds from the archived standings of the previous season', async function () {
            seasonRows = [{ Id: 3, StartedAt: '2026-07-01T00:00:00Z' }];
            standingsRows = [
                { UserId: 1, Pool: 'archon', RatingAfterReset: 1500, GamesPlayed: 40 },
                { UserId: 2, Pool: 'archon', RatingAfterReset: 1100, GamesPlayed: 20 }
            ];
            historyRows = [historyRow()];
            ratingRows = [
                { UserId: 1, Pool: 'archon', Rating: 1500, GamesPlayed: 41, Username: 'alice' }
            ];

            const result = await service.recalculateRatings();

            expect(result.seededFromSeason).toBe(3);
            // Seeded at 1500 and won, so the rebuilt rating is above the seed -
            // not reset to the 1200 default.
            const alice = result.movers.find((m) => m.username === 'alice');
            expect(alice.after).toBeGreaterThan(1500);
        });

        it('asks for the standings of the season that ended, not the current one', async function () {
            seasonRows = [{ Id: 3, StartedAt: '2026-07-01T00:00:00Z' }];
            historyRows = [historyRow()];

            await service.recalculateRatings();

            const call = db.query.mock.calls.find(([sql]) =>
                sql.includes('FROM "SeasonStandings"')
            );
            expect(call[1]).toEqual([2]);
        });

        it('limits the replay to games since the season started', async function () {
            seasonRows = [{ Id: 3, StartedAt: '2026-07-01T00:00:00Z' }];
            historyRows = [historyRow()];

            await service.recalculateRatings();

            const call = db.query.mock.calls.find(([sql]) => sql.includes('FROM "RatingHistory"'));
            expect(call[0]).toContain('"CreatedAt" >=');
            expect(call[1]).toEqual(['2026-07-01T00:00:00Z']);
        });

        it('replays everything when no season has ever been started', async function () {
            seasonRows = [];
            historyRows = [historyRow()];

            await service.recalculateRatings();

            const call = db.query.mock.calls.find(([sql]) => sql.includes('FROM "RatingHistory"'));
            expect(call[0]).not.toContain('"CreatedAt" >=');
            expect(call[1]).toEqual([]);
        });
    });

    describe('committing', function () {
        it('writes the new ratings in one transaction and clears decay', async function () {
            historyRows = [historyRow()];
            ratingRows = [
                { UserId: 1, Pool: 'archon', Rating: 1000, GamesPlayed: 1, Username: 'alice' }
            ];

            const result = await service.recalculateRatings({ commit: true });

            expect(result.committed).toBe(true);
            expect(db.startTransaction).toHaveBeenCalledTimes(1);

            const update = db.queryTran.mock.calls.find(([, sql]) =>
                sql.includes('UPDATE "Ratings"')
            );
            // The rebuilt rating has no relationship to decay already applied
            // to the old one, so the next sweep must re-derive it.
            expect(update[1]).toContain('"LastDecayAt" = NULL');
            expect(db.queryTran.mock.calls.some(([, sql]) => sql === 'COMMIT')).toBe(true);
            expect(client.release).toHaveBeenCalled();
        });

        it('rolls back and reports failure rather than half-rewriting the ladder', async function () {
            historyRows = [historyRow()];
            ratingRows = [
                { UserId: 1, Pool: 'archon', Rating: 1000, GamesPlayed: 1, Username: 'alice' }
            ];
            db.queryTran.mockImplementation(async (c, sql) => {
                if (sql.includes('UPDATE "Ratings"')) {
                    throw new Error('connection lost');
                }
                return [];
            });

            const result = await service.recalculateRatings({ commit: true });

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/nothing changed/i);
            expect(db.queryTran.mock.calls.some(([, sql]) => sql === 'ROLLBACK')).toBe(true);
            expect(client.release).toHaveBeenCalled();
        });
    });
});
