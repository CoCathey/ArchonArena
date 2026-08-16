const ProfileCosmeticsService = require('../../../../server/services/community/ProfileCosmeticsService');
const PlayerProfileService = require('../../../../server/services/community/PlayerProfileService');
const { defaultCosmetics } = require('../../../../server/services/membership/cosmetics');
const { TIER_IDS, capabilitiesForTier } = require('../../../../server/services/membership/tiers');

const SUPPORTER = capabilitiesForTier(TIER_IDS.SUPPORTER);
const VAULT_MASTER = capabilitiesForTier(TIER_IDS.VAULT_MASTER);

describe('ProfileCosmeticsService', function () {
    let db;
    let service;

    beforeEach(function () {
        db = { query: vi.fn(async () => []) };
        service = new ProfileCosmeticsService(db);
    });

    describe('get', function () {
        it('is the defaults for an account that has never chosen', async function () {
            await expect(service.get(7)).resolves.toEqual(defaultCosmetics());
        });

        it('maps the row onto slot names', async function () {
            db.query.mockResolvedValue([
                { UserId: 7, Accent: 'logos', Frame: 'brass', NameEffect: null }
            ]);

            const cosmetics = await service.get(7);

            expect(cosmetics.accent).toBe('logos');
            expect(cosmetics.frame).toBe('brass');
            // A null column is "not chosen", not a stored null.
            expect(cosmetics.nameEffect).toBe('none');
        });

        it('is the defaults, not an error, when the table is unavailable', async function () {
            // The migration may not have run. A profile page that renders
            // undecorated is fine; one that 500s is not.
            db.query.mockRejectedValue(new Error('relation "ProfileCosmetics" does not exist'));

            await expect(service.get(7)).resolves.toEqual(defaultCosmetics());
        });
    });

    describe('save', function () {
        it('writes only the slots it was given', async function () {
            const result = await service.save(7, { banner: 'mars' }, SUPPORTER);

            expect(result.success).toBe(true);

            const [sql, params] = db.query.mock.calls[0];

            expect(sql).toContain('INSERT INTO "ProfileCosmetics"');
            expect(sql).toContain('ON CONFLICT ("UserId") DO UPDATE');
            expect(sql).toContain('"Banner"');
            expect(sql).not.toContain('"Frame"');
            expect(params).toEqual([7, 'mars']);
        });

        it('refuses a locked option and writes nothing at all', async function () {
            const result = await service.save(7, { banner: 'mars', frame: 'prismatic' }, SUPPORTER);

            expect(result.success).toBe(false);
            expect(result.rejected).toEqual(['frame']);
            expect(result.upgradeRequired).toBe(true);
            // Not a partial save: the request did not come from the editor
            // this account was shown, so none of it is trusted.
            expect(db.query).not.toHaveBeenCalled();
        });

        it('takes a custom accent from Vault Master, lightened to stay readable', async function () {
            await service.save(7, { accent: '#101020' }, VAULT_MASTER);

            const stored = db.query.mock.calls[0][1][1];

            expect(stored).toMatch(/^#[0-9a-f]{6}$/);
            expect(stored).not.toBe('#101020');
        });

        it('reports a failed write rather than claiming success', async function () {
            db.query.mockRejectedValue(new Error('nope'));

            const result = await service.save(7, { banner: 'mars' }, SUPPORTER);

            expect(result.success).toBe(false);
        });
    });
});

/**
 * ARCHON (N12): the public half - what a visitor to somebody's profile sees.
 */
describe('PlayerProfileService cosmetics', function () {
    let db;
    let service;

    const prime = ({ roles = [], membership = null, cosmetics = null } = {}) => {
        db.query.mockImplementation(async (sql) => {
            if (sql.includes('FROM "Users"')) {
                return [
                    {
                        Id: 7,
                        Username: 'Player1',
                        Settings_Avatar: 'player1',
                        Registered: new Date('2026-01-15T00:00:00Z')
                    }
                ];
            }
            if (sql.includes('FROM "UserRoles"')) {
                return roles.map((name) => ({ Name: name }));
            }
            if (sql.includes('FROM "Memberships"')) {
                return membership ? [membership] : [];
            }
            if (sql.includes('FROM "ProfileCosmetics"')) {
                return cosmetics ? [cosmetics] : [];
            }
            return [];
        });
    };

    beforeEach(function () {
        db = { query: vi.fn(async () => []) };
        service = new PlayerProfileService(db);
    });

    it('carries the member cosmetics on the public payload', async function () {
        prime({
            membership: { UserId: 7, Tier: 'supporter', Status: 'active', Provider: 'patreon' },
            cosmetics: { UserId: 7, Accent: 'logos', Banner: 'mars', Title: 'vault_diver' }
        });

        const profile = await service.getProfile('player1');

        expect(profile.cosmetics.banner).toBe('mars');
        expect(profile.cosmetics.titleLabel).toBe('Vault Diver');
        expect(profile.cosmetics.accentHex).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('drops them when the pledge has lapsed, without touching the row', async function () {
        prime({
            membership: { UserId: 7, Tier: 'supporter', Status: 'former_patron' },
            cosmetics: { UserId: 7, Accent: 'logos', Banner: 'mars' }
        });

        const profile = await service.getProfile('player1');

        expect(profile.cosmetics.banner).toBe('none');
        expect(profile.tierName).toBeNull();
        // Nothing was deleted - the only write path is save().
        const writes = db.query.mock.calls.filter(([sql]) => /UPDATE|DELETE|INSERT/.test(sql));

        expect(writes).toHaveLength(0);
    });

    it('shows an admin the cosmetics they chose, unlike the tier badge', async function () {
        // publicBadge deliberately strips the admin override, because saying an
        // admin is a Vault Master patron is a claim about money. A frame is
        // not, and an admin who cannot see the one they just picked would file
        // a bug.
        prime({ roles: ['Admin'], cosmetics: { UserId: 7, Frame: 'prismatic' } });

        const profile = await service.getProfile('player1');

        expect(profile.tier).toBe(TIER_IDS.FREE);
        expect(profile.cosmetics.frame).toBe('prismatic');
    });

    it('renders a profile even with no cosmetics table', async function () {
        db.query.mockImplementation(async (sql) => {
            if (sql.includes('FROM "ProfileCosmetics"')) {
                throw new Error('relation "ProfileCosmetics" does not exist');
            }
            if (sql.includes('FROM "Users"')) {
                return [{ Id: 7, Username: 'Player1', Registered: new Date() }];
            }
            return [];
        });

        const profile = await service.getProfile('player1');

        expect(profile.username).toBe('Player1');
        expect(profile.cosmetics.frame).toBe('none');
    });
});
