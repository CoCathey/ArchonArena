const RatingService = require('../../../../server/services/rating/RatingService');
const { computeDecay, computeSeasonReset } = RatingService;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1700000000000; // fixed clock (ms)

describe('computeDecay', function () {
    const cfg = { enabled: true, graceDays: 30, pointsPerWeek: 20, floor: 1200 };

    it('does nothing when disabled', function () {
        expect(computeDecay(1500, NOW - 100 * DAY, null, NOW, { enabled: false })).toBeNull();
    });

    it('does nothing within the grace window', function () {
        expect(computeDecay(1500, NOW - 10 * DAY, null, NOW, cfg)).toBeNull();
    });

    it('does nothing until a full week has elapsed past grace', function () {
        // 31 days idle: 1 day past the 30-day grace, not yet a whole week.
        expect(computeDecay(1500, NOW - 31 * DAY, null, NOW, cfg)).toBeNull();
    });

    it('removes pointsPerWeek for each whole week past grace', function () {
        // 44 days idle = 2 whole weeks past a 30-day grace.
        const result = computeDecay(1500, NOW - 44 * DAY, null, NOW, cfg);
        expect(result.newRating).toBe(1460); // 1500 - 2*20
        expect(result.decayThroughMs).toBe(NOW);
    });

    it('never decays below the floor', function () {
        const result = computeDecay(1210, NOW - 44 * DAY, null, NOW, cfg);
        expect(result.newRating).toBe(1200); // 1210 - 40 clamped to floor
    });

    it('resumes from the last decay point (idempotent)', function () {
        // Idle 100 days but already decayed through 7 days ago: only one more week.
        const result = computeDecay(1500, NOW - 100 * DAY, NOW - 7 * DAY, NOW, cfg);
        expect(result.newRating).toBe(1480); // one week only
    });

    it('treats a recent game as active regardless of an old decay marker', function () {
        expect(computeDecay(1500, NOW - 5 * DAY, NOW - 100 * DAY, NOW, cfg)).toBeNull();
    });
});

describe('computeSeasonReset', function () {
    it('fully resets to the baseline at carry 0', function () {
        expect(computeSeasonReset(1600, 1200, 0, 100)).toBe(1200);
    });

    it('leaves the rating unchanged at carry 1', function () {
        expect(computeSeasonReset(1600, 1200, 1, 100)).toBe(1600);
    });

    it('regresses halfway at carry 0.5, above and below baseline', function () {
        expect(computeSeasonReset(1600, 1200, 0.5, 100)).toBe(1400);
        expect(computeSeasonReset(1000, 1200, 0.5, 100)).toBe(1100);
    });

    it('never resets below the floor and clamps carry to [0,1]', function () {
        expect(computeSeasonReset(150, 1200, 0.5, 1000)).toBe(1000);
        expect(computeSeasonReset(1600, 1200, 2, 100)).toBe(1600);
    });
});

describe('RatingService decay & seasons (persistence)', function () {
    let db;
    let service;
    let ratingConfig;

    beforeEach(function () {
        ratingConfig = {};
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new RatingService(
            { getValue: (key) => (key === 'rating' ? ratingConfig : undefined) },
            db
        );
    });

    describe('applyDecay', function () {
        it('is a no-op when decay is disabled', async function () {
            ratingConfig = { decay: { enabled: false } };

            const result = await service.applyDecay(NOW);

            expect(result).toEqual({ decayed: 0, scanned: 0 });
            expect(db.query).not.toHaveBeenCalled();
        });

        it('decays inactive ratings and records the decay point', async function () {
            ratingConfig = {
                decay: { enabled: true, graceDays: 30, pointsPerWeek: 20, floor: 1200 }
            };
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('EXTRACT(EPOCH')) {
                    return [
                        {
                            UserId: 1,
                            Pool: 'archon',
                            Rating: 1500,
                            UpdatedEpoch: (NOW - 44 * DAY) / 1000,
                            DecayEpoch: null
                        }
                    ];
                }
                return [];
            });

            const result = await service.applyDecay(NOW);

            expect(result).toEqual({ decayed: 1, scanned: 1 });
            const update = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE "Ratings"'));
            expect(update[1][0]).toBe(1460); // new rating persisted
        });
    });

    describe('startNewSeason', function () {
        // ARCHON (N4): starting a season now archives the outgoing ladder and
        // resets it in ONE transaction, so the writes go through queryTran
        // rather than query. The soft-reset maths below is unchanged.
        it('soft-resets every rating and records the season', async function () {
            ratingConfig = { season: { carryFactor: 0.5, baseline: 1200 } };
            const client = { release: vi.fn() };

            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "Ratings"')) {
                    return [
                        { UserId: 1, Pool: 'archon', Rating: 1600, GamesPlayed: 20 },
                        { UserId: 2, Pool: 'archon', Rating: 1000, GamesPlayed: 20 }
                    ];
                }
                return [];
            });
            db.startTransaction = vi.fn().mockResolvedValue(client);
            db.queryTran = vi.fn().mockImplementation(async (c, sql) => {
                if (sql.includes('INSERT INTO "Seasons"')) {
                    return [{ Id: 2, StartedAt: '2026-07-01T00:00:00Z' }];
                }
                return [];
            });

            const result = await service.startNewSeason();

            expect(result.success).toBe(true);
            expect(result.season).toBe(2);
            expect(result.adjusted).toBe(2);

            const updates = db.queryTran.mock.calls.filter(([, sql]) =>
                sql.includes('UPDATE "Ratings"')
            );
            expect(updates.length).toBe(2);
            expect(updates[0][2][0]).toBe(1400); // 1600 -> 1200 + 400*0.5
            expect(updates[1][2][0]).toBe(1100); // 1000 -> 1200 - 200*0.5
        });
    });

    describe('getCurrentSeason', function () {
        it('returns the latest season', async function () {
            db.query.mockResolvedValue([{ Id: 3, StartedAt: '2026-01-01T00:00:00Z' }]);

            expect(await service.getCurrentSeason()).toEqual({
                number: 3,
                startedAt: '2026-01-01T00:00:00Z'
            });
        });

        it('defaults to season 1 before any season is started', async function () {
            db.query.mockResolvedValue([]);

            expect(await service.getCurrentSeason()).toEqual({ number: 1, startedAt: null });
        });
    });
});
