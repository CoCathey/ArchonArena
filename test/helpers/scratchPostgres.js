/**
 * A throwaway PostgreSQL 16 for tests that have to run against the real thing.
 *
 * Most of the suite has no business touching a database. A few things cannot be
 * proved without one - anything whose behaviour lives in SQL, in the schema, or
 * in a tool that shells out to `pg_dump` - and for those, a mock proves only
 * that the mock agrees with itself.
 *
 * Two ways to get a server, in preference order:
 *
 *   1. ARCHON_TEST_PG_URI, a libpq base URI with no database on the end. This
 *      is what CI sets, pointing at its postgres service.
 *   2. A scratch cluster created with initdb in a temp directory. Postgres
 *      refuses to run as root, so when the tests are root - which they are
 *      inside most containers - the server-side commands drop to the `postgres`
 *      system user. Client tools are happy as root either way.
 *
 * When neither is possible `start` returns null and the caller should skip
 * rather than fail: a machine without Postgres installed is a legitimate place
 * to run the rest of the suite.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const SCHEMA_DIR = path.join(__dirname, '..', '..', 'server', 'db', 'schema');

/** Where initdb/pg_ctl/psql live, or null. */
const binDir = () => {
    const roots = [
        '/usr/lib/postgresql',
        '/usr/local/pgsql/bin',
        '/opt/homebrew/opt/postgresql@16/bin'
    ];

    for (const root of roots) {
        if (!fs.existsSync(root)) {
            continue;
        }

        if (fs.existsSync(path.join(root, 'initdb'))) {
            return root;
        }

        const versioned = fs
            .readdirSync(root)
            .sort()
            .reverse()
            .map((v) => path.join(root, v, 'bin'))
            .find((dir) => fs.existsSync(path.join(dir, 'initdb')));

        if (versioned) {
            return versioned;
        }
    }

    return null;
};

/** A port nobody else has, asked of the OS rather than guessed. */
const freePort = () =>
    new Promise((resolve, reject) => {
        const server = net.createServer();

        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();

            server.close(() => resolve(port));
        });
    });

const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * Start a server, or return null if this machine cannot host one.
 *
 * @returns {Promise<{uri: string, psql: Function, loadSchema: Function, stop: Function}|null>}
 */
async function start() {
    if (process.env.ARCHON_TEST_PG_URI) {
        const external = handle(process.env.ARCHON_TEST_PG_URI.replace(/\/$/, ''), null, null);

        // Setting the variable is a statement that a server is supposed to be
        // there. If it is not, throw rather than return null: skipping would
        // turn a broken CI service into a suite that quietly proves nothing.
        try {
            external.psql('postgres', 'SELECT 1');
        } catch (err) {
            throw new Error(`ARCHON_TEST_PG_URI is set but unusable: ${err.stderr || err.message}`);
        }

        return external;
    }

    const bin = binDir();

    if (!bin) {
        return null;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archon-pg-'));
    // Readable by the postgres user when we are about to become it.
    fs.chmodSync(root, 0o777);

    const dataDir = path.join(root, 'data');
    const port = await freePort();
    // initdb and pg_ctl are the server side and refuse to run as root.
    const asServer = (cmd, args) =>
        isRoot()
            ? execFileSync('su', ['postgres', '-c', [cmd, ...args].map(shellQuote).join(' ')], {
                  encoding: 'utf8',
                  stdio: 'pipe'
              })
            : execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe' });

    try {
        asServer(path.join(bin, 'initdb'), [
            '-D',
            dataDir,
            '-U',
            'postgres',
            '--auth=trust',
            '-E',
            'UTF8'
        ]);
        asServer(path.join(bin, 'pg_ctl'), [
            '-D',
            dataDir,
            '-o',
            `-p ${port} -h 127.0.0.1 -k ${root}`,
            '-l',
            path.join(root, 'postgres.log'),
            '-w',
            'start'
        ]);
    } catch (err) {
        fs.rmSync(root, { recursive: true, force: true });
        throw new Error(`Could not start a scratch PostgreSQL: ${err.stderr || err.message}`);
    }

    const stop = () => {
        try {
            asServer(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
        } catch {
            // Already gone; the directory removal below is what matters.
        }

        fs.rmSync(root, { recursive: true, force: true });
    };

    return handle(`postgres://postgres@127.0.0.1:${port}`, bin, stop);
}

function handle(uri, bin, stop) {
    const psqlBin = bin ? path.join(bin, 'psql') : 'psql';

    /** Run one statement and hand back stdout, unaligned and untitled. */
    const psql = (database, sql) =>
        execFileSync(psqlBin, ['-v', 'ON_ERROR_STOP=1', '-tA', `${uri}/${database}`, '-c', sql], {
            encoding: 'utf8',
            stdio: 'pipe'
        }).trim();

    /**
     * Load `server/db/schema` the way the Docker initdb mount does: every file,
     * alphabetically. Anything else would be testing a schema the site does not
     * actually run.
     */
    const loadSchema = (database) => {
        const files = fs
            .readdirSync(SCHEMA_DIR)
            .filter((f) => f.endsWith('.sql'))
            .sort();

        for (const file of files) {
            execFileSync(
                psqlBin,
                [
                    '-v',
                    'ON_ERROR_STOP=1',
                    '-q',
                    `${uri}/${database}`,
                    '-f',
                    path.join(SCHEMA_DIR, file)
                ],
                { encoding: 'utf8', stdio: 'pipe' }
            );
        }

        return files.length;
    };

    const createDatabase = (database) => {
        // The schema files carry `OWNER to keyteki` from upstream, so the role
        // has to exist before they load.
        try {
            psql('postgres', "CREATE ROLE keyteki LOGIN PASSWORD 'keyteki'");
        } catch {
            // Already there, which is the normal case against a reused server.
        }

        psql('postgres', `DROP DATABASE IF EXISTS "${database}"`);
        psql('postgres', `CREATE DATABASE "${database}"`);
    };

    return { uri, psql, loadSchema, createDatabase, stop: stop || (() => {}) };
}

module.exports = { start, available: () => Boolean(process.env.ARCHON_TEST_PG_URI || binDir()) };
