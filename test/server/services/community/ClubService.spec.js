const ClubService = require('../../../../server/services/community/ClubService');

const createFakeDb = () => {
    const state = { clubs: [], members: [], nextId: 1 };

    return {
        state,
        query: vi.fn(async (sql, params = []) => {
            if (sql.includes('SELECT 1 FROM "Clubs"')) {
                return state.clubs.filter(
                    (club) => club.Name.toLowerCase() === params[0].toLowerCase()
                );
            }

            if (sql.includes('INSERT INTO "Clubs"')) {
                const club = {
                    Id: state.nextId++,
                    Name: params[0],
                    Description: params[1],
                    OwnerId: params[2]
                };
                state.clubs.push(club);
                return [{ Id: club.Id }];
            }

            if (sql.includes('SELECT * FROM "Clubs"')) {
                return state.clubs.filter((club) => club.Id === params[0]);
            }

            if (sql.includes('INSERT INTO "ClubMembers"')) {
                const exists = state.members.some(
                    (member) => member.ClubId === params[0] && member.UserId === params[1]
                );
                if (!exists) {
                    state.members.push({
                        ClubId: params[0],
                        UserId: params[1],
                        Role: sql.includes("'owner'") ? 'owner' : 'member'
                    });
                }
                return [];
            }

            if (sql.includes('DELETE FROM "ClubMembers"')) {
                state.members = state.members.filter(
                    (member) => !(member.ClubId === params[0] && member.UserId === params[1])
                );
                return [];
            }

            if (sql.includes('DELETE FROM "Clubs"')) {
                state.clubs = state.clubs.filter((club) => club.Id !== params[0]);
                state.members = state.members.filter((member) => member.ClubId !== params[0]);
                return [];
            }

            if (sql.includes('FROM "ClubMembers" cm')) {
                return state.members
                    .filter((member) => member.ClubId === params[0])
                    .map((member) => ({
                        UserId: member.UserId,
                        Role: member.Role,
                        Username: `user${member.UserId}`,
                        Country: null
                    }));
            }

            return [];
        })
    };
};

describe('ClubService', function () {
    let db;
    let service;
    const admin = { id: 42, permissions: { isAdmin: true } };

    beforeEach(function () {
        db = createFakeDb();
        service = new ClubService(db);
    });

    it('creates a club with the creator as owner-member', async function () {
        const result = await service.create(1, { name: 'Austin Archons' });

        expect(result.success).toBe(true);
        expect(db.state.members[0]).toMatchObject({ UserId: 1, Role: 'owner' });
    });

    it('validates name length and uniqueness (case-insensitive)', async function () {
        expect((await service.create(1, { name: 'ab' })).success).toBe(false);

        await service.create(1, { name: 'Austin Archons' });
        expect((await service.create(2, { name: 'austin archons' })).success).toBe(false);
    });

    it('members can join and leave; joining twice is a no-op', async function () {
        const { id } = await service.create(1, { name: 'Austin Archons' });

        await service.join(id, 2);
        await service.join(id, 2);
        expect(db.state.members.length).toBe(2);

        expect((await service.leave(id, 2)).success).toBe(true);
        expect(db.state.members.length).toBe(1);
    });

    it('owners cannot leave their own club', async function () {
        const { id } = await service.create(1, { name: 'Austin Archons' });

        const result = await service.leave(id, 1);

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/disband/i);
    });

    it('only the owner (or admin) removes members, never the owner', async function () {
        const { id } = await service.create(1, { name: 'Austin Archons' });
        await service.join(id, 2);

        expect((await service.removeMember(id, 2, { id: 3, permissions: {} })).success).toBe(false);
        expect((await service.removeMember(id, 1, { id: 1, permissions: {} })).success).toBe(false);
        expect((await service.removeMember(id, 2, { id: 1, permissions: {} })).success).toBe(true);
    });

    it('owner or admin can disband; members cannot', async function () {
        const { id } = await service.create(1, { name: 'Austin Archons' });
        await service.join(id, 2);

        expect((await service.disband(id, { id: 2, permissions: {} })).success).toBe(false);
        expect((await service.disband(id, admin)).success).toBe(true);
        expect(db.state.clubs.length).toBe(0);
    });

    it('detail reports membership and ownership for the viewer', async function () {
        const { id } = await service.create(1, { name: 'Austin Archons' });
        await service.join(id, 2);

        const asOwner = await service.getDetail(id, 1);
        const asMember = await service.getDetail(id, 2);
        const asGuest = await service.getDetail(id, null);

        expect(asOwner.club.isOwner).toBe(true);
        expect(asMember.club).toMatchObject({ isMember: true, isOwner: false });
        expect(asGuest.club.isMember).toBe(false);
        expect(asOwner.members.length).toBe(2);
    });
});
