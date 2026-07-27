const path = require('path');
const fs = require('fs');

const {
    readMigrations,
    findEditedMigrations,
    checksum
} = require('../../../server/scripts/migrate');

const MIGRATIONS_DIR = path.join(
    __dirname,
    '..',
    '..',
    '..',
    'server',
    'db',
    'schema',
    'migrations'
);

describe('migration runner', function () {
    describe('readMigrations', function () {
        it('reads every migration file with a checksum', function () {
            const migrations = readMigrations();
            const onDisk = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));

            expect(migrations).toHaveLength(onDisk.length);
            expect(migrations.every((m) => m.checksum && m.checksum.length === 64)).toBe(true);
            expect(migrations.every((m) => m.contents.length > 0)).toBe(true);
        });

        // Execution order is alphabetical because that is the order the Docker
        // initdb mount uses; the runner must not invent a different one.
        it('returns them in alphabetical (execution) order', function () {
            const names = readMigrations().map((m) => m.filename);

            expect(names).toEqual([...names].sort());
        });

        // Duplicated ordinals were a real defect in server/db/schema; the same
        // mistake in the migrations directory would make "what ran" ambiguous.
        it('has no duplicate ordinals', function () {
            const ordinals = readMigrations().map((m) => m.filename.split(' - ')[0]);

            expect(new Set(ordinals).size).toBe(ordinals.length);
        });
    });

    describe('findEditedMigrations', function () {
        const migrations = [
            { filename: 'a.sql', checksum: 'aaa' },
            { filename: 'b.sql', checksum: 'bbb' }
        ];

        it('finds an applied migration whose contents changed', function () {
            const applied = new Map([
                ['a.sql', 'aaa'],
                ['b.sql', 'DIFFERENT']
            ]);

            expect(findEditedMigrations(migrations, applied).map((m) => m.filename)).toEqual([
                'b.sql'
            ]);
        });

        it('ignores migrations that have not been applied yet', function () {
            expect(findEditedMigrations(migrations, new Map())).toEqual([]);
        });

        it('is quiet when everything matches', function () {
            const applied = new Map([
                ['a.sql', 'aaa'],
                ['b.sql', 'bbb']
            ]);

            expect(findEditedMigrations(migrations, applied)).toEqual([]);
        });
    });

    describe('checksum', function () {
        it('is stable and content-sensitive', function () {
            expect(checksum('SELECT 1;')).toBe(checksum('SELECT 1;'));
            expect(checksum('SELECT 1;')).not.toBe(checksum('SELECT 2;'));
        });
    });
});
