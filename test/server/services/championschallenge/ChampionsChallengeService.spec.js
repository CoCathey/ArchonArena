const ChampionsChallengeService = require('../../../../server/services/championschallenge/ChampionsChallengeService');
const { MIN_CONFIDENT_GAMES } = require('../../../../server/services/championschallenge/labMath');

// The service against a mocked db, dispatching on SQL substrings the way the
// catalog and deck-import specs do. What is being pinned:
//
//  - enrollment refuses everything the sweep could not actually play, with
//    the message a player will read;
//  - the sweep respects the switch, the daily budget, and the entitlement,
//    and records a finished game faithfully;
//  - NOTHING here ever touches "Games", "GamePlayers" or "RatingHistory" -
//    the property the whole feature stands on;
//  - the report's arithmetic on a known set of games, end to end.

const USER = 42;

const defaultConfig = {
    enabled: true,
    sweepIntervalSeconds: 60,
    gamesPerSweep: 2,
    gamesPerDeckPerDay: 12,
    maxEnrolledPerUser: 8,
    maxTurnsPerGame: 80
};

describe('ChampionsChallengeService', function () {
    let db;
    let service;
    let config;

    const configService = { getValue: () => ({}) };
    const settingsService = {
        getSectionWithDefaults: (name) => (name === 'championsChallenge' ? { ...config } : {}),
        getSection: () => ({})
    };

    /**
     * A db mock whose answer depends on the query text. `handlers` is an
     * array of [substring, rows-or-fn] pairs, first match wins.
     */
    const answer = (handlers) =>
        db.query.mockImplementation(async (sql, params) => {
            for (const [fragment, rows] of handlers) {
                if (sql.includes(fragment)) {
                    return typeof rows === 'function' ? rows(sql, params) : rows;
                }
            }

            return [];
        });

    const queriesMatching = (fragment) =>
        db.query.mock.calls.filter(([sql]) => sql.includes(fragment));

    // Two real cards per house keep loadEngineDeck honest against the real
    // pack index without building a full deck.
    const deckCardRows = [
        { CardId: 'anger', Count: 12, House: null, IsNonDeck: false },
        { CardId: 'hand-of-dis', Count: 12, House: null, IsNonDeck: false },
        { CardId: 'foggify', Count: 12, House: null, IsNonDeck: false }
    ];
    const deckHouseRows = [{ Code: 'brobnar' }, { Code: 'dis' }, { Code: 'logos' }];

    beforeEach(function () {
        config = { ...defaultConfig };
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new ChampionsChallengeService(configService, db, settingsService);
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    describe('enrollDeck', function () {
        const ownDeck = {
            Id: 7,
            UserId: USER,
            Name: 'Mine',
            Banned: false,
            SasRating: 70
        };

        const enrollAnswers = (deck, { enrolledCount = 0 } = {}) =>
            answer([
                ['COUNT(*)::int AS "Count"', [{ Count: enrolledCount }]],
                ['LEFT JOIN "DeckSas"', deck ? [deck] : []],
                ['FROM "DeckCards"', deckCardRows],
                ['FROM "DeckHouses"', deckHouseRows],
                ['FROM "Decks" d WHERE d."Id"', [{ Id: 7, Name: 'Mine', Uuid: 'u-7' }]]
            ]);

        it('enrolls an owned, rated, simulatable deck exactly once', async function () {
            enrollAnswers(ownDeck);

            await service.enrollDeck(USER, 7);

            const [insert] = queriesMatching('INSERT INTO "ProvingGroundsDecks"');

            expect(insert[0]).toContain('ON CONFLICT');
            expect(insert[1]).toEqual([USER, 7]);
        });

        it('refuses a full roster by naming the limit', async function () {
            enrollAnswers(ownDeck, { enrolledCount: 8 });

            await expect(service.enrollDeck(USER, 7)).rejects.toThrow(
                /8 Champion’s Challenge slots/
            );
        });

        it("refuses another player's deck", async function () {
            enrollAnswers({ ...ownDeck, UserId: USER + 1 });

            await expect(service.enrollDeck(USER, 7)).rejects.toThrow('Not your deck.');
        });

        it('refuses a banned deck', async function () {
            enrollAnswers({ ...ownDeck, Banned: true });

            await expect(service.enrollDeck(USER, 7)).rejects.toThrow(/banned/);
        });

        it('refuses a deck with no SAS, and says why it needs one', async function () {
            enrollAnswers({ ...ownDeck, SasRating: null });

            await expect(service.enrollDeck(USER, 7)).rejects.toThrow(/no SAS rating/);
        });

        it('refuses a deck whose cards the simulation data does not cover', async function () {
            enrollAnswers(ownDeck);
            answer([
                ['COUNT(*)::int AS "Count"', [{ Count: 0 }]],
                ['LEFT JOIN "DeckSas"', [ownDeck]],
                [
                    'FROM "DeckCards"',
                    [{ CardId: 'a-card-from-a-set-we-do-not-have', Count: 36, IsNonDeck: false }]
                ],
                ['FROM "DeckHouses"', deckHouseRows],
                ['FROM "Decks" d WHERE d."Id"', [{ Id: 7, Name: 'Mine', Uuid: 'u-7' }]]
            ]);

            await expect(service.enrollDeck(USER, 7)).rejects.toThrow(/cannot play that deck/);
        });
    });

    describe('runSweep', function () {
        const sweepAnswers = ({ enrollments, today = [], membership } = {}) =>
            answer([
                ['SELECT "UserId", "DeckId" FROM "ProvingGroundsDecks"', enrollments],
                ["date_trunc('day'", today],
                ['FROM "UserRoles"', [{ IsAdmin: false }]],
                ['FROM "Memberships"', membership ? [membership] : []],
                ['FROM "DeckCards"', deckCardRows],
                ['FROM "DeckHouses"', deckHouseRows],
                [
                    'FROM "Decks" d WHERE d."Id"',
                    (sql, params) => [{ Id: params[0], Name: `Deck ${params[0]}`, Uuid: 'u' }]
                ]
            ]);

        const vaultMasterRow = {
            UserId: USER,
            Tier: 'vault_master',
            Status: 'active',
            ExpiresAt: null
        };

        const fakeResult = (winnerId, loserId) => ({
            completed: true,
            winnerDeck: { dbId: winnerId },
            loserDeck: { dbId: loserId },
            winnerKeys: 3,
            loserKeys: 1,
            turns: 21,
            winnerWentFirst: true,
            winnerFirstHouse: 'brobnar',
            loserFirstHouse: 'dis',
            winnerHouseCalls: { brobnar: 5 },
            loserHouseCalls: { dis: 4 },
            durationMs: 500
        });

        it('does nothing while the lab is switched off', async function () {
            config.enabled = false;
            service.runMatch = vi.fn();

            const result = await service.runSweep();

            expect(result.played).toBe(0);
            expect(db.query).not.toHaveBeenCalled();
        });

        it('plays a pair from an entitled roster and records it faithfully', async function () {
            sweepAnswers({
                enrollments: [
                    { UserId: USER, DeckId: 1 },
                    { UserId: USER, DeckId: 2 }
                ],
                membership: vaultMasterRow
            });
            config.gamesPerSweep = 1;
            service.runMatch = vi.fn().mockResolvedValue(fakeResult(1, 2));

            const result = await service.runSweep();

            expect(result.played).toBe(1);
            expect(service.runMatch).toHaveBeenCalledTimes(1);
            // The engine decks carry their db ids so results can be recorded.
            expect(service.runMatch.mock.calls[0][0].dbId).toBeDefined();

            // ARCHON (N21): sparring games are seeded (replayable), explore
            // at a softmax temperature, and log their decisions for training.
            const options = service.runMatch.mock.calls[0][2];

            expect(options.maxTurns).toBe(80);
            expect(Number.isFinite(options.seed)).toBe(true);
            expect(options.temperature).toBeGreaterThan(0);
            expect(options.recordDecisions).toBe(true);

            const [insert] = queriesMatching('INSERT INTO "ProvingGroundsGames"');
            const params = insert[1];

            // UserId, winner, loser, keys, turns, first-player and the house
            // record all make it to the row.
            expect(params.slice(0, 7)).toEqual([USER, 1, 2, 3, 1, 21, true]);
            expect(params[7]).toBe('brobnar');
            expect(JSON.parse(params[9])).toEqual({ brobnar: 5 });
        });

        it('skips a roster whose owner no longer holds the capability', async function () {
            sweepAnswers({
                enrollments: [
                    { UserId: USER, DeckId: 1 },
                    { UserId: USER, DeckId: 2 }
                ],
                // Archon is one tier short of the Champion’s Challenge.
                membership: { ...vaultMasterRow, Tier: 'archon' }
            });
            service.runMatch = vi.fn();

            const result = await service.runSweep();

            expect(result.played).toBe(0);
            expect(service.runMatch).not.toHaveBeenCalled();
        });

        it('exempts a site admin’s decks from the daily budget', async function () {
            answer([
                [
                    'SELECT "UserId", "DeckId" FROM "ProvingGroundsDecks"',
                    [
                        { UserId: USER, DeckId: 1 },
                        { UserId: USER, DeckId: 2 }
                    ]
                ],
                [
                    "date_trunc('day'",
                    [
                        { DeckId: 1, GamesToday: 999 },
                        { DeckId: 2, GamesToday: 999 }
                    ]
                ],
                // The admin override needs no membership row at all.
                ['FROM "UserRoles"', [{ IsAdmin: true }]],
                ['FROM "Memberships"', []],
                ['FROM "DeckCards"', deckCardRows],
                ['FROM "DeckHouses"', deckHouseRows],
                [
                    'FROM "Decks" d WHERE d."Id"',
                    (sql, params) => [{ Id: params[0], Name: `Deck ${params[0]}`, Uuid: 'u' }]
                ]
            ]);
            config.gamesPerSweep = 1;
            service.runMatch = vi.fn().mockResolvedValue(fakeResult(1, 2));

            const result = await service.runSweep();

            expect(result.played).toBe(1);
        });

        it('rotates a random slot that has served its games', async function () {
            sweepAnswers({
                enrollments: [
                    { UserId: USER, DeckId: 1 },
                    { UserId: USER, DeckId: 2 }
                ],
                membership: vaultMasterRow
            });
            config.gamesPerSweep = 1;
            service.runMatch = vi.fn().mockResolvedValue(fakeResult(1, 2));

            // Layer the randomizer's queries onto the sweep's: deck 1 is a
            // random slot at its target, and deck 9 is the fresh draw.
            const base = db.query.getMockImplementation();

            db.query.mockImplementation(async (sql, params) => {
                if (sql.includes('e."Random" = true')) {
                    return [
                        {
                            DeckId: 1,
                            RandomGamesTarget: 20,
                            EnrolledAt: new Date(),
                            PlayedSince: 20
                        }
                    ];
                }

                if (sql.includes('ORDER BY random()')) {
                    return [{ Id: 9 }];
                }

                return base(sql, params);
            });

            const result = await service.runSweep();

            expect(result.played).toBe(1);

            // The served slot was withdrawn...
            const withdrawals = queriesMatching('DELETE FROM "ProvingGroundsDecks"');

            expect(withdrawals.some(([, deleteParams]) => deleteParams[1] === 1)).toBe(true);

            // ...and its successor enrolled as a random slot with the same target.
            const enrolls = queriesMatching('"Random", "RandomGamesTarget"');

            expect(
                enrolls.some(([, insertParams]) => insertParams[1] === 9 && insertParams[2] === 20)
            ).toBe(true);
        });

        it('respects the per-deck daily budget', async function () {
            sweepAnswers({
                enrollments: [
                    { UserId: USER, DeckId: 1 },
                    { UserId: USER, DeckId: 2 }
                ],
                today: [
                    { DeckId: 1, GamesToday: 12 },
                    { DeckId: 2, GamesToday: 12 }
                ],
                membership: vaultMasterRow
            });
            service.runMatch = vi.fn();

            const result = await service.runSweep();

            expect(result.played).toBe(0);
            expect(service.runMatch).not.toHaveBeenCalled();
        });

        it('records nothing for an abandoned game', async function () {
            sweepAnswers({
                enrollments: [
                    { UserId: USER, DeckId: 1 },
                    { UserId: USER, DeckId: 2 }
                ],
                membership: vaultMasterRow
            });
            service.runMatch = vi.fn().mockResolvedValue({ completed: false, reason: 'turn-cap' });

            const result = await service.runSweep();

            expect(result.played).toBe(0);
            expect(result.abandoned).toBe(1);
            expect(queriesMatching('INSERT INTO "ProvingGroundsGames"')).toEqual([]);
        });

        it('keeps playing until the batch budget is spent, round-robin', async function () {
            sweepAnswers({
                enrollments: [
                    { UserId: USER, DeckId: 1 },
                    { UserId: USER, DeckId: 2 }
                ],
                membership: vaultMasterRow
            });
            config.gamesPerSweep = 3;
            service.runMatch = vi.fn().mockResolvedValue(fakeResult(1, 2));

            const result = await service.runSweep();

            expect(result.played).toBe(3);
        });

        it('never touches the official games, players or rating tables', async function () {
            sweepAnswers({
                enrollments: [
                    { UserId: USER, DeckId: 1 },
                    { UserId: USER, DeckId: 2 }
                ],
                membership: vaultMasterRow
            });
            service.runMatch = vi.fn().mockResolvedValue(fakeResult(1, 2));

            await service.runSweep();
            await service.getLabReport(USER);

            // The quoted-identifier check: "ProvingGroundsGames" must not
            // count as "Games".
            const official = /"(Games|GamePlayers|RatingHistory)"/;

            for (const [sql] of db.query.mock.calls) {
                expect(sql).not.toMatch(official);
            }
        });
    });

    describe('getLabReport', function () {
        // Deck 1 ('Gem', SAS 70) beats deck 2 ('Big', SAS 80) 18 of 24 games:
        // SAS expected it to win ~44% of these, so deck 1 is a hidden gem and
        // deck 2 is underperforming.
        const gameRow = (index, winnerId, loserId) => ({
            Id: index,
            UserId: USER,
            WinnerDeckId: winnerId,
            LoserDeckId: loserId,
            WinnerKeys: 3,
            LoserKeys: 1,
            Turns: 20,
            WinnerWentFirst: index % 2 === 0,
            WinnerFirstHouse: 'brobnar',
            LoserFirstHouse: 'sanctum',
            WinnerHouseCalls: { brobnar: 5 },
            LoserHouseCalls: { sanctum: 4 },
            DurationMs: 500,
            FinishedAt: new Date()
        });

        const games = [
            ...Array.from({ length: 18 }, (_, index) => gameRow(index, 1, 2)),
            ...Array.from({ length: 6 }, (_, index) => gameRow(18 + index, 2, 1))
        ];

        // The candidates query's NOT EXISTS subquery also mentions
        // "ProvingGroundsDecks", so it must be dispatched on first; likewise
        // the ARI read joins DeckSas, so it must be matched before the plain
        // DeckSas fallback.
        const reportAnswers = () =>
            answer([
                ['AND NOT EXISTS', [{ Id: 9, Name: 'Bench', SasRating: 64 }]],
                [
                    'FROM "ProvingGroundsDecks" e',
                    [
                        {
                            DeckId: 1,
                            EnrolledAt: new Date(),
                            Name: 'Gem',
                            Uuid: 'u-1',
                            SasRating: 70
                        },
                        {
                            DeckId: 2,
                            EnrolledAt: new Date(),
                            Name: 'Big',
                            Uuid: 'u-2',
                            SasRating: 80
                        }
                    ]
                ],
                ['FROM "ProvingGroundsGames" WHERE "UserId"', games],
                [
                    'LEFT JOIN "DeckAri"',
                    [
                        // The gem's ARI has been climbing with its sparring
                        // wins; Big has never been adjusted and reads as its
                        // SAS/AERC seed.
                        {
                            Uuid: 'u-1',
                            SasRating: 70,
                            AercScore: 70,
                            Ari: 78.4,
                            RatedGames: 0,
                            SimGames: 24
                        },
                        {
                            Uuid: 'u-2',
                            SasRating: 80,
                            AercScore: 80,
                            Ari: null,
                            RatedGames: 0,
                            SimGames: 24
                        }
                    ]
                ]
            ]);

        it('aggregates a roster end to end', async function () {
            reportAnswers();

            const report = await service.getLabReport(USER);

            expect(report.running).toBe(true);
            expect(report.maxEnrolled).toBe(8);
            expect(report.minConfidentGames).toBe(MIN_CONFIDENT_GAMES);
            expect(report.totals).toEqual({ games: 24, today: 24 });
            expect(report.candidates).toEqual([{ deckId: 9, name: 'Bench', sas: 64 }]);

            const gem = report.decks.find((deck) => deck.deckId === 1);
            const big = report.decks.find((deck) => deck.deckId === 2);

            expect(gem.games).toBe(24);
            expect(gem.wins).toBe(18);
            expect(gem.winRate).toBeCloseTo(0.75, 10);
            // Expected from the site's own model: SAS 70 vs 80.
            expect(gem.expectedWinRate).toBeGreaterThan(0.4);
            expect(gem.expectedWinRate).toBeLessThan(0.5);
            expect(gem.delta).toBeCloseTo(gem.winRate - gem.expectedWinRate, 10);
            expect(gem.confident).toBe(true);
            expect(gem.hiddenGem).toBe(true);
            // Performance against an SAS-80 field at 75% reads well above the
            // deck's own 70.
            // The deck's ARI is the stored, game-adjusted index; how much of
            // its evidence was sparring rides along.
            expect(gem.ari).toBe(78.4);
            expect(gem.ariSimGames).toBe(24);
            expect(gem.avgTurns).toBeCloseTo(20, 5);
            expect(gem.avgKeysFor).toBeCloseTo((18 * 3 + 6 * 1) / 24, 5);

            expect(big.wins).toBe(6);
            expect(big.hiddenGem).toBe(false);
            expect(big.delta).toBeLessThan(0);
            // Never adjusted: Big's ARI is its SAS/AERC seed.
            expect(big.ari).toBe(80);

            // Gems sort first, and the findings lead with the gem sentence.
            expect(report.decks[0].deckId).toBe(1);
            expect(report.findings[0].text).toContain('hidden gem');
            expect(report.findings[0].text).toContain('Gem');
        });

        it('tracks openings per deck from each side of the result', async function () {
            reportAnswers();

            const report = await service.getLabReport(USER);
            const gem = report.decks.find((deck) => deck.deckId === 1);

            // Deck 1 opened brobnar in its 18 wins and sanctum in its 6
            // losses - both openings are visible with their real records.
            const brobnar = gem.openings.find((opening) => opening.house === 'brobnar');
            const sanctum = gem.openings.find((opening) => opening.house === 'sanctum');

            expect(brobnar.games).toBe(18);
            expect(brobnar.winRate).toBe(1);
            expect(sanctum.games).toBe(6);
            expect(sanctum.winRate).toBe(0);
            expect(gem.bestOpening.house).toBe('brobnar');
        });
    });

    describe('userMayUseLab', function () {
        it('admits a Vault Master membership', async function () {
            answer([
                ['FROM "UserRoles"', [{ IsAdmin: false }]],
                [
                    'FROM "Memberships"',
                    [{ UserId: USER, Tier: 'vault_master', Status: 'active', ExpiresAt: null }]
                ]
            ]);

            expect(await service.userMayUseLab(USER)).toBe(true);
        });

        it('refuses Archon - the lab is a Vault Master feature', async function () {
            answer([
                ['FROM "UserRoles"', [{ IsAdmin: false }]],
                [
                    'FROM "Memberships"',
                    [{ UserId: USER, Tier: 'archon', Status: 'active', ExpiresAt: null }]
                ]
            ]);

            expect(await service.userMayUseLab(USER)).toBe(false);
        });

        it('refuses a lapsed Vault Master - play stops when the pledge does', async function () {
            answer([
                ['FROM "UserRoles"', [{ IsAdmin: false }]],
                [
                    'FROM "Memberships"',
                    [
                        {
                            UserId: USER,
                            Tier: 'vault_master',
                            Status: 'active',
                            ExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000)
                        }
                    ]
                ]
            ]);

            expect(await service.userMayUseLab(USER)).toBe(false);
        });

        it('admits an admin with no membership row at all', async function () {
            answer([
                ['FROM "UserRoles"', [{ IsAdmin: true }]],
                ['FROM "Memberships"', []]
            ]);

            expect(await service.userMayUseLab(USER)).toBe(true);
        });
    });
});
