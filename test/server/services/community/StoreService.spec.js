const StoreService = require('../../../../server/services/community/StoreService');

const createFakeDb = () => {
    const state = { stores: [], nextId: 1 };

    return {
        state,
        query: vi.fn(async (sql, params = []) => {
            if (sql.includes('INSERT INTO "Stores"')) {
                const store = {
                    Id: state.nextId++,
                    Name: params[0],
                    Country: params[1],
                    State: params[2],
                    City: params[3],
                    Address: params[4],
                    Website: params[5],
                    Description: params[6],
                    AddedByUserId: params[7]
                };
                state.stores.push(store);
                return [{ Id: store.Id }];
            }

            if (sql.includes('SELECT * FROM "Stores" WHERE "Id"')) {
                return state.stores.filter((store) => store.Id === params[0]);
            }

            if (sql.includes('FROM "Stores" s')) {
                return state.stores;
            }

            if (sql.includes('DELETE FROM "Stores"')) {
                state.stores = state.stores.filter((store) => store.Id !== params[0]);
                return [];
            }

            return [];
        })
    };
};

describe('StoreService', function () {
    let db;
    let service;
    const admin = { id: 99, permissions: { isAdmin: true } };

    beforeEach(function () {
        db = createFakeDb();
        service = new StoreService(db);
    });

    it('adds a store with a normalized country', async function () {
        const result = await service.create(1, {
            name: 'Dragon Cards',
            country: 'us',
            state: 'Texas',
            city: 'Austin'
        });

        expect(result.success).toBe(true);
        expect(db.state.stores[0]).toMatchObject({
            Name: 'Dragon Cards',
            Country: 'US',
            State: 'Texas',
            City: 'Austin',
            AddedByUserId: 1
        });
    });

    it('validates the name length', async function () {
        expect((await service.create(1, { name: 'A' })).success).toBe(false);
        expect((await service.create(1, { name: '' })).success).toBe(false);
    });

    it('rejects an unknown country', async function () {
        const result = await service.create(1, { name: 'Nowhere Games', country: 'ZZ' });

        expect(result.success).toBe(false);
    });

    it('drops state when no country is given', async function () {
        await service.create(1, { name: 'Online Only', state: 'Nowhere' });

        expect(db.state.stores[0].State).toBeNull();
    });

    it('only the adder or an admin can remove a store', async function () {
        const { id } = await service.create(1, { name: 'Dragon Cards', country: 'US' });

        expect((await service.remove(id, { id: 2, permissions: {} })).success).toBe(false);
        expect((await service.remove(id, admin)).success).toBe(true);
        expect(db.state.stores.length).toBe(0);
    });

    it('lets the adder remove their own store', async function () {
        const { id } = await service.create(7, { name: 'Local Meetup' });

        expect((await service.remove(id, { id: 7, permissions: {} })).success).toBe(true);
    });
});
