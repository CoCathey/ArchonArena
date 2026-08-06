const RatingService = require('../../../../server/services/rating/RatingService');

/**
 * Pools are archon / sealed / alliance. Databases written before the pool
 * mapping existed also hold rows named after game formats - 'normal' above all -
 * because the rating code stored the raw format. Every client renders what it is
 * given (the web app falls back to the raw pool name), so those rows showed up
 * as a phantom second Amber rating ranked "#1 of 0".
 *
 * Migration 50 removes them. This is the belt to that braces: no client, web or
 * mobile, is ever handed one, even on a database where the migration has not
 * been run.
 */
const serviceReturning = (rows) => {
    const svc = Object.create(RatingService.prototype);

    svc.db = { query: async () => rows };
    svc.getConfig = () => ({ leaderboardMinGames: 5, elo: {}, leaderboardActivityDays: 0 });
    svc.activityWindowSql = () => '';

    return svc;
};

const row = (pool, rating) => ({
    Pool: pool,
    Rating: rating,
    GamesPlayed: 10,
    Rank: '1',
    TotalRated: '4',
    Wins: '6',
    Losses: '4'
});

describe('RatingService.getRatingsForUsername pool filtering', function () {
    it('hides pools that are not real', async function () {
        const ratings = await serviceReturning([
            row('archon', 1305),
            row('normal', 1253),
            row('reversal', 1100),
            row('unchained', 1090)
        ]).getRatingsForUsername('someone');

        expect(ratings.map((r) => r.pool)).toEqual(['archon']);
    });

    // The control: filtering must not quietly eat the real ones.
    it('returns every real pool', async function () {
        const ratings = await serviceReturning([
            row('archon', 1305),
            row('sealed', 1210),
            row('alliance', 1180)
        ]).getRatingsForUsername('someone');

        expect(ratings.map((r) => r.pool)).toEqual(['archon', 'sealed', 'alliance']);
        expect(ratings[0].rating).toBe(1305);
    });

    it('returns nothing rather than a phantom when only legacy rows exist', async function () {
        const ratings = await serviceReturning([row('normal', 1253)]).getRatingsForUsername('x');

        expect(ratings).toEqual([]);
    });
});
