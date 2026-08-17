const fs = require('fs');
const path = require('path');

/**
 * ARCHON (F9): a practice game is recorded, and is never a result.
 *
 * Games against a bot are now written to "Games" so a player can find them
 * again and watch the replay - which is exactly the change that makes this
 * spec necessary. Every statistic on the site selects finished games with
 * the same shape:
 *
 *     WHERE g."FinishedAt" IS NOT NULL [AND g."WinnerId" IS NOT NULL]
 *
 * so a bot row in that table is a real result in thirty places at once
 * unless every one of them says otherwise. Thirty places is too many to
 * remember, and the failure is silent: nobody notices a win rate that is
 * quietly two points off.
 *
 * So the rule is enforced by reading the source. Any aggregate that selects
 * finished games must exclude bot games in the same breath. A query that
 * forgets fails here, at the moment it is written, rather than in somebody's
 * deck record months later.
 *
 * LISTINGS are the deliberate exception, and are named one by one below: a
 * player's game history and their profile's recent games SHOW practice games
 * (that is the point of recording them). The line is "listings show them,
 * numbers do not count them".
 */

const SERVER = path.join(__dirname, '..', '..', '..', 'server');

/** Files whose finished-game queries are listings, not aggregates. */
const LISTING_FILES = new Set([
    // A player's own game history, and the filter options built from it.
    path.join(SERVER, 'services', 'GameService.js'),
    // The recent games shown on a profile.
    path.join(SERVER, 'services', 'community', 'PlayerProfileService.js')
]);

const jsFilesUnder = (dir) => {
    const found = [];

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            found.push(...jsFilesUnder(full));
        } else if (entry.name.endsWith('.js')) {
            found.push(full);
        }
    }

    return found;
};

/**
 * Every line that filters on a finished game, with the file it came from.
 * Read line by line because that is how these queries are written - one
 * concatenated string fragment per line.
 */
const finishedGameLines = () => {
    const lines = [];

    for (const file of jsFilesUnder(SERVER)) {
        const source = fs.readFileSync(file, 'utf8').split('\n');

        source.forEach((line, index) => {
            if (line.includes('"FinishedAt" IS NOT NULL')) {
                lines.push({ file, line: line.trim(), number: index + 1 });
            }
        });
    }

    return lines;
};

describe('bot games are recorded but never counted', function () {
    it('excludes bot games from every aggregate over finished games', function () {
        const offenders = finishedGameLines()
            .filter((entry) => !LISTING_FILES.has(entry.file))
            .filter((entry) => !entry.line.includes('BotGame'));

        expect(
            offenders.map(
                (entry) => `${path.relative(SERVER, entry.file)}:${entry.number} ${entry.line}`
            )
        ).toEqual([]);
    });

    it('still has aggregates to protect, so the check above cannot pass vacuously', function () {
        const guarded = finishedGameLines().filter((entry) => entry.line.includes('BotGame'));

        expect(guarded.length).toBeGreaterThan(15);
    });

    it('keeps showing practice games in the listings that are meant to show them', function () {
        const listingLines = finishedGameLines().filter((entry) => LISTING_FILES.has(entry.file));

        // A player's history is where these games are FOUND. If a future
        // change filters them out here, recording them stopped being useful.
        expect(listingLines.length).toBeGreaterThan(0);
        expect(listingLines.every((entry) => !entry.line.includes('BotGame'))).toBe(true);
    });

    it('never rates one, whatever calls the rating engine', function () {
        const ratingSource = fs.readFileSync(
            path.join(SERVER, 'services', 'rating', 'RatingService.js'),
            'utf8'
        );

        // The router declines to call processGame for a bot game; this is the
        // second guard, in the function that actually moves somebody's Amber.
        expect(ratingSource).toContain('BotGame');
    });
});
