const RatingService = require('../../../../server/services/rating/RatingService');

/**
 * "No rating row yet" means two entirely different things, and conflating them
 * is what made finished games tell their players they had not counted.
 *
 * Rating runs asynchronously after GAMEWIN, so the post-game panel's request
 * almost always arrives before the rating is written. The old endpoint answered
 * `rated: false` to that, the client cached it, and nothing ever asked again -
 * a display bug that looked exactly like a rating engine failure.
 */
const service = (rows, config = {}) => {
    const svc = Object.create(RatingService.prototype);

    svc.db = { query: async (sql) => rows(sql) };
    svc.getConfig = () => ({ enabled: true, excludedWinReasons: ['rematch'], ...config });

    return svc;
};

const game = (overrides = {}) => ({
    Id: 1,
    WinnerId: 10,
    WinReason: 'keys',
    FinishedAt: new Date(),
    Players: '2',
    ...overrides
});

const forGame = (overrides, tournament = null) =>
    service((sql) => {
        if (sql.includes('TournamentMatchGames')) {
            return tournament ? [tournament] : [];
        }

        return overrides === null ? [] : [game(overrides)];
    });

describe('RatingService.describeMissingRating', function () {
    it('is pending for a finished two-player game with a winner', async function () {
        // The case that matters: everything says this rates, it just has not
        // happened yet. Reporting "not rated" here is the bug.
        expect(await forGame({}).describeMissingRating('g')).toEqual({ pending: true });
    });

    it('is pending while the game is still in flight', async function () {
        expect(await forGame({ FinishedAt: null }).describeMissingRating('g')).toEqual({
            pending: true
        });
    });

    // The result row is written by the same handler that triggers rating, so a
    // game not in the table yet has simply not got there.
    it('is pending for a game that has not been persisted yet', async function () {
        expect(await forGame(null).describeMissingRating('g')).toEqual({ pending: true });
    });

    it('is not pending, with a reason, when there is no winner', async function () {
        const result = await forGame({ WinnerId: null }).describeMissingRating('g');

        expect(result.pending).toBe(false);
        expect(result.reason).toMatch(/without a winner/i);
    });

    it('is not pending for an excluded win reason', async function () {
        const result = await forGame({ WinReason: 'rematch' }).describeMissingRating('g');

        expect(result.pending).toBe(false);
        expect(result.reason).toMatch(/not rated/i);
    });

    it('is not pending for anything other than two players', async function () {
        for (const players of ['1', '3']) {
            const result = await forGame({ Players: players }).describeMissingRating('g');

            expect(result.pending).toBe(false);
            expect(result.reason).toMatch(/two-player/i);
        }
    });

    it('is not pending for a game in an event marked unrated', async function () {
        const result = await forGame({}, { RatedGames: false }).describeMissingRating('g');

        expect(result.pending).toBe(false);
        expect(result.reason).toMatch(/event is not rated/i);
    });

    // Control for the one above: the same game in a RATED event must still be
    // pending, or the tournament check would be swallowing everything.
    it('is still pending for a game in an event that IS rated', async function () {
        expect(await forGame({}, { RatedGames: true }).describeMissingRating('g')).toEqual({
            pending: true
        });
    });

    it('is not pending when rating is switched off entirely', async function () {
        const svc = service(() => [game()], { enabled: false });
        const result = await svc.describeMissingRating('g');

        expect(result.pending).toBe(false);
        expect(result.reason).toMatch(/switched off/i);
    });

    it('is not pending without a game id', async function () {
        expect((await forGame({}).describeMissingRating(undefined)).pending).toBe(false);
    });
});
