const fs = require('fs');
const path = require('path');

const GauntletService = require('../../../../server/services/championschallenge/GauntletService');
const ChampionsChallengeService = require('../../../../server/services/championschallenge/ChampionsChallengeService');

/**
 * ARCHON (N29): the Gauntlet, on a server where nobody has turned anything on.
 *
 * The field is drawn from the Master Vault deck catalog, and the crawl that
 * builds that catalog ships OFF - it walks somebody else's API, so switching it
 * on is an operator's decision. The consequence was a feature that looks
 * available and cannot work: a member enabled the Gauntlet, saw "0 of 0 pool",
 * and read "the pool is still being built", which is true of a pool that is
 * filling and false of one that never will.
 *
 * Two claims are pinned here. The member is told WHICH kind of empty this is,
 * and the operator can see the crawl's own state - on or off, how far it has
 * walked, whether its circuit breaker has parked it - rather than inferring it
 * from an empty pool.
 */
describe('a Gauntlet nobody has switched on', function () {
    let db;
    let config;

    const configService = { getValue: () => ({}) };
    const settingsService = {
        getSectionWithDefaults: (name) => (name === 'championsChallenge' ? { ...config } : {}),
        getSection: (name) => (name === 'catalog' ? { ...(config.catalog || {}) } : {})
    };

    const answer = (handlers) =>
        db.query.mockImplementation(async (sql, params) => {
            for (const [fragment, rows] of handlers) {
                if (sql.includes(fragment)) {
                    return typeof rows === 'function' ? rows(sql, params) : rows;
                }
            }

            return [];
        });

    beforeEach(function () {
        config = { gauntletEnabled: true };
        db = { query: vi.fn().mockResolvedValue([]) };
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    describe('what the member is told', function () {
        const statusWith = async (catalogRows) => {
            const service = new GauntletService(configService, db, settingsService);

            answer([
                ['FROM "DeckCatalog"', catalogRows],
                ['FROM "GauntletDecks"', [{ Playable: 0, Hydrated: 0 }]]
            ]);

            return service.poolStatus(1, {
                sets: [],
                houses: [],
                strategies: [],
                minSas: null,
                maxSas: null
            });
        };

        it('says the pool is empty because nothing is being indexed', async function () {
            expect((await statusWith([])).catalogEmpty).toBe(true);
        });

        it('does not say that when the catalog has decks in it', async function () {
            expect((await statusWith([{ '?column?': 1 }])).catalogEmpty).toBe(false);
        });

        // Telling a member their server is not indexing decks because one query
        // hiccuped is worse than saying nothing: it names a cause that is not so.
        it('assumes a populated catalog when the check itself fails', async function () {
            const service = new GauntletService(configService, db, settingsService);

            db.query.mockImplementation(async (sql) => {
                if (sql.includes('FROM "DeckCatalog"')) {
                    throw new Error('relation does not exist');
                }

                return [];
            });

            const status = await service.poolStatus(1, {
                sets: [],
                houses: [],
                strategies: [],
                minSas: null,
                maxSas: null
            });

            expect(status.catalogEmpty).toBe(false);
        });

        it('only asks once, because a catalog never empties', async function () {
            const service = new GauntletService(configService, db, settingsService);

            answer([['FROM "DeckCatalog"', [{ '?column?': 1 }]]]);

            expect(await service.hasCatalogDecks()).toBe(true);
            expect(await service.hasCatalogDecks()).toBe(true);
            expect(
                db.query.mock.calls.filter(([sql]) => sql.includes('FROM "DeckCatalog"'))
            ).toHaveLength(1);
        });
    });

    describe('what the operator can see', function () {
        const healthWith = async ({ catalogEnabled, state, indexed }) => {
            config.catalog = { enabled: catalogEnabled };

            const service = new ChampionsChallengeService(configService, db, settingsService);

            service.policyService.vitals = vi.fn().mockResolvedValue(null);
            service.policyService.strengthCurve = vi.fn().mockResolvedValue([]);
            service.policyService.personaLadder = vi.fn().mockResolvedValue([]);
            service.catalogService.getState = vi.fn().mockResolvedValue(state);

            answer([['COUNT(*)::int AS "Indexed"', [{ Indexed: indexed }]]]);

            return (await service.labHealth()).catalog;
        };

        it('reports the crawl as off, which is the default', async function () {
            const catalog = await healthWith({
                catalogEnabled: false,
                indexed: 0,
                state: { CurrentPage: 0, CaughtUp: false }
            });

            expect(catalog.enabled).toBe(false);
            expect(catalog.indexed).toBe(0);
        });

        it('reports how far the walk has got', async function () {
            const catalog = await healthWith({
                catalogEnabled: true,
                indexed: 4200,
                state: {
                    CurrentPage: 84,
                    CaughtUp: false,
                    LastRunAt: '2026-01-01T00:00:00Z'
                }
            });

            expect(catalog.enabled).toBe(true);
            expect(catalog.indexed).toBe(4200);
            expect(catalog.page).toBe(84);
            expect(catalog.caughtUp).toBe(false);
            expect(catalog.lastRunAt).toBe('2026-01-01T00:00:00Z');
        });

        // A crawl parked by its circuit breaker looks exactly like a crawl
        // nobody turned on, from the outside.
        it('reports a crawl its circuit breaker has parked', async function () {
            const catalog = await healthWith({
                catalogEnabled: true,
                indexed: 10,
                state: {
                    CurrentPage: 2,
                    PausedUntil: '2026-01-01T01:00:00Z',
                    ConsecutiveFailures: 3,
                    LastError: 'Master Vault returned 503'
                }
            });

            expect(catalog.pausedUntil).toBe('2026-01-01T01:00:00Z');
            expect(catalog.failures).toBe(3);
            expect(catalog.lastError).toBe('Master Vault returned 503');
        });

        it('survives the state read failing, like the rest of the panel', async function () {
            config.catalog = { enabled: true };

            const service = new ChampionsChallengeService(configService, db, settingsService);

            service.policyService.vitals = vi.fn().mockResolvedValue(null);
            service.policyService.strengthCurve = vi.fn().mockResolvedValue([]);
            service.policyService.personaLadder = vi.fn().mockResolvedValue([]);
            service.catalogService.getState = vi.fn().mockRejectedValue(new Error('no db'));

            const health = await service.labHealth();

            expect(health.catalog.enabled).toBe(true);
            // Page 1, not 0: Master Vault's pages count from 1, and page 0 is
            // the invalid page this crawl once spent weeks asking for.
            expect(health.catalog.page).toBe(1);
        });
    });

    /**
     * The route is three branches and a call, so it is read rather than driven.
     * What matters is that the two refusals are there and come FIRST - a crawl
     * button that starts walking somebody else's API for a non-admin, or one that
     * quietly turns a deliberately-off setting on, would both be worse than no
     * button.
     */
    describe('the hand-started crawl', function () {
        const source = fs.readFileSync(
            path.join(__dirname, '..', '..', '..', '..', 'server', 'api', 'championschallenge.js'),
            'utf8'
        );
        const route = (() => {
            const start = source.indexOf("'/api/champions-challenge/catalog/crawl'");

            expect(start, 'the crawl route is gone').toBeGreaterThan(-1);

            return source.slice(start, source.indexOf('\n    );', start));
        })();

        it('is admins only', function () {
            expect(route).toContain('permissions.isAdmin');
            expect(route.indexOf('isAdmin')).toBeLessThan(route.indexOf('crawlOnce'));
        });

        it('refuses rather than switching the crawl on itself', function () {
            expect(route).toContain('isEnabled()');
            expect(route).toContain('catalog.enabled');
            expect(route.indexOf('isEnabled()')).toBeLessThan(route.indexOf('crawlOnce'));
        });

        it('is rate limited, because it points at Master Vault', function () {
            expect(route).toContain('crawlLimit');
            expect(source).toContain("name: 'catalog-crawl'");
        });
    });
});
