const TestFlightService = require('../../../../server/services/mobile/TestFlightService');

const createFakeDb = () => {
    const state = { requests: [], nextId: 1 };

    return {
        state,
        query: vi.fn(async (sql, params = []) => {
            if (sql.includes('INSERT INTO "TestFlightRequests"')) {
                const [userId] = params;
                const alreadyPending = state.requests.some(
                    (entry) => entry.UserId === userId && entry.Status === 'pending'
                );

                if (alreadyPending) {
                    return [];
                }

                const row = {
                    Id: state.nextId++,
                    UserId: params[0],
                    AppleIdEmail: params[1],
                    Status: 'pending',
                    ResolvedBy: null,
                    ResolvedAt: null,
                    CreatedAt: new Date()
                };
                state.requests.push(row);

                return [{ Id: row.Id }];
            }

            if (sql.includes('UPDATE "TestFlightRequests"')) {
                const request = state.requests.find((entry) => entry.Id === params[0]);
                if (request) {
                    request.Status = params[1];
                    if (params[1] === 'resolved') {
                        request.ResolvedBy = params[2];
                        request.ResolvedAt = new Date();
                    } else {
                        request.ResolvedBy = null;
                        request.ResolvedAt = null;
                    }
                }
                return [];
            }

            if (sql.includes('FROM "TestFlightRequests" WHERE "UserId"')) {
                const rows = state.requests
                    .filter((entry) => entry.UserId === params[0])
                    .sort((a, b) => b.Id - a.Id);

                return rows.slice(0, 1);
            }

            if (sql.includes('FROM "TestFlightRequests" r')) {
                let rows = [...state.requests];
                if (sql.includes('r."Status" = $1')) {
                    rows = rows.filter((entry) => entry.Status === params[0]);
                }
                return rows
                    .sort((a, b) => a.Id - b.Id)
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

describe('TestFlightService', function () {
    let db;
    let service;

    beforeEach(function () {
        db = createFakeDb();
        service = new TestFlightService(db);
    });

    it('rejects a missing or malformed Apple ID email', async function () {
        expect((await service.request(1, '')).success).toBe(false);
        expect((await service.request(1, 'not-an-email')).success).toBe(false);
        expect(db.state.requests.length).toBe(0);
    });

    it('files a request and reports it back to the same account', async function () {
        const result = await service.request(1, 'player@example.com');

        expect(result.success).toBe(true);
        expect(result.alreadyPending).toBe(false);

        const mine = await service.getForUser(1);
        expect(mine.appleIdEmail).toBe('player@example.com');
        expect(mine.status).toBe('pending');
    });

    it('does not create a second row while one is already pending', async function () {
        await service.request(1, 'first@example.com');
        const second = await service.request(1, 'second@example.com');

        expect(second.success).toBe(true);
        expect(second.alreadyPending).toBe(true);
        expect(db.state.requests.length).toBe(1);
        // The original address is kept - a second call is treated as "am I
        // still in the queue", not a request to redirect the invite.
        expect((await service.getForUser(1)).appleIdEmail).toBe('first@example.com');
    });

    it('lets an account ask again once its request is resolved', async function () {
        await service.request(1, 'first@example.com');
        const [request] = await service.list();
        await service.setStatus(request.id, 'resolved', 9);

        const again = await service.request(1, 'second@example.com');

        expect(again.success).toBe(true);
        expect(again.alreadyPending).toBe(false);
        expect(db.state.requests.length).toBe(2);
    });

    it('returns null for an account that has never asked', async function () {
        expect(await service.getForUser(42)).toBeNull();
    });

    it('lists oldest-first and filters by status, with an audit trail on resolve', async function () {
        await service.request(1, 'a@example.com');
        await service.request(2, 'b@example.com');

        const [first] = await service.list();
        expect((await service.setStatus(first.id, 'nonsense', 9)).success).toBe(false);

        await service.setStatus(first.id, 'resolved', 9);

        const pending = await service.list('pending');
        expect(pending.length).toBe(1);
        expect(pending[0].appleIdEmail).toBe('b@example.com');

        const resolved = await service.list('resolved');
        expect(resolved.length).toBe(1);
        expect(resolved[0].resolvedBy).toBe('user9');

        const all = await service.list();
        expect(all.map((entry) => entry.username)).toEqual(['user1', 'user2']);
    });
});
