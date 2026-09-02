const IosBetaRequestService = require('../../../server/services/IosBetaRequestService');

const createFakeDb = () => {
    const state = { requests: [], nextId: 1 };

    return {
        state,
        query: vi.fn(async (sql, params = []) => {
            if (sql.includes('SELECT "Id" FROM "IosBetaRequests" WHERE "UserId"')) {
                return state.requests.filter(
                    (entry) => entry.UserId === params[0] && entry.Status === 'pending'
                );
            }

            if (sql.includes('INSERT INTO "IosBetaRequests"')) {
                state.requests.push({
                    Id: state.nextId++,
                    UserId: params[0],
                    AppleId: params[1],
                    Status: 'pending',
                    ClearedBy: null,
                    ClearedAt: null,
                    CreatedAt: new Date()
                });
                return [];
            }

            if (sql.includes('UPDATE "IosBetaRequests"')) {
                const request = state.requests.find((entry) => entry.Id === params[0]);
                if (request) {
                    request.Status = params[1];
                    if (params[1] === 'cleared') {
                        request.ClearedBy = params[2];
                        request.ClearedAt = new Date();
                    } else {
                        request.ClearedBy = null;
                        request.ClearedAt = null;
                    }
                }
                return [];
            }

            if (sql.includes('FROM "IosBetaRequests" r')) {
                let rows = [...state.requests];
                if (sql.includes('r."Status" = $1')) {
                    rows = rows.filter((entry) => entry.Status === params[0]);
                }
                return rows
                    .sort((a, b) => a.Id - b.Id)
                    .map((entry) => ({
                        ...entry,
                        Username: entry.UserId ? `user${entry.UserId}` : null,
                        ClearedByUsername: entry.ClearedBy ? `user${entry.ClearedBy}` : null
                    }));
            }

            if (sql.includes('FROM "IosBetaRequests" WHERE "UserId" = $1 ORDER BY')) {
                return state.requests
                    .filter((entry) => entry.UserId === params[0])
                    .sort((a, b) => b.Id - a.Id);
            }

            return [];
        })
    };
};

describe('IosBetaRequestService', function () {
    let db;
    let service;

    beforeEach(function () {
        db = createFakeDb();
        service = new IosBetaRequestService(db);
    });

    it('rejects an Apple ID that is not an email address', async function () {
        expect((await service.create(1, { appleId: 'not-an-email' })).success).toBe(false);
        expect((await service.create(1, { appleId: '' })).success).toBe(false);
        expect((await service.create(1, { appleId: 'two@at@example.com' })).success).toBe(false);
        expect((await service.create(1, { appleId: 'trailing.dot@example.' })).success).toBe(false);
        expect(db.state.requests.length).toBe(0);
    });

    it('rejects a pathological Apple ID in linear time, not backtracking time', async function () {
        // CodeQL flagged the old regex-based check as polynomial on input
        // shaped like this - many "!." repetitions with no valid ending.
        const evil = `!@${'!.'.repeat(50000)}`;
        const start = Date.now();

        expect((await service.create(1, { appleId: evil })).success).toBe(false);

        expect(Date.now() - start).toBeLessThan(500);
    });

    it('files a request and refuses a second one while it is pending', async function () {
        expect((await service.create(1, { appleId: 'player@example.com' })).success).toBe(true);

        const second = await service.create(1, { appleId: 'player@example.com' });
        expect(second.success).toBe(false);
        expect(second.message).toMatch(/already have a pending/);
        expect(db.state.requests.length).toBe(1);
    });

    it('reports the caller their own most recent request', async function () {
        expect(await service.myRequest(1)).toBeNull();

        await service.create(1, { appleId: 'player@example.com' });
        const mine = await service.myRequest(1);

        expect(mine.status).toBe('pending');
        expect(mine.appleId).toBe('player@example.com');
    });

    it('lists newest-request-last for the admin queue and clears/reopens with an audit trail', async function () {
        await service.create(1, { appleId: 'first@example.com' });
        await service.create(2, { appleId: 'second@example.com' });

        const pending = await service.list('pending');
        expect(pending.length).toBe(2);
        expect(pending[0].appleId).toBe('first@example.com');

        expect((await service.setStatus(pending[0].id, 'nonsense', 9)).success).toBe(false);

        await service.setStatus(pending[0].id, 'cleared', 9);
        const cleared = await service.list('cleared');
        expect(cleared.length).toBe(1);
        expect(cleared[0].clearedBy).toBe('user9');
        expect((await service.list('pending')).length).toBe(1);

        await service.setStatus(pending[0].id, 'pending', 9);
        const reopened = await service.list('pending');
        expect(reopened.length).toBe(2);
        expect(reopened.find((entry) => entry.id === pending[0].id).clearedBy).toBeNull();
    });

    it('lets a request be filed again once the pending one was cleared', async function () {
        await service.create(1, { appleId: 'player@example.com' });
        const [first] = await service.list('pending');
        await service.setStatus(first.id, 'cleared', 9);

        const again = await service.create(1, { appleId: 'player@example.com' });
        expect(again.success).toBe(true);
        expect(db.state.requests.length).toBe(2);
    });
});
