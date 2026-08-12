const User = require('../../../../server/models/User');
const {
    resolveEntitlements,
    can,
    anonymousEntitlements
} = require('../../../../server/services/membership/entitlements');
const {
    CAPABILITIES,
    ALL_CAPABILITIES
} = require('../../../../server/services/membership/capabilities');
const { TIER_IDS } = require('../../../../server/services/membership/tiers');
const { requireCapability } = require('../../../../server/api/requireCapability');
const {
    filterFields,
    filterDeckStats,
    PLAYER_PREMIUM,
    META_PREMIUM
} = require('../../../../server/api/statsGating');

/**
 * ARCHON (N12): the acceptance test for the membership system, written as the
 * personas the feature has to work for.
 *
 * The two admin personas are the ones that matter most: the requirement is that
 * an administrator can reach every premium feature regardless of Patreon
 * status, tier, database state, or whether they have connected Patreon at all.
 * They are exercised here through the REAL path a request takes - a User model
 * to entitlements to the Express guard - rather than by calling the resolver
 * directly, so a regression anywhere along that chain fails this file.
 */
describe('membership personas', function () {
    const userModel = (permissions = {}, membership = undefined) =>
        new User({
            id: 1,
            username: 'persona',
            settings: {},
            permissions,
            membership
        });

    /** Run the real Express guard and report what it did. */
    const throughGuard = (wireUser, capability) => {
        const middleware = requireCapability(capability);
        const req = { user: wireUser };
        let status = null;
        let body = null;
        let nexted = false;

        const res = {
            status(code) {
                status = code;

                return this;
            },
            send(payload) {
                body = payload;

                return this;
            }
        };

        middleware(req, res, () => {
            nexted = true;
        });

        return { allowed: nexted, status, body };
    };

    const PERSONAS = [
        {
            name: 'logged-out visitor',
            entitlements: () => anonymousEntitlements(),
            expectTier: TIER_IDS.FREE,
            allowed: [],
            denied: [CAPABILITIES.ELO_HISTORY, CAPABILITIES.ARCHON_INTELLIGENCE]
        },
        {
            name: 'free registered user',
            user: () => userModel(),
            expectTier: TIER_IDS.FREE,
            allowed: [],
            denied: [
                CAPABILITIES.ELO_HISTORY,
                CAPABILITIES.ADVANCED_DECK_STATS,
                CAPABILITIES.ARCHON_INTELLIGENCE,
                CAPABILITIES.TOURNAMENT_LAB,
                CAPABILITIES.EXPERIMENTAL_FEATURES
            ]
        },
        {
            name: 'Supporter',
            user: () => userModel({}, { tier: TIER_IDS.SUPPORTER, status: 'active' }),
            expectTier: TIER_IDS.SUPPORTER,
            allowed: [
                CAPABILITIES.ELO_HISTORY,
                CAPABILITIES.ADVANCED_PLAYER_STATS,
                CAPABILITIES.ADVANCED_DECK_STATS,
                CAPABILITIES.SUPPORTER_BADGE
            ],
            denied: [
                CAPABILITIES.ARCHON_INTELLIGENCE,
                CAPABILITIES.TOURNAMENT_LAB,
                CAPABILITIES.META_ANALYTICS,
                CAPABILITIES.EXPERIMENTAL_FEATURES
            ]
        },
        {
            name: 'Archon',
            user: () => userModel({}, { tier: TIER_IDS.ARCHON, status: 'active' }),
            expectTier: TIER_IDS.ARCHON,
            allowed: [
                CAPABILITIES.ELO_HISTORY,
                CAPABILITIES.ARCHON_INTELLIGENCE,
                CAPABILITIES.TOURNAMENT_LAB,
                CAPABILITIES.MATCHUP_ANALYTICS,
                CAPABILITIES.ADVANCED_REPLAYS,
                CAPABILITIES.META_ANALYTICS,
                CAPABILITIES.PRIVATE_LEAGUES
            ],
            denied: [
                CAPABILITIES.EXPERIMENTAL_FEATURES,
                CAPABILITIES.BETA_FEATURES,
                CAPABILITIES.ORGANIZER_TOOLS
            ]
        },
        {
            name: 'Vault Master',
            user: () => userModel({}, { tier: TIER_IDS.VAULT_MASTER, status: 'active' }),
            expectTier: TIER_IDS.VAULT_MASTER,
            allowed: ALL_CAPABILITIES,
            denied: []
        },
        {
            name: 'admin with NO Patreon membership',
            user: () => userModel({ isAdmin: true }),
            expectTier: TIER_IDS.VAULT_MASTER,
            allowed: ALL_CAPABILITIES,
            denied: [],
            admin: true
        },
        {
            name: 'admin with arbitrary/incorrect membership data',
            user: () =>
                userModel(
                    { isAdmin: true },
                    {
                        provider: 'nonsense',
                        tier: 'not-a-tier',
                        status: 'cancelled',
                        expiresAt: new Date('1999-01-01T00:00:00Z'),
                        grantedTier: 'also-not-a-tier',
                        grantedUntil: new Date('1999-01-01T00:00:00Z')
                    }
                ),
            expectTier: TIER_IDS.VAULT_MASTER,
            allowed: ALL_CAPABILITIES,
            denied: [],
            admin: true
        }
    ];

    for (const persona of PERSONAS) {
        describe(persona.name, function () {
            const entitlementsFor = () =>
                persona.entitlements
                    ? persona.entitlements()
                    : resolveEntitlements({
                          user: persona.user(),
                          membership: persona.user().membership
                      });

            it(`resolves to the ${persona.expectTier} tier`, function () {
                expect(entitlementsFor().tierId).toBe(persona.expectTier);
            });

            if (persona.allowed.length) {
                it('has the capabilities its tier grants', function () {
                    const entitlements = entitlementsFor();

                    for (const capability of persona.allowed) {
                        expect(
                            can(entitlements, capability),
                            `${persona.name} should have ${capability}`
                        ).toBe(true);
                    }
                });
            }

            if (persona.denied.length) {
                it('does not have capabilities above its tier', function () {
                    const entitlements = entitlementsFor();

                    for (const capability of persona.denied) {
                        expect(
                            can(entitlements, capability),
                            `${persona.name} should NOT have ${capability}`
                        ).toBe(false);
                    }
                });
            }

            if (persona.user) {
                it('is allowed or refused correctly by the Express guard', function () {
                    // Through getWireSafeDetails, which is what actually lands
                    // in the JWT and therefore on req.user.
                    const wire = persona.user().getWireSafeDetails();

                    for (const capability of persona.allowed) {
                        expect(
                            throughGuard(wire, capability).allowed,
                            `guard should allow ${capability}`
                        ).toBe(true);
                    }

                    for (const capability of persona.denied) {
                        const result = throughGuard(wire, capability);

                        expect(result.allowed, `guard should refuse ${capability}`).toBe(false);
                        expect(result.status).toBe(403);
                        // The client needs to know WHICH capability was missing
                        // to show the right upgrade prompt.
                        expect(result.body.capability).toBe(capability);
                        expect(result.body.upgradeRequired).toBe(true);
                    }
                });
            }
        });
    }

    // ---- The requirement, stated once more on its own ----------------------

    describe('the admin guarantee', function () {
        const ADMIN_SHAPES = {
            'no membership row': undefined,
            'null membership': null,
            'free tier': { tier: TIER_IDS.FREE, status: 'active' },
            'expired Archon': {
                tier: TIER_IDS.ARCHON,
                status: 'expired',
                expiresAt: new Date('2000-01-01')
            },
            'cancelled Vault Master': { tier: TIER_IDS.VAULT_MASTER, status: 'cancelled' },
            'corrupt tier string': { tier: '../../etc/passwd', status: 'active' },
            'numeric tier': { tier: 42, status: 'active' },
            'empty object': {}
        };

        for (const [shape, membership] of Object.entries(ADMIN_SHAPES)) {
            it(`grants EVERY capability to an admin with ${shape}`, function () {
                const wire = userModel({ isAdmin: true }, membership).getWireSafeDetails();

                expect(wire.membership.isAdmin).toBe(true);
                expect(wire.capabilities.sort()).toEqual([...ALL_CAPABILITIES].sort());

                // And through the real guard, for every capability that exists.
                for (const capability of ALL_CAPABILITIES) {
                    expect(
                        throughGuard(wire, capability).allowed,
                        `admin denied ${capability} with ${shape}`
                    ).toBe(true);
                }
            });
        }

        it('needs no Patreon connection whatsoever', function () {
            const wire = userModel({ isAdmin: true }).getWireSafeDetails();

            expect(wire.capabilities).toHaveLength(ALL_CAPABILITIES.length);
            expect(wire.membership.source).toBe('admin');
        });

        it('survives premium payload filtering with everything intact', function () {
            // The stats routes strip premium fields for non-members; an admin
            // must keep all of them.
            const entitlements = resolveEntitlements({ user: userModel({ isAdmin: true }) });
            const playerStats = { overall: {}, formats: [1], houses: [2] };
            const { stats, locked } = filterFields(playerStats, PLAYER_PREMIUM, entitlements);

            expect(stats.formats).toBeDefined();
            expect(stats.houses).toBeDefined();
            expect(locked).toEqual([]);
        });
    });

    // ---- Payload gating keeps the free tier's promise ----------------------

    describe('stats payload filtering', function () {
        const freeEntitlements = () => resolveEntitlements({ user: userModel() });

        it('never strips the free overall record and Elo', function () {
            const { stats } = filterFields(
                { overall: { wins: 3, losses: 1, rating: 1200 }, formats: [], houses: [] },
                PLAYER_PREMIUM,
                freeEntitlements()
            );

            expect(stats.overall).toEqual({ wins: 3, losses: 1, rating: 1200 });
        });

        it('strips advanced player breakdowns for a free account and says which', function () {
            const { stats, locked } = filterFields(
                { overall: {}, formats: [1], houses: [2] },
                PLAYER_PREMIUM,
                freeEntitlements()
            );

            expect(stats.formats).toBeUndefined();
            expect(stats.houses).toBeUndefined();
            expect(locked.sort()).toEqual(['formats', 'houses']);
        });

        it('strips the expensive meta matrix for a free account', function () {
            const { stats, locked } = filterFields(
                { totals: {}, houseMatchups: {}, sasBands: [], sets: [] },
                META_PREMIUM,
                freeEntitlements()
            );

            expect(stats.totals).toBeDefined();
            expect(stats.houseMatchups).toBeUndefined();
            expect(locked).toContain('houseMatchups');
        });

        it('keeps the meta matrix for an Archon member', function () {
            const entitlements = resolveEntitlements({
                user: userModel({}, { tier: TIER_IDS.ARCHON, status: 'active' }),
                membership: { tier: TIER_IDS.ARCHON, status: 'active' }
            });
            const { stats, locked } = filterFields(
                { houseMatchups: { houses: [] } },
                META_PREMIUM,
                entitlements
            );

            expect(stats.houseMatchups).toBeDefined();
            expect(locked).toEqual([]);
        });

        it('strips premium per-deck columns but keeps the deck list itself', function () {
            // "Basic deck information" is free; the expected-win-rate columns
            // are not.
            const { stats, locked } = filterDeckStats(
                {
                    decks: [
                        { name: 'A', wins: 2, losses: 1, expectedWinRate: 55, sasDelta: 3 },
                        { name: 'B', wins: 0, losses: 4, expectedWinRate: 40, sasDelta: -9 }
                    ],
                    bestDeck: { name: 'A' },
                    matchups: []
                },
                freeEntitlements()
            );

            expect(stats.decks).toHaveLength(2);
            expect(stats.decks[0].name).toBe('A');
            expect(stats.decks[0].wins).toBe(2);
            expect(stats.decks[0].expectedWinRate).toBeUndefined();
            expect(stats.decks[0].sasDelta).toBeUndefined();
            expect(stats.bestDeck).toBeUndefined();
            expect(locked).toContain('expectedWinRate');
        });
    });
});

/**
 * ARCHON (N12): the filter must not mutate what it was handed.
 *
 * StatisticsService memoises its payloads (`cached(key, producer)`), so every
 * caller gets the SAME object. If the premium filter stripped fields in place,
 * the first free request would permanently remove them from the cache and every
 * paying member - and every admin - would silently lose those panels until the
 * TTL expired. It would look like an intermittent product bug, not a bug here.
 */
describe('premium filtering does not corrupt the shared stats cache', function () {
    const {
        resolveEntitlements: resolve
    } = require('../../../../server/services/membership/entitlements');
    const User = require('../../../../server/models/User');

    const freeUser = () => new User({ id: 9, username: 'free', settings: {}, permissions: {} });

    it("leaves the caller's object untouched when stripping player stats", function () {
        const cached = { overall: { wins: 1 }, formats: ['a'], houses: ['b'] };

        filterFields(cached, PLAYER_PREMIUM, resolve({ user: freeUser() }));

        expect(cached.formats).toEqual(['a']);
        expect(cached.houses).toEqual(['b']);
    });

    it('leaves the cached deck rows untouched when stripping premium columns', function () {
        const cached = {
            decks: [{ name: 'A', wins: 1, expectedWinRate: 55, sasDelta: 3 }],
            bestDeck: { name: 'A' }
        };

        filterDeckStats(cached, resolve({ user: freeUser() }));

        // The nested row objects are the ones most easily mutated by accident.
        expect(cached.decks[0].expectedWinRate).toBe(55);
        expect(cached.decks[0].sasDelta).toBe(3);
        expect(cached.bestDeck).toEqual({ name: 'A' });
    });

    it('still serves the full payload to an admin after a free request filtered it', function () {
        const cached = { overall: {}, formats: ['a'], houses: ['b'] };
        const admin = new User({
            id: 1,
            username: 'a',
            settings: {},
            permissions: { isAdmin: true }
        });

        filterFields(cached, PLAYER_PREMIUM, resolve({ user: freeUser() }));
        const { stats } = filterFields(cached, PLAYER_PREMIUM, resolve({ user: admin }));

        expect(stats.formats).toEqual(['a']);
        expect(stats.houses).toEqual(['b']);
    });
});
