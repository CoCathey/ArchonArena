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
    });
});
