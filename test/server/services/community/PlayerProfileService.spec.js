const PlayerProfileService = require('../../../../server/services/community/PlayerProfileService');

describe('PlayerProfileService', function () {
    let db;
    let service;

    const userRow = (overrides = {}) => ({
        Id: 7,
        Username: 'Player1',
        Settings_Avatar: 'player1',
        Country: 'US',
        State: 'TX',
        Bio: null,
        Registered: new Date('2026-01-15T00:00:00Z'),
        ...overrides
    });

    beforeEach(function () {
        db = { query: vi.fn(async () => []) };
        service = new PlayerProfileService(db);
    });

    // Route the fake db by which table the query mentions.
    const prime = ({ user = userRow(), clubs = [], games = [] } = {}) => {
        db.query.mockImplementation(async (sql) => {
            if (sql.includes('FROM "Users"')) {
                return user ? [user] : [];
            }
            if (sql.includes('FROM "ClubMembers"')) {
                return clubs;
            }
            if (sql.includes('FROM "Games"')) {
                return games;
            }
            return [];
        });
    };

    describe('getProfile', function () {
        it('returns the public header with clubs and recent games', async function () {
            prime({
                clubs: [{ Id: 3, Name: 'Austin KeyForge', Role: 'owner' }],
                games: [
                    {
                        GameId: 'game-1',
                        GameFormat: 'archon',
                        FinishedAt: new Date('2026-07-01T00:00:00Z'),
                        WinReason: 'keys',
                        Won: true,
                        OwnKeys: 3,
                        OpponentKeys: 1,
                        Opponent: 'Player2',
                        DeckName: 'Some Deck'
                    }
                ]
            });

            const profile = await service.getProfile('player1');

            expect(profile.username).toBe('Player1');
            expect(profile.avatar).toBe('player1');
            expect(profile.country).toBe('US');
            expect(profile.clubs).toEqual([{ id: 3, name: 'Austin KeyForge', role: 'owner' }]);
            expect(profile.recentGames).toHaveLength(1);
            expect(profile.recentGames[0]).toMatchObject({
                gameId: 'game-1',
                won: true,
                keys: 3,
                opponentKeys: 1,
                opponent: 'Player2'
            });
        });

        // The profile is public, so it must never widen what the leaderboards
        // and member directory already expose.
        it('never exposes private fields', async function () {
            prime();

            const profile = await service.getProfile('player1');

            for (const field of ['email', 'Email', 'password', 'Password', 'RegisterIp', 'id']) {
                expect(profile[field]).toBeUndefined();
            }

            // The query itself must not even select them.
            const userSql = db.query.mock.calls.find((call) => call[0].includes('FROM "Users"'))[0];
            expect(userSql).not.toMatch(/Email|Password|RegisterIp/);
        });

        // Disabled and unverified accounts are excluded by the same rule the
        // member directory and leaderboards use.
        it('excludes disabled and unverified accounts in the lookup', async function () {
            prime();

            await service.getProfile('player1');

            const userSql = db.query.mock.calls.find((call) => call[0].includes('FROM "Users"'))[0];
            expect(userSql).toContain('"Disabled" IS NOT TRUE');
            expect(userSql).toContain('"Verified" IS TRUE');
        });

        it('returns null for an unknown player', async function () {
            prime({ user: null });

            expect(await service.getProfile('nobody')).toBeNull();
        });

        it('returns null without querying when no username is given', async function () {
            expect(await service.getProfile('')).toBeNull();
            expect(db.query).not.toHaveBeenCalled();
        });

        // A brand-new account must still produce a working page.
        it('renders an empty profile for a player with no games or clubs', async function () {
            prime({ clubs: [], games: [] });

            const profile = await service.getProfile('player1');

            expect(profile.clubs).toEqual([]);
            expect(profile.recentGames).toEqual([]);
        });

        it('includes the bio when set, and null when not', async function () {
            prime({ user: userRow({ Bio: 'Plays Brobnar, mostly by accident.' }) });

            expect((await service.getProfile('player1')).bio).toBe(
                'Plays Brobnar, mostly by accident.'
            );

            prime({ user: userRow({ Bio: null }) });

            expect((await service.getProfile('player1')).bio).toBeNull();
        });
    });

    describe('getBio', function () {
        it('returns the stored bio', async function () {
            db.query.mockImplementation(async () => [{ Bio: 'Hello there' }]);

            expect(await service.getBio(7)).toBe('Hello there');
        });

        it('returns null when no bio is set', async function () {
            db.query.mockImplementation(async () => [{ Bio: null }]);

            expect(await service.getBio(7)).toBeNull();
        });
    });

    describe('setBio', function () {
        it('trims and stores the bio', async function () {
            const result = await service.setBio(7, '  Hello there  ');

            expect(result).toEqual({ success: true, bio: 'Hello there' });
            expect(db.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE "Users"'), [
                'Hello there',
                7
            ]);
        });

        it('truncates to the maximum length rather than rejecting', async function () {
            const long = 'x'.repeat(400);

            const result = await service.setBio(7, long);

            expect(result.bio).toHaveLength(280);
        });

        it('clears the bio when given an empty value', async function () {
            const result = await service.setBio(7, '');

            expect(result).toEqual({ success: true, bio: null });
            expect(db.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE "Users"'), [
                null,
                7
            ]);
        });

        it('stores null unchanged', async function () {
            const result = await service.setBio(7, null);

            expect(result).toEqual({ success: true, bio: null });
        });
    });

    /**
     * ARCHON (N12): the profile half of the supporter badge.
     *
     * Supporter is sold as "show your support next to your name in the lobby and
     * on your profile". The lobby half worked; this payload carried no role at
     * all, so half of a live paid promise was unkept.
     */
    describe('getRole', function () {
        const primeRoles = ({ roles = [], membership = null } = {}) => {
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "UserRoles"')) {
                    return roles.map((name) => ({ Name: name }));
                }
                if (sql.includes('FROM "Memberships"')) {
                    return membership ? [membership] : [];
                }
                return [];
            });
        };

        it('is user for an account with no roles and no membership', async function () {
            primeRoles();

            await expect(service.getRole(7)).resolves.toBe('user');
        });

        it('is supporter for the granted Roles-table row', async function () {
            primeRoles({ roles: ['Supporter'] });

            await expect(service.getRole(7)).resolves.toBe('supporter');
        });

        it('is supporter for a Patreon member who was never granted the role', async function () {
            // The case the badge was sold for and never delivered: paying on
            // Patreon writes a Memberships row and touches no role.
            primeRoles({
                membership: { UserId: 7, Tier: 'supporter', Status: 'active', Provider: 'patreon' }
            });

            await expect(service.getRole(7)).resolves.toBe('supporter');
        });

        it('prefers the higher badge when an account has several', async function () {
            primeRoles({
                roles: ['Supporter', 'Admin', 'Contributor'],
                membership: { UserId: 7, Tier: 'archon', Status: 'active' }
            });

            await expect(service.getRole(7)).resolves.toBe('admin');
        });

        it('is user, not an error, when the membership table is unavailable', async function () {
            // The Memberships migration may not have run. A profile that
            // renders without a badge is fine; one that 500s is not.
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "Memberships"')) {
                    throw new Error('relation "Memberships" does not exist');
                }
                return [];
            });

            await expect(service.getRole(7)).resolves.toBe('user');
        });

        it('is included in the public profile payload', async function () {
            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "Users"')) {
                    return [userRow()];
                }
                if (sql.includes('FROM "UserRoles"')) {
                    return [{ Name: 'Supporter' }];
                }
                return [];
            });

            const profile = await service.getProfile('Player1');

            expect(profile.role).toBe('supporter');
        });
    });
});
