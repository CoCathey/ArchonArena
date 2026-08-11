const ClubService = require('../../../../server/services/community/ClubService');

const createFakeDb = () => {
    const state = { clubs: [], members: [], nextId: 1 };

    return {
        state,
        query: vi.fn(async (sql, params = []) => {
            if (sql.includes('SELECT 1 FROM "Clubs"') && sql.includes('lower("Name")')) {
                return state.clubs.filter(
                    (club) => club.Name.toLowerCase() === params[0].toLowerCase()
                );
            }

            if (sql.includes('SELECT 1 FROM "Clubs"') && sql.includes('"JoinCode"')) {
                return state.clubs.filter((club) => club.JoinCode === params[0]);
            }

            if (sql.includes('INSERT INTO "Clubs"')) {
                const club = {
                    Id: state.nextId++,
                    Name: params[0],
                    Description: params[1],
                    OwnerId: params[2],
                    JoinCode: params[3],
                    // Recorded because the service reads it back to decide
                    // whether a join is a membership or a request. A fake that
                    // drops it makes every club look open, which is how the
                    // approval path went untested.
                    JoinPolicy: params[4]
                };
                state.clubs.push(club);
                return [{ Id: club.Id }];
            }

            if (sql.includes('SELECT * FROM "Clubs"') && sql.includes('"JoinCode"')) {
                return state.clubs.filter((club) => club.JoinCode === params[0]);
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
                        Role: sql.includes("'owner'") ? 'owner' : 'member',
                        // create() writes 'active' inline; join() passes it.
                        Status: sql.includes("'owner'") ? 'active' : params[2]
                    });
                }

                // ON CONFLICT DO NOTHING ... RETURNING: rows only come back for
                // an actual insert, which is what the owner notification keys
                // off.
                return exists ? [] : [{ Id: state.members.length }];
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
                        Status: member.Status,
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

    it('creating a club generates an 8-character unambiguous join code', async function () {
        const result = await service.create(1, { name: 'Austin Archons' });

        expect(result.joinCode).toMatch(/^[A-HJ-KM-NP-Z2-9]{8}$/);
        expect(db.state.clubs[0].JoinCode).toBe(result.joinCode);
    });

    it('players can join with a code, however it is formatted', async function () {
        const { id, joinCode } = await service.create(1, { name: 'Austin Archons' });

        const messy = ` ${joinCode.slice(0, 4).toLowerCase()}-${joinCode.slice(4)} `;
        const result = await service.joinByCode(2, messy);

        expect(result).toMatchObject({ success: true, id, name: 'Austin Archons' });
        expect(db.state.members.length).toBe(2);
    });

    // ARCHON: a club with an approval policy files a request rather than
    // admitting anyone, and joinByCode used to rebuild its reply from scratch
    // and drop that flag. Someone arriving with only a code has no club to read
    // the policy from, so the server saying "success" was the whole story they
    // got - and it was the wrong one.
    it('reports a code join into an approval club as pending, not joined', async function () {
        const { id, joinCode } = await service.create(1, {
            name: 'Austin Archons',
            joinPolicy: 'approval'
        });

        const result = await service.joinByCode(2, joinCode);

        expect(result).toMatchObject({ success: true, id, name: 'Austin Archons', pending: true });
        expect(db.state.members.find((member) => member.UserId === 2).Status).toBe('pending');

        // ...and the applicant is not a member yet, which is the fact the flag
        // exists to convey.
        expect((await service.getDetail(id, 2)).club.isMember).toBe(false);
    });

    it('reports a code join into an open club as an actual join', async function () {
        const { joinCode } = await service.create(1, { name: 'Austin Archons' });

        const result = await service.joinByCode(2, joinCode);

        expect(result).toMatchObject({ success: true, pending: false });
        expect(db.state.members.find((member) => member.UserId === 2).Status).toBe('active');
    });

    it('rejects unknown or malformed join codes', async function () {
        await service.create(1, { name: 'Austin Archons' });

        expect((await service.joinByCode(2, 'NOPE9999')).success).toBe(false);
        expect((await service.joinByCode(2, '')).success).toBe(false);
        expect((await service.joinByCode(2, 'ab')).success).toBe(false);
    });

    it('only the owner sees the join code in club detail', async function () {
        const { id, joinCode } = await service.create(1, { name: 'Austin Archons' });
        await service.join(id, 2);

        expect((await service.getDetail(id, 1)).club.joinCode).toBe(joinCode);
        expect((await service.getDetail(id, 2)).club.joinCode).toBeUndefined();
        expect((await service.getDetail(id, null)).club.joinCode).toBeUndefined();
    });
});
