const BugReportService = require('../../../server/services/BugReportService');

const createFakeDb = () => {
    const state = { reports: [], nextId: 1 };

    return {
        state,
        query: vi.fn(async (sql, params = []) => {
            if (sql.includes('INSERT INTO "BugReports"')) {
                state.reports.push({
                    Id: state.nextId++,
                    UserId: params[0],
                    Page: params[1],
                    Body: params[2],
                    UserAgent: params[3],
                    Status: 'open',
                    ResolvedBy: null,
                    ResolvedAt: null,
                    CreatedAt: new Date()
                });
                return [];
            }

            if (sql.includes('UPDATE "BugReports"')) {
                const report = state.reports.find((entry) => entry.Id === params[0]);
                if (report) {
                    report.Status = params[1];
                    if (params[1] === 'resolved') {
                        report.ResolvedBy = params[2];
                        report.ResolvedAt = new Date();
                    } else {
                        report.ResolvedBy = null;
                        report.ResolvedAt = null;
                    }
                }
                return [];
            }

            if (sql.includes('FROM "BugReports" r')) {
                let rows = [...state.reports];
                if (sql.includes('r."Status" = $1')) {
                    rows = rows.filter((entry) => entry.Status === params[0]);
                }
                return rows
                    .sort((a, b) => b.Id - a.Id)
                    .map((entry) => ({
                        ...entry,
                        Username: entry.UserId ? `user${entry.UserId}` : null,
                        ResolvedByUsername: entry.ResolvedBy ? `user${entry.ResolvedBy}` : null
                    }));
            }

            return [];
        })
    };
};

describe('BugReportService', function () {
    let db;
    let service;

    beforeEach(function () {
        db = createFakeDb();
        service = new BugReportService(db);
    });

    it('rejects reports that are too short or too long', async function () {
        expect((await service.create(1, { body: 'broken' })).success).toBe(false);
        expect((await service.create(1, { body: 'x'.repeat(5001) })).success).toBe(false);
        expect(db.state.reports.length).toBe(0);
    });

    it('files reports with page context and lists them newest first', async function () {
        await service.create(1, {
            body: 'The bracket page crashes on refresh',
            page: '/tournaments/5'
        });
        await service.create(2, {
            body: 'Deck import hangs at 50 percent',
            page: '/decks',
            userAgent: 'TestBrowser/1.0'
        });

        const reports = await service.list();

        expect(reports.length).toBe(2);
        expect(reports[0].username).toBe('user2');
        expect(reports[0].userAgent).toBe('TestBrowser/1.0');
        expect(reports[1].page).toBe('/tournaments/5');
        expect(reports[1].status).toBe('open');
    });

    it('resolves and reopens with an audit trail, filtering by status', async function () {
        await service.create(1, { body: 'Something is definitely broken here' });
        const [report] = await service.list();

        expect((await service.setStatus(report.id, 'nonsense', 9)).success).toBe(false);

        await service.setStatus(report.id, 'resolved', 9);
        let resolved = await service.list('resolved');
        expect(resolved.length).toBe(1);
        expect(resolved[0].resolvedBy).toBe('user9');
        expect((await service.list('open')).length).toBe(0);

        await service.setStatus(report.id, 'open', 9);
        const reopened = await service.list('open');
        expect(reopened.length).toBe(1);
        expect(reopened[0].resolvedBy).toBeNull();
    });
});
