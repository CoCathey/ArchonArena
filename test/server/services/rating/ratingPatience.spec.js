const RatingService = require('../../../../server/services/rating/RatingService');
const logger = require('../../../../server/log');

/**
 * ARCHON (N35): what a player is told while a rating is in flight.
 *
 * "Rating this game..." resolving to "this game was not rated" is the single
 * most alarming thing the post-game panel can say, and it was what the panel
 * said whenever rating took longer than fifteen seconds - about a game that was
 * being rated as the player read it. Running out of patience is not a verdict.
 *
 * The server half of that is here: the distinction between "never will be, and
 * here is why" and "not yet" has to survive, and slowness has to be visible in
 * the logs, because a spinner on someone's screen was the only evidence it was
 * happening at all.
 */
describe('rating patience', function () {
    let service;
    let db;
    let warnings;
    let errors;

    beforeEach(function () {
        warnings = [];
        errors = [];
        vi.spyOn(logger, 'warn').mockImplementation((message) => warnings.push(message));
        vi.spyOn(logger, 'error').mockImplementation((message) => errors.push(message));
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new RatingService({ getValue: () => ({}) }, db);
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    describe('how long it took', function () {
        it('says nothing about a rating that landed promptly', async function () {
            service.processGameInner = vi.fn().mockResolvedValue(undefined);

            await service.processGame('game-1');

            expect(warnings).toEqual([]);
        });

        it('names a slow rating, because a player was watching it', async function () {
            service.processGameInner = vi.fn(
                () => new Promise((resolve) => setTimeout(resolve, 1100))
            );

            await service.processGame('game-2');

            expect(warnings.some((message) => /took \d+ms/.test(message))).toBe(true);
            expect(warnings.some((message) => message.includes('game-2'))).toBe(true);
        });

        it('reports how long a failure took, not just that it failed', async function () {
            service.processGameInner = vi.fn().mockRejectedValue(new Error('nope'));

            await service.processGame('game-3');

            expect(errors.some((message) => /after \d+ms/.test(message))).toBe(true);
        });

        it('still swallows the failure - rating must never take a game down', async function () {
            service.processGameInner = vi.fn().mockRejectedValue(new Error('nope'));

            await expect(service.processGame('game-4')).resolves.toBeUndefined();
        });
    });

    describe('describeMissingRating', function () {
        const answer = (handlers) =>
            db.query.mockImplementation(async (sql) => {
                for (const [fragment, rows] of handlers) {
                    if (sql.includes(fragment)) {
                        return rows;
                    }
                }

                return [];
            });

        it('says "not yet" for a finished two-player game with a winner', async function () {
            answer([
                [
                    'FROM "Games" g WHERE',
                    [
                        {
                            Id: 1,
                            WinnerId: 5,
                            WinReason: 'keys',
                            FinishedAt: new Date(),
                            BotGame: false,
                            Players: 2
                        }
                    ]
                ]
            ]);

            // The case the panel must keep waiting on. Anything else here and a
            // player is told their game did not count while it is being counted.
            expect(await service.describeMissingRating('game-5')).toEqual({ pending: true });
        });

        it('settles immediately on a practice game rather than making anyone wait', async function () {
            answer([
                [
                    'FROM "Games" g WHERE',
                    [
                        {
                            Id: 1,
                            WinnerId: 5,
                            WinReason: 'keys',
                            FinishedAt: new Date(),
                            BotGame: true,
                            Players: 2
                        }
                    ]
                ]
            ]);

            const missing = await service.describeMissingRating('game-6');

            expect(missing.pending).toBe(false);
            expect(missing.reason).toContain('bot');
        });

        it('waits on a game that has not reached the table yet', async function () {
            answer([['FROM "Games" g WHERE', []]]);

            expect(await service.describeMissingRating('game-7')).toEqual({ pending: true });
        });
    });
});
