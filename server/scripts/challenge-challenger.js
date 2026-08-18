/*eslint no-console: 0*/

// ARCHON (N38): the challenger's door - hand-made brains enter the arena,
// never the throne.
//
//   npm run challenger:export > champion.json
//       the current champion's full model, editable JSON
//
//   npm run challenger:enter < challenger.json
//   npm run challenger:enter -- --retire-current --note "advisor session" < challenger.json
//       validate an edited model and seat it as the CANDIDATE
//
// (In production, through the lobby container:
//   docker compose -f docker-compose.prod.yml --env-file .env.production \
//       exec -T lobby npm run challenger:export > champion.json
//   docker compose -f docker-compose.prod.yml --env-file .env.production \
//       exec -T lobby npm run challenger:enter < challenger.json)
//
// This closes the advisor loop: export the champion, let a Claude session
// (or a human with opinions) edit the weights - correct a misvalued card,
// try a bolder amber race - and enter the result as a challenger. What it
// deliberately CANNOT do is crown anybody. An entered model becomes an
// ordinary candidate row, and the sweep's arena does to it exactly what it
// does to a trained one: paired-seed games against the reigning champion
// until the sequential test proves it better (promoted) or fails to
// (retired). The worst a bad upload can cost is arena games; the best a
// good one can do still has to be proven first.
//
// Guardrails:
//  - One candidate at a time, enforced by a guarded insert - if a title
//    fight is already on, entry is refused (or `--retire-current` concedes
//    the sitting candidate first, explicitly).
//  - The model is sanitized: only the known fields survive, every weight
//    must be a finite number (magnitudes are clamped, with a warning),
//    counts must be non-negative integers, and `cardPriors` is stripped -
//    the file is the source of truth and re-attaches at load.
//  - Provenance is kept: the stored model carries origin: 'uploaded' and
//    your note, so the strength curve's history stays honest.

const { emptyModel } = require('../services/championschallenge/labPolicy');

/** Sparse maps a model may carry, and whether their values are counts. */
const MODEL_MAPS = [
    ['weights', false],
    ['cardWeights', false],
    ['promptWeights', false],
    ['cardCounts', true],
    ['promptCounts', true]
];

/** Keep the ranking honest: past this, a weight is an input error. */
const WEIGHT_CLAMP = 50;

/** A row is a brain, not an archive: total sparse entries allowed. */
const MAX_ENTRIES = 100000;

/**
 * The known fields of `raw`, checked and cleaned, or a list of reasons it
 * cannot enter. Never mutates its input.
 */
function sanitizeModel(raw) {
    const problems = [];
    const warnings = [];

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { model: null, problems: ['not a JSON object'], warnings };
    }

    const model = {
        version: 0, // assigned at entry
        trainedGames:
            Number.isFinite(Number(raw.trainedGames)) && Number(raw.trainedGames) >= 0
                ? Math.round(Number(raw.trainedGames))
                : 0
    };
    let entries = 0;

    for (const [field, isCount] of MODEL_MAPS) {
        const map = raw[field];

        model[field] = {};

        if (map === undefined || map === null) {
            continue;
        }

        if (typeof map !== 'object' || Array.isArray(map)) {
            problems.push(`${field} is not an object`);
            continue;
        }

        for (const [key, value] of Object.entries(map)) {
            const number = Number(value);

            if (typeof key !== 'string' || key.length > 200) {
                problems.push(`${field} has an unusable key`);
                continue;
            }

            if (!Number.isFinite(number)) {
                problems.push(`${field}.${key} is not a finite number`);
                continue;
            }

            if (isCount) {
                if (number < 0) {
                    problems.push(`${field}.${key} is a negative count`);
                    continue;
                }

                model[field][key] = Math.round(number);
            } else if (Math.abs(number) > WEIGHT_CLAMP) {
                warnings.push(`${field}.${key} clamped from ${number} to ±${WEIGHT_CLAMP}`);
                model[field][key] = Math.sign(number) * WEIGHT_CLAMP;
            } else {
                model[field][key] = number;
            }

            entries++;
        }
    }

    if (entries > MAX_ENTRIES) {
        problems.push(`${entries} sparse entries; the most a model may carry is ${MAX_ENTRIES}`);
    }

    if (raw.cardPriors) {
        warnings.push('cardPriors stripped - the priors file is the source of truth');
    }

    return { model: problems.length ? null : model, problems, warnings };
}

/** The reigning champion's raw stored model, or a blank slate to edit. */
async function exportChampion(db) {
    const rows = await db.query(
        'SELECT "Version", "TrainedGames", "Model" FROM "BotPolicies" ' +
            'WHERE "Status" = \'champion\' ORDER BY "Version" DESC LIMIT 1'
    );

    if (rows && rows[0]) {
        return rows[0].Model;
    }

    return { ...emptyModel(), note: 'no champion yet - this is a blank slate' };
}

/**
 * Seat a sanitized model as the candidate. The insert is guarded in one
 * statement: it succeeds only while NO candidate exists, so a race with the
 * sweep's own training can refuse but can never seat two.
 *
 * @returns {Promise<number|null>} the new version, or null when refused
 */
async function enterChallenger(db, model, { note = null, retireCurrent = false } = {}) {
    if (retireCurrent) {
        await db.query(
            'UPDATE "BotPolicies" SET "Status" = \'retired\' WHERE "Status" = \'candidate\''
        );
    }

    const versions = await db.query(
        'SELECT COALESCE(MAX("Version"), 0)::int AS "Version" FROM "BotPolicies"'
    );
    const version = (((versions && versions[0]) || {}).Version || 0) + 1;
    const stored = {
        ...model,
        version,
        origin: 'uploaded',
        uploadedAt: new Date().toISOString(),
        ...(note ? { note } : {})
    };
    const inserted = await db.query(
        'INSERT INTO "BotPolicies" ("Version", "Status", "Model", "TrainedGames", "CreatedAt") ' +
            "SELECT $1, 'candidate', $2, $3, now() AT TIME ZONE 'utc' " +
            'WHERE NOT EXISTS (SELECT 1 FROM "BotPolicies" WHERE "Status" = \'candidate\') ' +
            'RETURNING "Id"',
        [version, JSON.stringify(stored), stored.trainedGames || 0]
    );

    return inserted && inserted[0] ? version : null;
}

async function main() {
    const db = require('../db');
    const argv = process.argv.slice(2);
    const command = argv[0];

    if (command === 'export') {
        console.log(JSON.stringify(await exportChampion(db), null, 2));

        return;
    }

    if (command !== 'enter') {
        console.error(
            'Usage: challenger:export | challenger:enter [--retire-current] [--note "..."]'
        );
        process.exit(2);
    }

    let note = null;
    let retireCurrent = false;
    let file = null;

    for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '--retire-current') {
            retireCurrent = true;
        } else if (argv[i] === '--note') {
            note = argv[++i];
        } else {
            file = argv[i];
        }
    }

    // A file argument, or stdin - which is what reaches through
    // `docker compose exec -T lobby ... < challenger.json`.
    const fs = require('fs');
    const raw = JSON.parse(fs.readFileSync(file || 0, 'utf8'));
    const { model, problems, warnings } = sanitizeModel(raw);

    for (const warning of warnings) {
        console.error(`warning: ${warning}`);
    }

    if (!model) {
        console.error('This model cannot enter the arena:');

        for (const problem of problems.slice(0, 20)) {
            console.error(`  - ${problem}`);
        }

        process.exit(1);
    }

    const version = await enterChallenger(db, model, { note, retireCurrent });

    if (version === null) {
        console.error(
            'A candidate already holds the ring - its title fight must finish first.\n' +
                'Re-run with --retire-current to concede it and enter this model instead.'
        );
        process.exit(1);
    }

    console.log(
        `v${version} enters the arena as the candidate.\n\n` +
            'From here the sweep takes over: paired-seed games against the reigning\n' +
            'champion, a few per sweep, until the sequential test either proves this\n' +
            'model better (it takes the title) or proves it is not / cannot decide\n' +
            '(it retires, record kept). Watch the strength curve on the Challenge\n' +
            'page, or the lobby logs for "candidate v' +
            version +
            '".'
    );
}

if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = { sanitizeModel, exportChampion, enterChallenger };
