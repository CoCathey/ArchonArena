const AdminResetService = require('../../../server/services/AdminResetService');

describe('AdminResetService', function () {
    let db;
    let client;
    let service;
    let statisticsService;

    beforeEach(function () {
        client = { release: vi.fn() };
        db = {
            query: vi.fn(async (sql) => {
                if (sql.includes('COUNT(*)')) {
                    return [{ count: '7' }];
                }
                return [];
            }),
            queryTran: vi.fn(async () => []),
            startTransaction: vi.fn(async () => client)
        };
        statisticsService = { clearCache: vi.fn() };
        service = new AdminResetService(db, { statisticsService });
    });

    const deletedTables = () =>
        db.queryTran.mock.calls
            .map((call) => call[1])
            .filter((sql) => sql.startsWith('DELETE FROM'))
            .map((sql) => sql.match(/"([^"]+)"/)[1]);

    describe('dry run', function () {
        it('is the default, and deletes nothing', async function () {
            const result = await service.reset({ categories: ['ratings'] });

            expect(result.dryRun).toBe(true);
            expect(result.counts).toEqual({ RatingHistory: 7, Ratings: 7 });
            expect(result.total).toBe(14);
            expect(db.startTransaction).not.toHaveBeenCalled();
            expect(deletedTables()).toEqual([]);
        });

        it('reports the same tables the real run would clear', async function () {
            const dry = await service.reset({ categories: ['games'] });
            await service.reset({ categories: ['games'], confirm: true });

            expect(dry.tables).toEqual(deletedTables());
        });
    });

    describe('confirmed reset', function () {
        it('deletes children before parents so foreign keys never block', async function () {
            await service.reset({ categories: ['games'], confirm: true });

            const tables = deletedTables();

            expect(tables.indexOf('GamePlayers')).toBeLessThan(tables.indexOf('Games'));
            expect(tables.indexOf('GameReplays')).toBeLessThan(tables.indexOf('Games'));
            expect(tables.indexOf('RatingHistory')).toBeLessThan(tables.indexOf('Games'));
        });

        it('runs in one transaction and commits', async function () {
            await service.reset({ categories: ['ratings'], confirm: true });

            expect(db.startTransaction).toHaveBeenCalledTimes(1);
            expect(db.queryTran.mock.calls.some((call) => call[1] === 'COMMIT')).toBe(true);
            expect(client.release).toHaveBeenCalled();
        });

        it('rolls back and rethrows when a delete fails', async function () {
            db.queryTran = vi.fn(async (_client, sql) => {
                if (sql.startsWith('DELETE FROM')) {
                    throw new Error('constraint violation');
                }
                return [];
            });

            await expect(service.reset({ categories: ['ratings'], confirm: true })).rejects.toThrow(
                'constraint violation'
            );
            expect(db.queryTran.mock.calls.some((call) => call[1] === 'ROLLBACK')).toBe(true);
            expect(client.release).toHaveBeenCalled();
        });

        // Otherwise the site keeps serving aggregates computed from rows that
        // no longer exist.
        it('clears the statistics cache afterwards', async function () {
            await service.reset({ categories: ['games'], confirm: true });

            expect(statisticsService.clearCache).toHaveBeenCalled();
        });

        it('does not clear the cache on a dry run', async function () {
            await service.reset({ categories: ['games'] });

            expect(statisticsService.clearCache).not.toHaveBeenCalled();
        });
    });

    describe('guards', function () {
        it('refuses an empty selection', async function () {
            const result = await service.reset({ categories: [], confirm: true });

            expect(result.success).toBe(false);
            expect(deletedTables()).toEqual([]);
        });

        it('refuses unknown categories rather than silently ignoring them', async function () {
            const result = await service.reset({
                categories: ['ratings', 'everything'],
                confirm: true
            });

            expect(result.success).toBe(false);
            expect(result.message).toContain('everything');
            expect(deletedTables()).toEqual([]);
        });

        // The community must survive a stats reset: accounts, decks, clubs,
        // stores and tournaments are not play data.
        it('never touches accounts, decks, clubs, stores or tournaments', async function () {
            const everyCategory = AdminResetService.categories().map((c) => c.key);

            await service.reset({ categories: everyCategory, confirm: true });

            const touched = deletedTables();
            for (const protectedTable of [
                'Users',
                'Decks',
                'Clubs',
                'ClubMembers',
                'Stores',
                'Tournaments',
                'TournamentPlayers',
                'Friendships'
            ]) {
                expect(touched).not.toContain(protectedTable);
            }
        });
    });
});
