const ClubService = require('../../../../server/services/community/ClubService');

/**
 * ARCHON (N7): approval-based joins, ownership transfer and the club board.
 */
describe('ClubService join approval', function () {
    let service;
    let db;
    let club;
    let inserted;
    let notifications;

    beforeEach(function () {
        club = { Id: 1, Name: 'Austin Archons', OwnerId: 9, JoinPolicy: 'open' };
        inserted = [{ Id: 100 }];
        notifications = { notify: vi.fn() };

        db = {
            query: vi.fn().mockImplementation(async (sql) => {
                if (sql.includes('FROM "Clubs"')) {
                    return [club];
                }

                if (sql.includes('INSERT INTO "ClubMembers"')) {
                    return inserted;
                }

                if (sql.includes('FROM "Users"')) {
                    return [{ Username: 'newcomer' }];
                }

                return [];
            })
        };

        service = new ClubService(db, notifications);
    });

    const memberInsert = () =>
        db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO "ClubMembers"'));

    it('adds a member straight away on an open club', async function () {
        const result = await service.join(1, 5);

        expect(result.pending).toBe(false);
        expect(memberInsert()[1][2]).toBe('active');
    });

    it('holds the join for approval when the club asks for it', async function () {
        club.JoinPolicy = 'approval';

        const result = await service.join(1, 5);

        expect(result.pending).toBe(true);
        expect(memberInsert()[1][2]).toBe('pending');
    });

    /**
     * A join code can be forwarded by anyone, so treating one as pre-approval
     * would let a leaked code walk straight past the vetting the owner asked
     * for.
     */
    it('still requires approval for a join made with a code', async function () {
        club.JoinPolicy = 'approval';
        club.JoinCode = 'ABCD2345';

        await service.joinByCode(5, 'ABCD2345');

        expect(memberInsert()[1][2]).toBe('pending');
    });

    it('tells the owner a request is waiting, not that someone joined', async function () {
        club.JoinPolicy = 'approval';

        await service.join(1, 5);

        expect(notifications.notify).toHaveBeenCalledWith(
            expect.objectContaining({ title: expect.stringMatching(/asked to join/i) })
        );
    });

    it('treats an unknown join policy as open', function () {
        expect(service.normalizeJoinPolicy('nonsense')).toBe('open');
        expect(service.normalizeJoinPolicy(undefined)).toBe('open');
        expect(service.normalizeJoinPolicy('approval')).toBe('approval');
    });
});

describe('ClubService deciding join requests', function () {
    let service;
    let db;
    let club;
    let affected;
    let notifications;

    beforeEach(function () {
        club = { Id: 1, Name: 'Austin Archons', OwnerId: 9, JoinPolicy: 'approval' };
        affected = [{ Id: 100 }];
        notifications = { notify: vi.fn() };

        db = {
            query: vi.fn().mockImplementation(async (sql) => {
                if (sql.includes('FROM "Clubs"')) {
                    return [club];
                }

                if (
                    sql.includes('UPDATE "ClubMembers"') ||
                    sql.includes('DELETE FROM "ClubMembers"')
                ) {
                    return affected;
                }

                return [];
            })
        };

        service = new ClubService(db, notifications);
    });

    it('only lets the owner decide', async function () {
        const result = await service.decideJoinRequest(1, 5, { id: 42, permissions: {} }, true);

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/only the owner/i);
    });

    it('lets a site admin decide too', async function () {
        const result = await service.decideJoinRequest(
            1,
            5,
            { id: 42, permissions: { isAdmin: true } },
            true
        );

        expect(result.success).toBe(true);
    });

    it('activates the member on approval', async function () {
        await service.decideJoinRequest(1, 5, { id: 9 }, true);

        const update = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE "ClubMembers"'));

        expect(update[0]).toContain("'active'");
    });

    /**
     * Denying deletes the row rather than marking it rejected: a club is not
     * a permanent record of who was turned away, and a kept row would quietly
     * stop the person ever asking again.
     */
    it('removes the row on a decline so the player can ask again', async function () {
        await service.decideJoinRequest(1, 5, { id: 9 }, false);

        expect(db.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM "ClubMembers"'))).toBe(
            true
        );
    });

    it('says nothing to a declined applicant', async function () {
        await service.decideJoinRequest(1, 5, { id: 9 }, false);

        expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('tells an approved applicant they are in', async function () {
        await service.decideJoinRequest(1, 5, { id: 9 }, true);

        expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 5 }));
    });

    it('reports when there was no pending request', async function () {
        affected = [];

        const result = await service.decideJoinRequest(1, 5, { id: 9 }, true);

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/no pending request/i);
    });
});

describe('ClubService ownership transfer', function () {
    let service;
    let db;
    let client;
    let club;
    let targetIsMember;

    beforeEach(function () {
        club = { Id: 1, Name: 'Austin Archons', OwnerId: 9 };
        targetIsMember = true;
        client = { release: vi.fn() };

        db = {
            query: vi.fn().mockImplementation(async (sql) => {
                if (sql.includes('FROM "Clubs"')) {
                    return [club];
                }

                if (sql.includes('FROM "ClubMembers"')) {
                    return targetIsMember ? [{ exists: 1 }] : [];
                }

                return [];
            }),
            queryTran: vi.fn().mockResolvedValue([]),
            startTransaction: vi.fn().mockResolvedValue(client)
        };

        service = new ClubService(db, null);
    });

    it('refuses to hand the club to a non-member', async function () {
        targetIsMember = false;

        const result = await service.transferOwnership(1, 5, { id: 9 });

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/not a member/i);
    });

    it('only lets the owner transfer', async function () {
        const result = await service.transferOwnership(1, 5, { id: 42, permissions: {} });

        expect(result.success).toBe(false);
    });

    /**
     * A club with two owners, or none, would be worse than a failed transfer -
     * so all three writes move together.
     */
    it('moves the club and both member rows in one transaction', async function () {
        const result = await service.transferOwnership(1, 5, { id: 9 });

        expect(result.success).toBe(true);
        expect(db.startTransaction).toHaveBeenCalledTimes(1);
        expect(db.queryTran.mock.calls.some(([, sql]) => sql === 'COMMIT')).toBe(true);
        expect(client.release).toHaveBeenCalled();
    });

    it('leaves the old owner on as an ordinary member', async function () {
        await service.transferOwnership(1, 5, { id: 9 });

        const demote = db.queryTran.mock.calls.find(
            ([, sql]) => sql.includes("'member'") && sql.includes('UPDATE "ClubMembers"')
        );

        expect(demote[2]).toEqual([1, 9]);
    });

    it('rolls back if anything goes wrong', async function () {
        db.queryTran.mockImplementation(async (c, sql) => {
            if (sql.includes('UPDATE "Clubs"')) {
                throw new Error('connection lost');
            }

            return [];
        });

        const result = await service.transferOwnership(1, 5, { id: 9 });

        expect(result.success).toBe(false);
        expect(db.queryTran.mock.calls.some(([, sql]) => sql === 'ROLLBACK')).toBe(true);
    });
});
