#!/usr/bin/env node
/*eslint no-console: 0*/

/*
 * ARCHON (F3): how the misplay review actually behaves on real games.
 *
 * The review's thresholds were set by reasoning, not by data - nobody had
 * seen its flag RATE on real play. That number decides the feature's fate:
 * too hot and players drown in second-guessing and close the panel for good,
 * too cold and it never says anything worth opening. This script turns the
 * question into data: it runs the shipped review over stored recordings and
 * reports moments per game by type, how often each justification cleared a
 * check, and how much of the history is readable at all (recordings from
 * before hands were captured cannot produce hand-read moments).
 *
 * Read-only, and runs the SHIPPED code paths (`findMisplays` with the real
 * card knowledge), so what it measures is what players see. Numbers to look
 * at:
 *
 *   - moments/game around 1-2 with most games at 0-3 reads as "worth
 *     opening"; averages of 5+ mean thresholds need raising.
 *   - a justification that never fires is dead weight or broken; one that
 *     fires far more than its check flags means the check barely survives
 *     its own suppressions.
 *
 * Usage:
 *   npm run calibrate:misplays                 latest 500 recordings
 *   npm run calibrate:misplays -- --limit 2000
 *   npm run calibrate:misplays -- --json       machine-readable output
 */

const { findMisplays } = require('../services/membership/replayMisplays');

/**
 * The report over a set of recordings. Pure and exported, because this
 * arithmetic is the part worth testing and the CLI below is just a query
 * around it.
 *
 * @param {Array<{Data: object}>} rows
 * @param {{review?: (replay: object) => object}} [options] review function,
 *   injectable for tests; defaults to the shipped `findMisplays`.
 */
function summariseReviews(rows, { review = findMisplays } = {}) {
    const summary = {
        scanned: 0,
        unreadable: 0,
        reviewable: 0,
        withHands: 0,
        thinned: 0,
        byVersion: {},
        momentsTotal: 0,
        gamesWithNone: 0,
        momentCounts: {},
        byType: {},
        suppressed: {},
        suppressedTotal: 0
    };

    for (const row of rows || []) {
        const replay = row && row.Data;

        summary.scanned++;

        const version = (replay && replay.version) || 1;

        summary.byVersion[version] = (summary.byVersion[version] || 0) + 1;

        const result = review(replay);

        if (!result || !result.available) {
            summary.unreadable++;

            continue;
        }

        summary.reviewable++;
        summary.withHands += result.handsRecorded ? 1 : 0;
        summary.thinned += result.thinned ? 1 : 0;

        const moments = result.moments || [];

        summary.momentsTotal += moments.length;
        summary.gamesWithNone += moments.length === 0 ? 1 : 0;
        summary.momentCounts[moments.length] = (summary.momentCounts[moments.length] || 0) + 1;

        for (const moment of moments) {
            const entry = (summary.byType[moment.type] = summary.byType[moment.type] || {
                moments: 0,
                games: 0
            });

            entry.moments++;
        }

        for (const type of new Set(moments.map((moment) => moment.type))) {
            summary.byType[type].games++;
        }

        for (const [reason, count] of Object.entries(result.suppressed || {})) {
            summary.suppressed[reason] = (summary.suppressed[reason] || 0) + count;
            summary.suppressedTotal += count;
        }
    }

    summary.momentsPerGame = summary.reviewable
        ? Math.round((summary.momentsTotal / summary.reviewable) * 100) / 100
        : null;

    return summary;
}

function printReport(summary) {
    const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '-');

    console.log(`Recordings scanned:   ${summary.scanned}`);
    console.log(
        `  reviewable:         ${summary.reviewable} (${pct(summary.reviewable, summary.scanned)})`
    );
    console.log(
        `  with hands (v4+):   ${summary.withHands} (${pct(summary.withHands, summary.scanned)})`
    );
    console.log(`  thinned:            ${summary.thinned}`);
    console.log(
        `  by version:         ${Object.entries(summary.byVersion)
            .map(([version, count]) => `v${version}×${count}`)
            .join('  ')}`
    );
    console.log('');
    console.log(`Moments:              ${summary.momentsTotal} across ${summary.reviewable} games`);
    console.log(`  per game:           ${summary.momentsPerGame ?? '-'}`);
    console.log(
        `  games with none:    ${summary.gamesWithNone} (${pct(
            summary.gamesWithNone,
            summary.reviewable
        )})`
    );
    console.log(
        `  distribution:       ${Object.entries(summary.momentCounts)
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([count, games]) => `${count}→${games}`)
            .join('  ')}`
    );
    console.log('');
    console.log('By type (moments / games with at least one):');

    for (const [type, entry] of Object.entries(summary.byType).sort(
        (a, b) => b[1].moments - a[1].moments
    )) {
        console.log(`  ${type.padEnd(18)} ${String(entry.moments).padStart(5)} / ${entry.games}`);
    }

    console.log('');
    console.log(`Justifications fired: ${summary.suppressedTotal}`);

    for (const [reason, count] of Object.entries(summary.suppressed).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${reason.padEnd(30)} ${String(count).padStart(5)}`);
    }
}

async function main() {
    const db = require('../db');
    const args = process.argv.slice(2);
    const json = args.includes('--json');
    const limitIndex = args.indexOf('--limit');
    const limit = Math.min(
        Math.max(limitIndex >= 0 ? parseInt(args[limitIndex + 1], 10) || 500 : 500, 1),
        10000
    );

    const rows = await db.query(
        'SELECT gr."Data" FROM "GameReplays" gr ' +
            'JOIN "Games" g ON g."Id" = gr."GameDbId" ' +
            'WHERE g."FinishedAt" IS NOT NULL ' +
            'ORDER BY g."FinishedAt" DESC LIMIT $1',
        [limit]
    );

    const summary = summariseReviews(rows || []);

    if (json) {
        console.log(JSON.stringify(summary, null, 2));
    } else {
        console.log(`Misplay review calibration over the latest ${limit} recordings\n`);
        printReport(summary);
    }

    process.exit(0);
}

module.exports = { summariseReviews };

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
