// ESM, and `it` comes from vitest rather than the global: the suite-wide helper
// in test/helpers/integrationhelper.js re-wraps the global `it` to bind `this`,
// and in doing so drops the per-test timeout argument. Everything here runs a
// real pg_dump and two rounds of PBKDF2, none of which fits in the default 5s.
import { it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import scratchPostgres from '../helpers/scratchPostgres.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB = 'archonarena_backup_test';
const RESTORED_DB = 'archonarena_backup_restored';

/**
 * ARCHON: the restore rehearsal.
 *
 * "Rehearse a full restore and write the timing into the runbook" is the task
 * that gets written down and never done, and when it is done once it stops
 * being true the next time the schema changes. So it runs here, for real:
 * deploy/backup.sh dumps a live PostgreSQL loaded with the actual
 * server/db/schema, and deploy/restore.sh puts it back into a second database
 * and is checked row for row.
 *
 * Nothing is mocked. A mocked pg_dump would prove the mock agrees with itself,
 * which is exactly the reassurance a backup does not need.
 *
 * The scripts talk to compose in production; here they are pointed at the
 * scratch server and a temp directory through BACKUP_PG_URI and
 * BACKUP_IMAGE_ROOT, which are the same seams a deployment with a managed
 * database would use.
 */
describe('backup and restore', function () {
    let pg;
    let workspace;
    let envFile;
    let backupDir;
    let imageRoot;
    let restoreRoot;
    let archive;

    const run = (script, args = [], extraEnv = {}) =>
        execFileSync('bash', [path.join(REPO, 'deploy', script), ...args], {
            cwd: REPO,
            encoding: 'utf8',
            stdio: 'pipe',
            env: { ...process.env, ARCHON_ENV_FILE: envFile, ...extraEnv }
        });

    /** Run a script expecting it to fail, and hand back what it said. */
    const runExpectingFailure = (script, args = []) => {
        try {
            run(script, args);
        } catch (err) {
            return `${err.stdout || ''}${err.stderr || ''}`;
        }

        throw new Error(`${script} succeeded and should not have`);
    };

    beforeAll(async function () {
        pg = await scratchPostgres.start();

        if (!pg) {
            return;
        }

        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'archon-backup-test-'));
        backupDir = path.join(workspace, 'backups');
        imageRoot = path.join(workspace, 'img');
        restoreRoot = path.join(workspace, 'restored-img');
        envFile = path.join(workspace, 'env');

        pg.createDatabase(DB);
        pg.loadSchema(DB);

        // Enough of a site to notice if any of it failed to come back: players,
        // their standing on the ladder, a finished game and an event.
        pg.psql(
            DB,
            `INSERT INTO "Users" ("Username", "Email", "Password", "Registered", "Verified")
             VALUES ('backuptester', 'backup@example.com', 'x', NOW(), true),
                    ('restoretester', 'restore@example.com', 'x', NOW(), true)`
        );
        pg.psql(
            DB,
            `INSERT INTO "Ratings" ("UserId", "Pool", "Rating", "GamesPlayed", "UpdatedAt")
             SELECT "Id", 'archon', 1337, 42, NOW() FROM "Users"`
        );
        pg.psql(
            DB,
            `INSERT INTO "Games" ("GameId", "GameFormat", "StartedAt", "FinishedAt", "WinReason", "WinnerId")
             SELECT 'game-backup-1', 'archon', NOW(), NOW(), 'keys', MIN("Id") FROM "Users"`
        );
        pg.psql(
            DB,
            `INSERT INTO "Tournaments" ("Name", "OrganizerId", "Format", "GameFormat", "CreatedAt")
             SELECT 'Backup Open', MIN("Id"), 'swiss', 'archon', NOW() FROM "Users"`
        );

        // Player uploads. Their bytes are checked after the restore, not just
        // their names - a backup that restores empty files of the right size is
        // the failure this is here to catch.
        fs.mkdirSync(path.join(imageRoot, 'avatar'), { recursive: true });
        fs.mkdirSync(path.join(imageRoot, 'bgs'), { recursive: true });
        fs.writeFileSync(path.join(imageRoot, 'avatar', 'backuptester-abc.png'), 'avatar-bytes');
        fs.writeFileSync(path.join(imageRoot, 'bgs', 'backuptester-def.png'), 'background-bytes');

        fs.writeFileSync(
            envFile,
            [
                'BACKUP_PASSPHRASE=rehearsal-passphrase-not-a-real-one',
                `BACKUP_DIR=${backupDir}`,
                `BACKUP_PG_URI=${pg.uri}`,
                `BACKUP_IMAGE_ROOT=${imageRoot}`,
                `DB_NAME=${DB}`,
                'DB_USER=postgres',
                'BACKUP_KEEP_LOCAL=3',
                ''
            ].join('\n')
        );
    }, 180000);

    afterAll(function () {
        pg?.stop();

        if (workspace) {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });

    // Every test needs a server; without one this file is not evidence of
    // anything and says so rather than passing vacuously.
    const withPostgres = (name, fn, timeout) =>
        it(
            name,
            async function (ctx) {
                if (!pg) {
                    ctx.skip(
                        'no PostgreSQL available (set ARCHON_TEST_PG_URI or install postgresql)'
                    );

                    return;
                }

                await fn();
            },
            timeout
        );

    withPostgres(
        'writes an encrypted archive and records the run',
        function () {
            const started = Date.now();
            const output = run('backup.sh');
            const seconds = ((Date.now() - started) / 1000).toFixed(1);

            const archives = fs.readdirSync(backupDir).filter((f) => f.endsWith('.tar.enc'));

            expect(archives).toHaveLength(1);
            archive = path.join(backupDir, archives[0]);

            // Encrypted, not merely renamed: openssl writes this header, and a
            // plaintext tar would start with the first member's name.
            expect(fs.readFileSync(archive).subarray(0, 8).toString()).toBe('Salted__');

            expect(output).toContain('verified');

            const record = JSON.parse(
                fs.readFileSync(path.join(backupDir, 'last-success.json'), 'utf8')
            );

            expect(record.archive).toBe(archives[0]);
            expect(record.bytes).toBe(fs.statSync(archive).size);
            expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);
            // No bucket configured in the rehearsal, and the script has to be
            // honest about that rather than calling a local copy off-host.
            expect(record.offHost).toBe('none');
            expect(output).toContain('same machine as the database');

            console.log(`      backup of ${DB}: ${seconds}s, ${record.bytes} bytes`);
        },
        180000
    );

    withPostgres(
        'verifies an untouched archive',
        function () {
            const output = run('restore.sh', ['--verify-only', archive]);

            expect(output).toContain('database.sql.gz');
            expect(output).toContain('avatars.tar.gz');
            expect(output).toContain('backgrounds.tar.gz');
            expect(output).toContain('intact and decryptable');
        },
        120000
    );

    // The manifest is the whole basis for trusting a restore, so it has to be
    // shown to reject something. Corruption in the ciphertext propagates
    // through CBC, so this lands as either a decrypt failure or a checksum
    // mismatch - both are refusals, and both are the point.
    withPostgres(
        'refuses an archive whose bytes have changed',
        function () {
            const damaged = path.join(backupDir, 'damaged.tar.enc');
            const bytes = fs.readFileSync(archive);

            // Past the 16-byte openssl header, so the salt still parses and the
            // failure is about the content rather than the format.
            bytes[Math.floor(bytes.length / 2)] ^= 0xff;
            fs.writeFileSync(damaged, bytes);

            const output = runExpectingFailure('restore.sh', ['--verify-only', damaged]);

            expect(output).toMatch(/do not match the manifest|will not unpack|Could not decrypt/);

            fs.unlinkSync(damaged);
        },
        120000
    );

    withPostgres(
        'will not restore over the live database without --yes',
        function () {
            const output = runExpectingFailure('restore.sh', [archive]);

            expect(output).toContain('LIVE database');
            expect(output).toContain('--database');
        },
        120000
    );

    withPostgres(
        'restores the database and the uploads into a second database',
        function () {
            const started = Date.now();
            const output = run('restore.sh', ['--database', RESTORED_DB, archive], {
                BACKUP_IMAGE_ROOT: restoreRoot
            });
            const seconds = ((Date.now() - started) / 1000).toFixed(1);

            expect(output).toContain(`Restored "${RESTORED_DB}"`);

            const count = (table) =>
                Number(pg.psql(RESTORED_DB, `SELECT COUNT(*) FROM "${table}"`));

            expect(count('Users')).toBe(Number(pg.psql(DB, 'SELECT COUNT(*) FROM "Users"')));
            expect(count('Ratings')).toBe(2);
            expect(count('Games')).toBe(1);
            expect(count('Tournaments')).toBe(1);

            // Values, not just row counts: a restore that produced the right
            // number of empty rows would pass a count check.
            expect(
                pg.psql(RESTORED_DB, `SELECT "Rating" FROM "Ratings" ORDER BY "UserId" LIMIT 1`)
            ).toBe('1337');
            expect(
                pg.psql(RESTORED_DB, `SELECT "Username" FROM "Users" ORDER BY "Id" LIMIT 1`)
            ).toBe('backuptester');
            expect(pg.psql(RESTORED_DB, `SELECT "Name" FROM "Tournaments" LIMIT 1`)).toBe(
                'Backup Open'
            );

            // The whole schema came back, not only the tables that had rows.
            const tables = Number(
                pg.psql(
                    RESTORED_DB,
                    `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'`
                )
            );

            expect(tables).toBe(
                Number(
                    pg.psql(
                        DB,
                        `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'`
                    )
                )
            );

            console.log(`      restore into ${RESTORED_DB}: ${seconds}s, ${tables} tables`);
        },
        180000
    );

    withPostgres(
        'brings the uploaded images back byte for byte',
        function () {
            expect(
                fs.readFileSync(path.join(restoreRoot, 'avatar', 'backuptester-abc.png'), 'utf8')
            ).toBe('avatar-bytes');
            expect(
                fs.readFileSync(path.join(restoreRoot, 'bgs', 'backuptester-def.png'), 'utf8')
            ).toBe('background-bytes');
        },
        30000
    );

    // A dump of the wrong database exits 0 and looks like a backup. This is the
    // guard that stops that being discovered during a restore.
    withPostgres(
        'refuses to call a dump of the wrong database a backup',
        function () {
            const emptyDb = 'archonarena_backup_empty';

            pg.createDatabase(emptyDb);

            const wrongEnv = path.join(workspace, 'env-wrong');

            fs.writeFileSync(
                wrongEnv,
                fs.readFileSync(envFile, 'utf8').replace(`DB_NAME=${DB}`, `DB_NAME=${emptyDb}`)
            );

            let output = '';

            try {
                execFileSync('bash', [path.join(REPO, 'deploy', 'backup.sh')], {
                    cwd: REPO,
                    encoding: 'utf8',
                    stdio: 'pipe',
                    env: { ...process.env, ARCHON_ENV_FILE: wrongEnv }
                });
                throw new Error('backup.sh accepted a database with none of the tables');
            } catch (err) {
                output = `${err.stdout || ''}${err.stderr || ''}`;
            }

            expect(output).toContain('That is not this database');
        },
        180000
    );

    withPostgres(
        'keeps only BACKUP_KEEP_LOCAL archives',
        function () {
            // Three more runs against a keep-3 setting; the oldest must go.
            for (let i = 0; i < 3; i++) {
                run('backup.sh');
            }

            const archives = fs.readdirSync(backupDir).filter((f) => f.endsWith('.tar.enc'));

            expect(archives.length).toBeLessThanOrEqual(3);
        },
        600000
    );
});
