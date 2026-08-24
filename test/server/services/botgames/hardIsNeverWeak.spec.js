const BotService = require('../../../../server/services/botgames/BotService');
const { difficultyBand } = require('../../../../server/services/botgames/difficulty');

/**
 * ARCHON (N56): reported as "hard mode for the bots sometimes gives them low
 * decks", and it did.
 *
 * The bot's difficulty is the ARI band its deck comes from - the honest lever,
 * because the brain is deliberately identical at every setting. When a house
 * had nothing rated inside the band, the picker dropped the band ENTIRELY and
 * drew uniformly from the whole imported library. Hard is ARI 90-125; that
 * fallback could hand it a 40.
 *
 * The instinct behind it was right and is kept: a table that opens beats a
 * table that does not. What was wrong was WHICH WAY to relax. Dropping the
 * band abandons the setting's meaning in both directions at once, so a Hard
 * table could come out weaker than an Easy one - the single thing a difficulty
 * setting must never do, and the reason a player reports it rather than
 * shrugging.
 *
 * What is pinned here is the ordering itself, at every step of the ladder:
 * whatever the library holds, Hard reaches for the strong end and Easy for the
 * weak one.
 */
const service = () => Object.create(BotService.prototype);

/** Every pool a setting would ask for, in the order it would ask. */
const attemptsFor = (key) => service().deckAttempts(difficultyBand(key));

describe('a difficulty setting keeps its meaning when the band is empty', function () {
    it('asks for the exact band first, at every setting', function () {
        for (const key of ['easy', 'medium', 'hard']) {
            const band = difficultyBand(key);
            const first = attemptsFor(key)[0];

            expect(first.pool).toEqual({ minAri: band.minAri, maxAri: band.maxAri });
        }
    });

    it('never lets Hard reach downward', function () {
        const band = difficultyBand('hard');

        for (const attempt of attemptsFor('hard')) {
            // Every pool Hard will accept is either inside its band, or open
            // upward from the bottom of it, or explicitly the strongest decks
            // the house has. None of them can return a deck weaker than the
            // band's floor unless the house has nothing at all.
            const floored = attempt.pool.minAri === band.minAri;
            const strongest = attempt.pool.prefer === 'strongest';

            expect(floored || strongest).toBe(true);
            expect(attempt.pool.prefer === 'weakest').toBe(false);
        }
    });

    it('never lets Easy reach upward', function () {
        const band = difficultyBand('easy');

        for (const attempt of attemptsFor('easy')) {
            const capped = attempt.pool.maxAri === band.maxAri;
            const weakest = attempt.pool.prefer === 'weakest';

            expect(capped || weakest).toBe(true);
            expect(attempt.pool.prefer === 'strongest').toBe(false);
        }
    });

    it('ends by reaching for opposite ends of the field', function () {
        const last = (key) => attemptsFor(key).slice(-1)[0].pool;

        // The step that runs on a site with nothing rated anywhere near the
        // band. Even there the ordering has to survive, because "hard" and
        // "easy" are a promise to the player about which deck they will face.
        expect(last('hard').prefer).toBe('strongest');
        expect(last('easy').prefer).toBe('weakest');
    });

    it('leaves Medium drawing from the whole field', function () {
        // Medium is the middle, so the whole library IS its relaxation -
        // preferring either end would make it something other than the middle.
        const attempts = attemptsFor('medium');

        expect(attempts).toHaveLength(2);
        expect(attempts[1].pool).toEqual({});
    });

    it('says out loud when it had to widen', function () {
        // A table quietly playing outside its band is how this went unnoticed;
        // the log line is what makes it an operator's problem rather than a
        // player's surprise.
        for (const key of ['easy', 'hard']) {
            const widened = attemptsFor(key).slice(1);

            expect(widened.length).toBeGreaterThan(0);

            for (const attempt of widened) {
                const note = attempt.note({ label: 'Bulwark' }, difficultyBand(key));

                expect(note).toContain('Bulwark');
                expect(note).toMatch(/strongest|weakest/);
            }
        }
    });
});
