const FriendService = require('../../../../server/services/community/FriendService');

const createFakeDb = () => {
    const state = { users: [], friendships: [], nextId: 1 };

    return {
        state,
        query: vi.fn(async (sql, params = []) => {
            if (sql.includes('FROM "Users"')) {
                return state.users
                    .filter((user) => user.Username.toLowerCase() === params[0].toLowerCase())
                    .map((user) => ({ Id: user.Id }));
            }

            if (sql.includes('INSERT INTO "Friendships"')) {
                state.friendships.push({
                    Id: state.nextId++,
                    RequesterId: params[0],
                    AddresseeId: params[1],
                    Status: 'pending'
                });
                return [];
            }

            if (sql.includes('SELECT * FROM "Friendships" WHERE ("RequesterId" = $1')) {
                return state.friendships.filter(
                    (row) =>
                        (row.RequesterId === params[0] && row.AddresseeId === params[1]) ||
                        (row.RequesterId === params[1] && row.AddresseeId === params[0])
                );
            }

            if (sql.includes('AND "Status" = \'pending\'')) {
                return state.friendships.filter(
                    (row) =>
                        row.RequesterId === params[0] &&
                        row.AddresseeId === params[1] &&
                        row.Status === 'pending'
                );
            }

            if (sql.includes('SET "Status" = \'accepted\'')) {
                const row = state.friendships.find((entry) => entry.Id === params[0]);
                if (row) {
                    row.Status = 'accepted';
                }
                return [];
            }

            if (sql.includes('DELETE FROM "Friendships"')) {
                state.friendships = state.friendships.filter((entry) => entry.Id !== params[0]);
                return [];
            }

            if (sql.includes('JOIN "Users" ur')) {
                return state.friendships
                    .filter((row) => row.RequesterId === params[0] || row.AddresseeId === params[0])
                    .map((row) => ({
                        ...row,
                        RequesterName: `user${row.RequesterId}`,
                        AddresseeName: `user${row.AddresseeId}`
                    }));
            }

            return [];
        })
    };
};

describe('FriendService', function () {
    let db;
    let service;

    beforeEach(function () {
        db = createFakeDb();
        db.state.users = [
            { Id: 1, Username: 'Alice' },
            { Id: 2, Username: 'Bob' },
            { Id: 3, Username: 'Cara' }
        ];
        service = new FriendService(db);
    });

    it('sends a request by username, case-insensitively', async function () {
        const result = await service.sendRequest(1, 'bob');

        expect(result.success).toBe(true);
        expect(db.state.friendships[0]).toMatchObject({
            RequesterId: 1,
            AddresseeId: 2,
            Status: 'pending'
        });
    });

    it('rejects self-friending and unknown players', async function () {
        expect((await service.sendRequest(1, 'Alice')).success).toBe(false);
        expect((await service.sendRequest(1, 'Nobody')).success).toBe(false);
    });

    it('rejects duplicate requests and existing friendships', async function () {
        await service.sendRequest(1, 'Bob');
        expect((await service.sendRequest(1, 'Bob')).success).toBe(false);

        await service.respond(2, 1, true);
        expect((await service.sendRequest(1, 'Bob')).success).toBe(false);
    });

    it('auto-accepts when both players request each other', async function () {
        await service.sendRequest(1, 'Bob');
        const crossRequest = await service.sendRequest(2, 'Alice');

        expect(crossRequest.success).toBe(true);
        expect(db.state.friendships[0].Status).toBe('accepted');
        expect(db.state.friendships.length).toBe(1);
    });

    it('declining deletes the request so it can be re-sent', async function () {
        await service.sendRequest(1, 'Bob');
        await service.respond(2, 1, false);

        expect(db.state.friendships.length).toBe(0);
        expect((await service.sendRequest(1, 'Bob')).success).toBe(true);
    });

    it('only the addressee can respond', async function () {
        await service.sendRequest(1, 'Bob');

        // Cara (3) has no pending request from Alice
        expect((await service.respond(3, 1, true)).success).toBe(false);
        // Alice cannot accept her own request (no pending row towards her)
        expect((await service.respond(1, 2, true)).success).toBe(false);
    });

    it('remove deletes an accepted friendship from either side', async function () {
        await service.sendRequest(1, 'Bob');
        await service.respond(2, 1, true);

        expect((await service.remove(2, 1)).success).toBe(true);
        expect(db.state.friendships.length).toBe(0);
        expect((await service.remove(2, 1)).success).toBe(false);
    });

    it('overview splits friends, incoming and outgoing', async function () {
        await service.sendRequest(1, 'Bob'); // outgoing for 1
        await service.sendRequest(3, 'Alice'); // incoming for 1
        await service.sendRequest(2, 'Cara');
        await service.respond(3, 2, true); // 2-3 friends (irrelevant to 1)

        const overview = await service.overview(1);

        expect(overview.outgoing).toEqual([{ userId: 2, username: 'user2' }]);
        expect(overview.incoming).toEqual([{ userId: 3, username: 'user3' }]);
        expect(overview.friends).toEqual([]);
    });
});
