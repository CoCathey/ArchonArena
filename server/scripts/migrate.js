/*eslint no-console: 0*/

// ARCHON: apply pending database migrations, tracked in a ledger.
//
//   npm run migrate                  apply everything pending
//   npm run migrate -- --dry-run     show what would run, change nothing
//   npm run migrate -- --status      show applied / pending and exit
//   npm run migrate -- --baseline    record every migration as applied WITHOUT
//                                    running it (see below)
//   npm run migrate -- --baseline-through "21 - Foo.sql"
//                                    record migrations UP TO AND INCLUDING that
//                                    one as applied, leaving the rest pending
//
// Why a baseline step exists
// --------------------------
// There are two ways a database gets its schema, and they are not interchangeable:
//
//   * `server/db/schema/*.sql` builds a database from empty. Docker runs the whole
//     directory on first boot, so a fresh database already contains the effect of
//     every migration ever written.
//   * `server/db/schema/migrations/*.sql` moves an existing database forward.
//     Files 01-21 are inherited from upstream keyteki and are already baked into
//     the schema directory - replaying them against a fresh database would error.
//
// So a database that has never been tracked needs its ledger seeded once, rather
// than having every historical migration replayed at it:
//
//     npm run migrate -- --baseline
//
// Run that once per existing database (including a brand-new one built from the
// schema directory). Afterwards, plain `npm run migrate` applies only genuinely
// new files.
//
// Partial baselines
// -----------------
// A full `--baseline` is only correct when the database is already at head. A
// long-running deployment usually is not: its volume was built from the schema
// directory at some point in the past, so it has everything up to that point and
// nothing since. Baselining it wholesale would mark migrations as applied that
// were never run, and the missing tables would stay missing forever - the schema
// equivalent of losing the changes.
//
//     npm run migrate -- --baseline-through "21 - <last one already in the DB>.sql"
//     npm run migrate
//
// The Archon-era migrations (22 onwards) are written to be re-runnable - every
// CREATE/ALTER is guarded - so the second command is safe even where the
// database already has some of them. Files 01-21 are the upstream ones baked
// into the schema directory, which is why they are the usual cut point.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require('../db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'schema', 'migrations');

const LEDGER_DDL =
    'CREATE TABLE IF NOT EXISTS public."SchemaMigrations" (' +
    '"Filename" text NOT NULL, "Checksum" text NOT NULL, ' +
    '"AppliedAt" timestamp without time zone NOT NULL, "AppliedBy" text, ' +
    'CONSTRAINT "PK_SchemaMigrations" PRIMARY KEY ("Filename"))';

const checksum = (contents) => crypto.createHash('sha256').update(contents).digest('hex');

/** Migration files in execution order — the same alphabetical order psql would use. */
function readMigrations() {
    return fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((filename) => {
            const contents = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');

            return { filename, contents, checksum: checksum(contents) };
        });
}

async function readLedger() {
    await db.query(LEDGER_DDL);

    const rows = await db.query('SELECT "Filename", "Checksum" FROM "SchemaMigrations"');
    const applied = new Map();

    for (const row of rows || []) {
        applied.set(row.Filename, row.Checksum);
    }

    return applied;
}

async function record(client, migration) {
    const query = client
        ? (text, params) => client.query(text, params)
        : (text, params) => db.query(text, params);

    await query(
        'INSERT INTO "SchemaMigrations" ("Filename", "Checksum", "AppliedAt", "AppliedBy") ' +
            "VALUES ($1, $2, now() AT TIME ZONE 'utc', $3) " +
            'ON CONFLICT ("Filename") DO NOTHING',
        [migration.filename, migration.checksum, `${os.userInfo().username}@${os.hostname()}`]
    );
}

/**
 * Refuse to continue when an already-applied file has been edited: the database
 * has one version of that change and the repository now describes another, and
 * no amount of re-running will reconcile them. Better to stop loudly.
 */
function findEditedMigrations(migrations, applied) {
    return migrations.filter(
        (migration) =>
            applied.has(migration.filename) &&
            applied.get(migration.filename) !== migration.checksum
    );
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const status = args.includes('--status');
    const baseline = args.includes('--baseline');
    const throughIndex = args.indexOf('--baseline-through');
    const throughArg = throughIndex >= 0 ? args[throughIndex + 1] : null;

    const migrations = readMigrations();

    // Resolve the cut point before touching anything. Accepts the full filename
    // or just its leading ordinal ("21"), because nobody wants to retype
    // "21 - TournamentSeeding.sql" exactly.
    let throughPos = -1;
    if (throughArg !== null) {
        throughPos = migrations.findIndex(
            (migration) =>
                migration.filename === throughArg ||
                migration.filename.startsWith(`${throughArg} -`) ||
                migration.filename.startsWith(`${throughArg} `)
        );

        if (throughPos < 0) {
            console.error(`No migration matches "${throughArg}". Available:`);
            for (const migration of migrations) {
                console.error(`  ${migration.filename}`);
            }
            process.exit(1);
        }
    }
    const applied = await readLedger();

    const edited = findEditedMigrations(migrations, applied);
    if (edited.length > 0) {
        console.error('Refusing to run: these migrations changed after they were applied:');
        for (const migration of edited) {
            console.error(`  ${migration.filename}`);
        }
        console.error(
            '\nA migration is a historical record. Add a new migration instead of editing one.'
        );
        process.exit(1);
    }

    const pending = migrations.filter((migration) => !applied.has(migration.filename));

    if (status || dryRun) {
        console.log(`${applied.size} applied, ${pending.length} pending`);
        for (const migration of pending) {
            console.log(`  pending: ${migration.filename}`);
        }
        if (pending.length > 0 && applied.size === 0) {
            console.log(
                '\nThis database has no ledger yet. If its schema is already up to date\n' +
                    '(a fresh database built from server/db/schema, or a deployment that has\n' +
                    'been kept current by hand), seed the ledger instead of replaying history:\n' +
                    '    npm run migrate -- --baseline'
            );
        }
        return;
    }

    if (throughPos >= 0) {
        const seed = migrations.slice(0, throughPos + 1);

        for (const migration of seed) {
            await record(null, migration);
        }

        const remaining = migrations.length - seed.length;

        console.log(
            `Baselined ${seed.length} migration(s) as already applied, through ` +
                `${seed[seed.length - 1].filename}.`
        );
        console.log(
            remaining > 0
                ? `${remaining} migration(s) are still pending - run \`npm run migrate\` to apply them.`
                : 'Nothing left pending.'
        );

        return;
    }

    if (baseline) {
        for (const migration of migrations) {
            await record(null, migration);
        }
        console.log(`Baselined ${migrations.length} migration(s) as already applied.`);
        console.log('Future runs of `npm run migrate` will apply only new files.');
        return;
    }

    if (pending.length === 0) {
        console.log(`Up to date (${applied.size} migration(s) applied).`);
        return;
    }

    // An untracked database with pending files is ambiguous: it might genuinely
    // need them, or it might already be at head and just lack a ledger. Applying
    // upstream migrations 01-21 to a fresh database errors out, so make the
    // operator choose rather than guessing for them.
    if (applied.size === 0) {
        console.error(
            `This database has no migration ledger, and ${pending.length} migration(s) look pending.\n\n` +
                'If its schema is already up to date - a fresh database built from\n' +
                'server/db/schema, or a deployment kept current by hand - seed the ledger:\n' +
                '    npm run migrate -- --baseline\n\n' +
                'Only run migrations unbaselined against a database you know predates them.\n' +
                'Inspect first with:  npm run migrate -- --status'
        );
        process.exit(1);
    }

    for (const migration of pending) {
        console.log(`Applying ${migration.filename}...`);

        // startTransaction connects and issues BEGIN, so each file lands whole
        // or not at all - including its ledger row, which means the ledger can
        // never claim a migration that half-applied.
        const client = await db.startTransaction();

        try {
            // Deliberately client.query(text) with no parameter array: node-pg
            // switches to the extended protocol the moment values are passed
            // (even an empty array), and the extended protocol rejects the
            // multi-statement files every migration is made of.
            await client.query(migration.contents);
            await record(client, migration);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
            console.error(`Failed on ${migration.filename}: ${err.message}`);
            console.error('Nothing from this file was applied; earlier files remain applied.');
            process.exit(1);
        }

        client.release();
    }

    console.log(`Applied ${pending.length} migration(s).`);
}

// Only run when invoked as a script. Requiring this file (the tests do, for the
// pure helpers below) must not open a database connection or exit the process.
if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('Migration failed:', err.message);
            process.exit(1);
        });
}

module.exports = { readMigrations, findEditedMigrations, checksum };
