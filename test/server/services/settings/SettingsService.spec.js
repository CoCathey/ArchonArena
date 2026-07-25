const SettingsService = require('../../../../server/services/settings/SettingsService');
const { validateSection } = require('../../../../server/services/settings/registry');
const RatingService = require('../../../../server/services/rating/RatingService');

describe('settings registry validation', function () {
    it('accepts valid partial rating overrides', function () {
        expect(
            validateSection('rating', {
                enabled: false,
                leaderboardMinGames: 10,
                elo: { kFactor: 24, sasWeight: 2, keyDiffMultipliers: { 3: 1.5 } }
            })
        ).toEqual([]);
    });

    it('rejects unknown sections and unknown fields', function () {
        expect(validateSection('nope', {})).toEqual(["Unknown settings section 'nope'"]);
        expect(validateSection('rating', { hacked: true })).toEqual([
            'hacked is not an editable setting'
        ]);
        expect(validateSection('rating', { elo: { apiKey: 'x' } })).toEqual([
            'elo.apiKey is not an editable setting'
        ]);
    });

    it('rejects wrong types and out-of-range numbers', function () {
        expect(validateSection('rating', { enabled: 'yes' })).toContain(
            'enabled must be true or false'
        );
        expect(validateSection('rating', { elo: { kFactor: 0 } })).toContain(
            'elo.kFactor must be at least 1'
        );
        expect(validateSection('rating', { elo: { keyDiffMultipliers: { 9: 1 } } })).toContain(
            "elo.keyDiffMultipliers has unknown key '9'"
        );
    });
});

describe('SettingsService', function () {
    let db;
    let service;

    beforeEach(function () {
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new SettingsService(db);
    });

    it('serves empty overrides before load and after refresh with no rows', async function () {
        expect(service.getSection('rating')).toEqual({});

        await service.refresh();

        expect(service.getSection('rating')).toEqual({});
    });

    it('caches loaded rows for synchronous reads', async function () {
        db.query.mockResolvedValue([{ Key: 'rating', Value: { enabled: false } }]);

        await service.refresh();

        expect(service.getSection('rating')).toEqual({ enabled: false });
        expect(service.getSection('dok')).toEqual({});
    });

    it('persists valid overrides and refreshes the cache', async function () {
        db.query.mockImplementation(async (sql) => {
            if (sql.startsWith('SELECT')) {
                return [{ Key: 'rating', Value: { elo: { kFactor: 24 } } }];
            }
            return [];
        });

        const result = await service.setSection('rating', { elo: { kFactor: 24 } }, 7);

        expect(result.success).toBe(true);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO "SiteSettings"'),
            ['rating', JSON.stringify({ elo: { kFactor: 24 } }), 7]
        );
        expect(service.getSection('rating')).toEqual({ elo: { kFactor: 24 } });
    });

    it('rejects invalid overrides without writing', async function () {
        const result = await service.setSection('rating', { elo: { kFactor: -1 } }, 7);

        expect(result.success).toBe(false);
        const inserts = db.query.mock.calls.filter(([sql]) => sql.includes('INSERT'));
        expect(inserts.length).toBe(0);
    });

    it('resets a section', async function () {
        const result = await service.resetSection('rating', 7);

        expect(result.success).toBe(true);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringContaining('DELETE FROM "SiteSettings"'),
            ['rating']
        );
    });

    it('refuses to reset unknown sections', async function () {
        const result = await service.resetSection('nope', 7);

        expect(result.success).toBe(false);
        expect(db.query).not.toHaveBeenCalled();
    });

    it('survives refresh failures and keeps the last snapshot', async function () {
        db.query.mockResolvedValueOnce([{ Key: 'rating', Value: { enabled: false } }]);
        await service.refresh();

        db.query.mockRejectedValueOnce(new Error('db down'));
        await service.refresh();

        expect(service.getSection('rating')).toEqual({ enabled: false });
    });
});

describe('RatingService with admin settings overrides', function () {
    it('lets admin overrides win over defaults', function () {
        const settings = {
            getSection: (section) =>
                section === 'rating' ? { leaderboardMinGames: 20, elo: { kFactor: 16 } } : {}
        };
        const configService = { getValue: () => undefined };
        const ratingService = new RatingService(configService, { query: vi.fn() }, settings);

        const config = ratingService.getConfig();

        expect(config.leaderboardMinGames).toBe(20);
        expect(config.elo.kFactor).toBe(16);
        // Untouched values still come from defaults
        expect(config.enabled).toBe(true);
    });

    it('admin overrides beat file config, which beats defaults', function () {
        const settings = { getSection: () => ({ elo: { kFactor: 16 } }) };
        const configService = {
            getValue: (key) =>
                key === 'rating' ? { elo: { kFactor: 40, sasWeight: 8 } } : undefined
        };
        const ratingService = new RatingService(configService, { query: vi.fn() }, settings);

        const config = ratingService.getConfig();

        expect(config.elo.kFactor).toBe(16); // admin wins
        expect(config.elo.sasWeight).toBe(8); // file survives where admin silent
    });
});
