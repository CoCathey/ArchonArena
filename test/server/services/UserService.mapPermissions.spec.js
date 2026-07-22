const UserService = require('../../../server/services/UserService');

describe('UserService.mapPermissions', function () {
    let service;

    beforeEach(function () {
        service = new UserService({});
    });

    const rolesToPermissions = (names) => service.mapPermissions(names.map((Name) => ({ Name })));

    it('grants only the mapped permission for a single non-admin role', function () {
        const perms = rolesToPermissions(['UserManager']);

        expect(perms.canManageUsers).toBe(true);
        expect(perms.canEditNews).toBe(false);
        expect(perms.isAdmin).toBe(false);
    });

    it('makes Admin a superuser - implies every management permission', function () {
        const perms = rolesToPermissions(['Admin']);

        expect(perms.isAdmin).toBe(true);
        expect(perms.canManageUsers).toBe(true);
        expect(perms.canEditNews).toBe(true);
        expect(perms.canManagePermissions).toBe(true);
        expect(perms.canManageGames).toBe(true);
        expect(perms.canManageNodes).toBe(true);
        expect(perms.canModerateChat).toBe(true);
        expect(perms.canVerifyDecks).toBe(true);
        expect(perms.canManageBanlist).toBe(true);
        expect(perms.canManageMotd).toBe(true);
        expect(perms.canManageTournaments).toBe(true);
    });

    it('does not inflate non-management flags for Admin', function () {
        const perms = rolesToPermissions(['Admin']);

        // Superuser is about management access, not cosmetic/status flags.
        expect(perms.isSupporter).toBe(false);
        expect(perms.isContributor).toBe(false);
        expect(perms.isWinner).toBe(false);
    });

    it('grants nothing for an empty role list', function () {
        const perms = rolesToPermissions([]);

        expect(Object.values(perms).every((value) => value === false)).toBe(true);
    });
});
