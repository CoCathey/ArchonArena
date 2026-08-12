#!/usr/bin/env node
/*eslint no-console: 0*/

/*
 * Rate finished games that were never rated.
 *
 * Games are normally rated by the GAMEWIN hook in server/gamerouter.js, which
 * runs `gameService.update -> saveReplay -> ratingService.processGame` as one
 * promise chain. Because those are chained rather than independent, anything
 * that rejects earlier in the chain skips rating entirely - and rating is
 * deliberately best-effort, so the game still finishes and nobody notices until
 * someone asks why the ladder stopped moving. A deployment whose database was
 * missing the GameReplays table hit exactly that.
 *
 * This finds those games and puts them back through the same processGame the
 * live hook uses. It is not a recalculation: `recalculateRatings` replays the
 * existing RatingHistory and cannot invent rows for games that never produced
 * any, which is precisely the case here.
 *
 * Order matters. Each rating depends on the players' ratings at the time, so
 * games are processed oldest-first; doing them in any other order produces
 * different (wrong) numbers.
 *
 * Dry run by default:
 *   npm run backfill:ratings              list what would be rated
 *   npm run backfill:ratings -- --commit  actually rate them
 */
const ConfigService = require('../services/ConfigService');
const RatingService = require('../services/rating/RatingService');
const db = require('../db');

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : null;

async function main() {
    const configService = new ConfigService();
    const ratingService = new RatingService(configService);

    const config = ratingService.getConfig();

    if (!config.enabled) {
        console.error('Rating is disabled in configuration - nothing would be written.');
        console.error('Enable it in Site Settings (or config) before backfilling.');
        process.exit(1);
    }

    // Games the live hook should have rated and did not: finished, two players,
    // a winner, no RatingHistory - minus the two populations that are
    // *permanently* unratable by design, so this list stays actionable rather
    // than accumulating games that will never rate no matter how often it runs.
    // That matters because the health check alarms on it being non-empty.
    //
    // processGame remains the authority on whether any given game rates; these
    // filters only decide what is worth reporting. If they ever disagree, the
    // game is simply reported and then declines to rate, which is handled.
    const candidates = await db.query(
        'SELECT g."Id", g."GameId", g."FinishedAt", g."GameFormat", g."WinReason" ' +
            'FROM "Games" g ' +
            'WHERE g."FinishedAt" IS NOT NULL ' +
            'AND g."WinnerId" IS NOT NULL ' +
            'AND (SELECT count(*) FROM "GamePlayers" gp WHERE gp."GameId" = g."Id") = 2 ' +
            'AND NOT EXISTS (SELECT 1 FROM "RatingHistory" rh WHERE rh."GameId" = g."Id") ' +
            // Rematches and similar are excluded from rating on purpose.
            'AND (g."WinReason" IS NULL OR NOT (g."WinReason" = ANY($1))) ' +
            // A game in an event whose organiser marked it unrated never
            // touches the ladder, by design.
            'AND NOT EXISTS (' +
            'SELECT 1 FROM "TournamentMatchGames" tmg ' +
            'JOIN "Tournaments" t ON t."Id" = tmg."TournamentId" ' +
            'WHERE tmg."GameUuid" = g."GameId" AND t."RatedGames" = false) ' +
            'ORDER BY g."FinishedAt" ASC',
        [config.excludedWinReasons || []]
    );

    const games = limit && limit > 0 ? candidates.slice(0, limit) : candidates;

    if (games.length === 0) {
        console.log('No unrated finished games. Nothing to do.');

        return;
    }

    console.log(`${games.length} finished game(s) have no rating rows:\n`);
    for (const game of games) {
        console.log(
            `  #${game.Id}  ${new Date(game.FinishedAt).toISOString()}  ` +
                `${game.GameFormat || '?'}  ${game.WinReason || '(no reason)'}`
        );
    }

    if (!commit) {
        console.log('\nDry run - nothing was written. To rate these, run:\n');
        // ARCHON: the bare `--` is the whole point of printing a command rather
        // than naming a flag. `npm run backfill:ratings --commit` takes the flag
        // as npm's own and never forwards it, so the script sees no argument and
        // prints this same dry run again - which reads as the command having
        // silently done nothing.
        console.log('  npm run backfill:ratings -- --commit');
        console.log('\nThe bare -- is required: without it npm keeps the flag for itself');
        console.log('and this dry run repeats.');
        console.log('They will be processed oldest-first, as the live hook would have.');

        return;
    }

    console.log('\nRating oldest-first...');

    let rated = 0;
    let skipped = 0;

    for (const game of games) {
        // processGame swallows its own errors by design (it must never break the
        // game flow), so confirm against the database rather than trusting it.
        await ratingService.processGame(game.GameId);

        const after = await db.query('SELECT 1 FROM "RatingHistory" WHERE "GameId" = $1 LIMIT 1', [
            game.Id
        ]);

        if (after && after.length > 0) {
            rated++;
            console.log(`  #${game.Id} rated`);
        } else {
            skipped++;
            // Not necessarily a failure: an excluded win reason or an unrated
            // tournament event is a legitimate "no".
            console.log(`  #${game.Id} not rated (excluded win reason, unrated event, or error)`);
        }
    }

    console.log(`\nDone. ${rated} rated, ${skipped} left unrated.`);

    if (skipped > 0) {
        console.log('Check the log above for any errors on the skipped games.');
    }
}

main()
    .then(async () => {
        await db.shutdown();
        process.exit(0);
    })
    .catch(async (err) => {
        console.error(err);
        try {
            await db.shutdown();
        } catch {
            /* already closed */
        }
        process.exit(1);
    });
