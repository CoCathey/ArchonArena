const TeamRatingService = require('../../../../server/services/rating/TeamRatingService');

/**
 * ARCHON (N7): the team ladder.
 */
describe('TeamRatingService', function () {
    let service;
    let db;
    let client;
    let standings;
    let existingRatings;
    let alreadyRated;
    let config;

    beforeEach(function () {
        config = { enabled: true, defaultRating: 1200, kFactor: 32, ratingFloor: 100 };
        standings = [];
        existingRatings = new Map();
        alreadyRated = false;
        client = { release: vi.fn() };

        db = {
            query: vi.fn().mockImplementation(async (sql, params = []) => {
                if (sql.includes('FROM "TournamentPlayers"')) {
                    return standings;
                }

                if (sql.includes('FROM "TeamEventResults"')) {
                    return alreadyRated ? [{ exists: 1 }] : [];
                }

                if (sql.includes('FROM "TeamRatings"')) {
                    const hit = existingRatings.get(params[0]);

                    return hit ? [hit] : [];
                }

                return [];
            }),
            queryTran: vi.fn().mockResolvedValue([]),
            startTransaction: vi.fn().mockResolvedValue(client)
        };

        service = new TeamRatingService(db, { getSection: () => config });
    });

    const ratingWrites = () =>
        db.queryTran.mock.calls
            .filter(([, sql]) => sql.includes('INSERT INTO "TeamRatings"'))
            .map(([, , params]) => ({ teamId: params[0], pool: params[1], rating: params[2] }));

    const resultWrites = () =>
        db.queryTran.mock.calls
            .filter(([, sql]) => sql.includes('INSERT INTO "TeamEventResults"'))
            .map(([, , params]) => ({ teamId: params[1], rank: params[3] }));

    const twoTeams = () => [
        { TeamId: 1, Name: 'Alpha', Wins: '5', Losses: '1' },
        { TeamId: 2, Name: 'Beta', Wins: '1', Losses: '5' }
    ];

    it('does nothing when team rating is switched off', async function () {
        config.enabled = false;
        standings = twoTeams();

        const result = await service.rateEvent(7, 'archon');

        expect(result.success).toBe(false);
        expect(ratingWrites()).toHaveLength(0);
    });

    it('does not rate a one-team event', async function () {
        standings = [{ TeamId: 1, Name: 'Alpha', Wins: '3', Losses: '0' }];

        const result = await service.rateEvent(7, 'archon');

        expect(result.rated).toBe(0);
        expect(ratingWrites()).toHaveLength(0);
    });

    it('moves the winner up and the loser down', async function () {
        standings = twoTeams();

        const result = await service.rateEvent(7, 'archon');

        expect(result.rated).toBe(2);

        const [alpha, beta] = result.standings;

        expect(alpha.ratingAfter).toBeGreaterThan(alpha.ratingBefore);
        expect(beta.ratingAfter).toBeLessThan(beta.ratingBefore);
    });

    it('ranks on match wins', async function () {
        standings = twoTeams();

        await service.rateEvent(7, 'archon');

        expect(resultWrites()).toEqual([
            { teamId: 1, rank: 1 },
            { teamId: 2, rank: 2 }
        ]);
    });

    it('leaves two teams on the same record where they were', async function () {
        standings = [
            { TeamId: 1, Name: 'Alpha', Wins: '3', Losses: '3' },
            { TeamId: 2, Name: 'Beta', Wins: '3', Losses: '3' }
        ];

        const result = await service.rateEvent(7, 'archon');

        // Both start at the default, both draw: nobody moves.
        expect(result.standings[0].ratingAfter).toBe(result.standings[0].ratingBefore);
        expect(result.standings.every((entry) => entry.rank === 1)).toBe(true);
    });

    /**
     * The reason the per-opponent deltas are averaged rather than summed. If
     * they were summed, a big field would move ratings much further than a
     * small one for the same quality of performance, and the ladder would
     * reward entering the largest event rather than playing best.
     */
    it('does not move a winner further just because the field was bigger', async function () {
        standings = twoTeams();

        const small = await service.rateEvent(7, 'archon');
        const smallGain = small.standings[0].ratingAfter - small.standings[0].ratingBefore;

        db.queryTran.mockClear();
        standings = [
            { TeamId: 1, Name: 'Alpha', Wins: '9', Losses: '0' },
            { TeamId: 2, Name: 'Beta', Wins: '6', Losses: '3' },
            { TeamId: 3, Name: 'Gamma', Wins: '4', Losses: '5' },
            { TeamId: 4, Name: 'Delta', Wins: '2', Losses: '7' },
            { TeamId: 5, Name: 'Epsilon', Wins: '1', Losses: '8' },
            { TeamId: 6, Name: 'Zeta', Wins: '0', Losses: '9' }
        ];

        const large = await service.rateEvent(8, 'archon');
        const largeGain = large.standings[0].ratingAfter - large.standings[0].ratingBefore;

        // Winning a six-team event beats winning a two-team one by at most the
        // K factor, not by three times as much.
        expect(largeGain).toBeLessThanOrEqual(config.kFactor);
        expect(Math.abs(largeGain - smallGain)).toBeLessThanOrEqual(config.kFactor / 2);
    });

    it('is idempotent - finishing an event twice does not rate it twice', async function () {
        standings = twoTeams();
        alreadyRated = true;

        const result = await service.rateEvent(7, 'archon');

        expect(result.alreadyRated).toBe(true);
        expect(ratingWrites()).toHaveLength(0);
    });

    it('seeds an unrated team at the configured default', async function () {
        standings = twoTeams();

        const result = await service.rateEvent(7, 'archon');

        expect(result.standings.every((entry) => entry.ratingBefore === 1200)).toBe(true);
    });

    it('carries an existing rating forward', async function () {
        standings = twoTeams();
        existingRatings.set(1, { Rating: 1500, EventsPlayed: 4 });

        const result = await service.rateEvent(7, 'archon');

        expect(result.standings[0].ratingBefore).toBe(1500);
    });

    it('rates each pool separately, mapped from the event format', async function () {
        standings = twoTeams();

        await service.rateEvent(7, 'sealed');

        expect(ratingWrites().every((write) => write.pool === 'sealed')).toBe(true);
    });

    it('maps engine formats onto the same three pools as the solo ladder', function () {
        expect(service.normalizePool('normal')).toBe('archon');
        expect(service.normalizePool('reversal')).toBe('archon');
        expect(service.normalizePool('alliance')).toBe('alliance');
        expect(service.normalizePool('nonsense')).toBe('archon');
    });

    it('never drops a team below the floor', async function () {
        config.ratingFloor = 1195;
        standings = twoTeams();

        const result = await service.rateEvent(7, 'archon');

        expect(result.standings[1].ratingAfter).toBe(1195);
    });

    it('rolls back and reports failure if a write goes wrong', async function () {
        standings = twoTeams();
        db.queryTran.mockImplementation(async (c, sql) => {
            if (sql.includes('INSERT INTO "TeamRatings"')) {
                throw new Error('connection lost');
            }

            return [];
        });

        const result = await service.rateEvent(7, 'archon');

        expect(result.success).toBe(false);
        expect(db.queryTran.mock.calls.some(([, sql]) => sql === 'ROLLBACK')).toBe(true);
    });
});
