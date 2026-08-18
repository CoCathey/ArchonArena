const ChampionsChallengeService = require('../../../../server/services/championschallenge/ChampionsChallengeService');
const { MIN_CONFIDENT_GAMES } = require('../../../../server/services/championschallenge/labMath');
const { PLAYER_ONE } = require('../../../../server/services/championschallenge/SimulatedGame');

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

        // ARCHON (N24): the Gauntlet's path through the sweep. The service's own
        // job here is narrow - decide field-or-mirror, seat the member's deck as
        // alpha, hand the result to GauntletService - so the collaborator is
        // stubbed and what is pinned is the wiring.
        describe('the Gauntlet', function () {
            const fieldOn = (overrides = {}) => ({
                enabled: true,
                fieldSharePct: 100,
                sets: [],
                houses: [],
                strategies: [],
                minSas: null,
                maxSas: null,
                ...overrides
            });

            const stubGauntlet = (settings, opponent) => {
                service.gauntletService.settingsFor = vi.fn().mockResolvedValue(settings);
                service.gauntletService.drawOpponent = vi.fn().mockResolvedValue(opponent);
                service.gauntletService.recordGame = vi.fn().mockResolvedValue(undefined);
                service.gauntletService.noteOpponentPlayed = vi.fn().mockResolvedValue(undefined);
                service.gauntletService.anyoneWantsField = vi.fn().mockResolvedValue(false);
            };

            const opponentDeck = {
                uuid: 'stranger-uuid',
                name: 'Stranger’s Deck',
                sas: 75,
                deck: { name: 'Stranger’s Deck', uuid: 'stranger-uuid', houses: ['a', 'b', 'c'] }
            };

            it('plays a member’s deck against a drawn foreign deck', async function () {
                sweepAnswers({
                    enrollments: [{ UserId: USER, DeckId: 1 }],
                    membership: vaultMasterRow
                });
                config.gamesPerSweep = 1;
                stubGauntlet(fieldOn(), opponentDeck);
                service.runMatch = vi.fn().mockResolvedValue({
                    ...fakeResult(1, 0),
                    // The member's deck holds the alpha seat, which is what
                    // makes this mean "mine won".
                    winner: PLAYER_ONE,
                    winnerDeck: { dbId: 1, uuid: 'u' },
                    loserDeck: { uuid: 'stranger-uuid' }
                });

                const result = await service.runSweep();

                expect(result.played).toBe(1);

                const [, decks] = service.runMatch.mock.calls[0];

                expect(service.runMatch.mock.calls[0][1]).toBe(opponentDeck.deck);
                expect(decks).toBeDefined();
                expect(service.gauntletService.recordGame).toHaveBeenCalledWith(
                    expect.objectContaining({ userId: USER, deckId: 1, won: true })
                );
                expect(service.gauntletService.noteOpponentPlayed).toHaveBeenCalledWith(
                    'stranger-uuid'
                );
                // A field result is never written to the mirror table.
                expect(queriesMatching('INSERT INTO "ProvingGroundsGames"')).toHaveLength(0);
            });

            // A one-deck roster cannot spar with itself; the field gives it games.
            it('gives a single-deck roster a game', async function () {
                sweepAnswers({
                    enrollments: [{ UserId: USER, DeckId: 1 }],
                    membership: vaultMasterRow
                });
                config.gamesPerSweep = 1;
                stubGauntlet(fieldOn(), opponentDeck);
                service.runMatch = vi.fn().mockResolvedValue({
                    ...fakeResult(1, 0),
                    winner: PLAYER_ONE,
                    winnerDeck: { dbId: 1, uuid: 'u' },
                    loserDeck: { uuid: 'stranger-uuid' }
                });

                expect((await service.runSweep()).played).toBe(1);
            });

            it('falls back to a mirror game when the pool has no match', async function () {
                sweepAnswers({
                    enrollments: [
                        { UserId: USER, DeckId: 1 },
                        { UserId: USER, DeckId: 2 }
                    ],
                    membership: vaultMasterRow
                });
                config.gamesPerSweep = 1;
                stubGauntlet(fieldOn(), null);
                service.runMatch = vi.fn().mockResolvedValue(fakeResult(1, 2));

                const result = await service.runSweep();

                expect(result.played).toBe(1);
                // The member's tick was spent on a mirror game, not on nothing.
                expect(queriesMatching('INSERT INTO "ProvingGroundsGames"')).toHaveLength(1);
                expect(service.gauntletService.recordGame).not.toHaveBeenCalled();
            });

            it('leaves the field alone when the member has not asked for it', async function () {
                sweepAnswers({
                    enrollments: [
                        { UserId: USER, DeckId: 1 },
                        { UserId: USER, DeckId: 2 }
                    ],
                    membership: vaultMasterRow
                });
                config.gamesPerSweep = 1;
                stubGauntlet(fieldOn({ enabled: false }), opponentDeck);
                service.runMatch = vi.fn().mockResolvedValue(fakeResult(1, 2));

                await service.runSweep();

                expect(service.gauntletService.drawOpponent).not.toHaveBeenCalled();
            });

            it('counts field games against the same daily budget', async function () {
                sweepAnswers({
                    enrollments: [{ UserId: USER, DeckId: 1 }],
                    membership: vaultMasterRow
                });
                config.gamesPerSweep = 1;
                stubGauntlet(fieldOn(), opponentDeck);
                service.runMatch = vi.fn();

                // 12 field games today (the cap), no mirror games: the deck rests.
                const base = db.query.getMockImplementation();

                db.query.mockImplementation(async (sql, params) => {
                    if (sql.includes('FROM "GauntletGames"') && sql.includes("date_trunc('day'")) {
                        return [{ DeckId: 1, GamesToday: 12 }];
                    }

                    return base(sql, params);
                });

                expect((await service.runSweep()).played).toBe(0);
                expect(service.runMatch).not.toHaveBeenCalled();
            });
        });

        /**
         * ARCHON (N25): PAIRED SEEDS.
         *
         * One seed, played twice with the seats swapped, so both brains face the
         * same shuffles and the same first-player advantage - once from each
         * side. A coin flip per game (which is what this was) leaves deck and
         * draw luck in the record, and that noise is most of the reason a title
         * fight used to need hundreds of games to say anything.
         */
        describe('the arena', function () {
            const arenaConfig = () => ({
                ...config,
                maxTurnsPerGame: 80,
                arenaMinGames: 30,
                arenaDecideGames: 400
            });

            const stubFight = (verdicts = ['fighting', 'fighting']) => {
                let call = 0;

                service.policyService.candidate = vi
                    .fn()
                    .mockResolvedValue({ Id: 5, Version: 3, Model: { version: 3 } });
                service.policyService.champion = vi.fn().mockResolvedValue({ version: 2 });
                service.policyService.recordArenaResult = vi
                    .fn()
                    .mockImplementation(async () => verdicts[call++] || 'fighting');
                service.runMatch = vi.fn().mockResolvedValue({
                    completed: true,
                    winner: 'challenger-alpha',
                    winnerDeck: { uuid: 'a' },
                    loserDeck: { uuid: 'b' },
                    winnerKeys: 3,
                    loserKeys: 1,
                    turns: 20,
                    winnerWentFirst: true,
                    durationMs: 100
                });
            };

            it('plays each pairing twice on one seed, seats swapped', async function () {
                stubFight();

                await service.runArenaStep(arenaConfig());

                expect(service.runMatch).toHaveBeenCalledTimes(2);

                const [first, second] = service.runMatch.mock.calls.map(([, , options]) => options);

                // The same future for both halves - that is the whole point.
                expect(first.seed).toBe(second.seed);
                // And the brains change seats between them.
                expect(first.policies.alpha).toBe(second.policies.omega);
                expect(first.policies.omega).toBe(second.policies.alpha);
                // Both halves are scored.
                expect(service.policyService.recordArenaResult).toHaveBeenCalledTimes(2);
            });

            it('scores each half from the candidate’s point of view', async function () {
                stubFight();

                await service.runArenaStep(arenaConfig());

                const [firstResult, secondResult] =
                    service.policyService.recordArenaResult.mock.calls.map(([, won]) => won);

                // Alpha won both games, and the candidate sat in alpha exactly
                // once - so exactly one half is a candidate win.
                expect([firstResult, secondResult].filter(Boolean)).toHaveLength(1);
            });

            it('stops mid-pair when the title changes hands', async function () {
                stubFight(['promoted']);

                await service.runArenaStep(arenaConfig());

                // The second half would be scored against a row that no longer
                // holds the crown it was contesting.
                expect(service.runMatch).toHaveBeenCalledTimes(1);
            });

            it('drops the whole pair when a half cannot be played', async function () {
                stubFight();
                service.runMatch = vi
                    .fn()
                    .mockResolvedValue({ completed: false, reason: 'turn-cap' });

                await service.runArenaStep(arenaConfig());

                // Half a pair is an unpaired game, which is the noise pairing
                // exists to remove.
                expect(service.policyService.recordArenaResult).not.toHaveBeenCalled();
            });

            it('does nothing when no candidate is in training', async function () {
                stubFight();
                service.policyService.candidate = vi.fn().mockResolvedValue(null);

                await service.runArenaStep(arenaConfig());

                expect(service.runMatch).not.toHaveBeenCalled();
            });
        });

        /**
         * ARCHON (N26): the three things the roster's own games were already
         * producing and nothing showed.
         */
        describe('the report’s new sections', function () {
            const enrollments = [
                { DeckId: 1, Name: 'Alpha' },
                { DeckId: 2, Name: 'Beta' },
                { DeckId: 3, Name: 'Gamma' }
            ];

            const game = (winner, loser) => ({ WinnerDeckId: winner, LoserDeckId: loser });

            it('counts each pairing once, from the winner column', function () {
                const matrix = service.matchupMatrix(enrollments, [
                    game(1, 2),
                    game(1, 2),
                    game(2, 1)
                ]);

                // Three games between 1 and 2: 1 won two of them.
                expect(matrix.cells['1|2']).toMatchObject({ wins: 2, games: 3 });
                // The mirror cell is the same three games from the other side -
                // not six games, which is what counting both columns would give.
                expect(matrix.cells['2|1']).toMatchObject({ wins: 1, games: 3 });
            });

            it('leaves a pairing too thin to mean anything unconfident', function () {
                const matrix = service.matchupMatrix(enrollments, [game(1, 2)]);

                expect(matrix.cells['1|2'].confident).toBe(false);
                expect(matrix.cells['1|2'].winRate).toBe(1);
            });

            it('ignores games involving a deck no longer on the roster', function () {
                const matrix = service.matchupMatrix(enrollments, [game(1, 99), game(99, 2)]);

                expect(Object.keys(matrix.cells)).toHaveLength(0);
            });

            it('reads card contribution from the model’s shrunken weights', async function () {
                answer([
                    [
                        'FROM "DeckCards" dc WHERE',
                        [
                            { CardId: 'anger', Count: 2 },
                            { CardId: 'hand-of-dis', Count: 1 },
                            { CardId: 'foggify', Count: 1 }
                        ]
                    ]
                ]);

                const contribution = await service.cardContribution(7, {
                    version: 4,
                    cardWeights: { anger: 1.5, 'hand-of-dis': -1.5, foggify: 2 },
                    // foggify has been seen twice: its weight is nearly all
                    // shrunk away and it must not appear beside the other two.
                    cardCounts: { anger: 500, 'hand-of-dis': 500, foggify: 2 }
                });

                expect(contribution.best[0].cardId).toBe('anger');
                expect(contribution.worst[0].cardId).toBe('hand-of-dis');
                expect(contribution.best.map((entry) => entry.cardId)).not.toContain('foggify');
                expect(contribution.worst.map((entry) => entry.cardId)).not.toContain('foggify');
                // Names come from the real pack index, not the id.
                expect(contribution.best[0].name).toBe('Anger');
            });

            it('says nothing about cards when the bot has never trained', async function () {
                expect(await service.cardContribution(7, null)).toBeNull();
            });

            it('never claims a card is bad on the strength of a handful of games', async function () {
                answer([['FROM "DeckCards" dc WHERE', [{ CardId: 'anger', Count: 1 }]]]);

                // A large raw weight, three observations behind it: nothing to say.
                expect(
                    await service.cardContribution(7, {
                        cardWeights: { anger: 3 },
                        cardCounts: { anger: 3 }
                    })
                ).toBeNull();
            });
        });

        describe('lab health', function () {
            it('reports a stale lease as stale', async function () {
                config.sweepLeaseSeconds = 120;
                answer([
                    [
                        'FROM "ChallengeSweepLease"',
                        [
                            {
                                Owner: 'worker@dead-host:9',
                                // Ten minutes ago, with a two-minute lease.
                                HeartbeatAt: new Date(Date.now() - 600000)
                            }
                        ]
                    ]
                ]);

                const health = await service.labHealth();

                expect(health.lease.owner).toBe('worker@dead-host:9');
                expect(health.lease.stale).toBe(true);
            });

            it('reports a live lease as live', async function () {
                answer([
                    [
                        'FROM "ChallengeSweepLease"',
                        [{ Owner: 'lobby@host:1', HeartbeatAt: new Date() }]
                    ]
                ]);

                expect((await service.labHealth()).lease.stale).toBe(false);
            });

            it('groups what the pool could not play, for the operator', async function () {
                answer([
                    ['GROUP BY "MissingCards"', [{ MissingCards: 'a-card-from-2027', Decks: 12 }]]
                ]);

                const health = await service.labHealth();

                expect(health.gauntlet.unplayable).toEqual([
                    { reason: 'a-card-from-2027', decks: 12 }
                ]);
            });

            it('survives every query failing', async function () {
                db.query.mockRejectedValue(new Error('database on fire'));

                const health = await service.labHealth();

                // A health panel that 500s is worse than no health panel.
                expect(health.lease).toBeNull();
                expect(health.sparring.today).toBe(0);
                expect(health.gauntlet.playable).toBe(0);
            });
        });

        // ARCHON (N25): exploration anneals with the champion's experience.
        describe('exploration', function () {
            it('starts adventurous and settles toward the floor', function () {
                const settings = {
                    explorationTemperature: 0.8,
                    explorationFloor: 0.2,
                    explorationHalfLife: 1000
                };
                const young = service.explorationTemperature(settings, { trainedGames: 0 });
                const middling = service.explorationTemperature(settings, { trainedGames: 1000 });
                const veteran = service.explorationTemperature(settings, { trainedGames: 100000 });

                expect(young).toBeCloseTo(0.8, 6);
                // One half-life in, half the bonus over the floor is gone.
                expect(middling).toBeCloseTo(0.5, 6);
                // Far out, it settles ON the floor and never below it.
                expect(veteran).toBeCloseTo(0.2, 6);
                expect(veteran).toBeGreaterThanOrEqual(0.2);
            });

            it('never reaches zero, so a stale policy can still notice', function () {
                const floor = service.explorationTemperature(
                    { explorationTemperature: 1, explorationFloor: 0.15, explorationHalfLife: 10 },
                    { trainedGames: 10000000 }
                );

                expect(floor).toBeGreaterThan(0);
            });

            it('treats a heuristics-only site as brand new', function () {
                expect(
                    service.explorationTemperature(
                        {
                            explorationTemperature: 0.7,
                            explorationFloor: 0.15,
                            explorationHalfLife: 20000
                        },
                        null
                    )
                ).toBeCloseTo(0.7, 6);
            });
        });

        it('fills several randomizer slots in one call, never the same deck twice', async function () {
            // The draw sees the roster: each enrollment is committed before
            // the next candidate query, so a deck already taken cannot come
            // back. The mock models that with a growing taken-set.
            const taken = new Set();

            answer([
                [
                    'ORDER BY random()',
                    (sql, params) => {
                        const excluded = new Set([...(params[1] || []), ...taken]);

                        return [11, 12, 13, 14]
                            .filter((id) => !excluded.has(id))
                            .map((id) => ({ Id: id }));
                    }
                ],
                ['FROM "DeckCards"', deckCardRows],
                ['FROM "DeckHouses"', deckHouseRows],
                [
                    'FROM "Decks" d WHERE d."Id"',
                    (sql, params) => [{ Id: params[0], Name: `Deck ${params[0]}`, Uuid: 'u' }]
                ],
                [
                    '"Random", "RandomGamesTarget"',
                    (sql, params) => {
                        taken.add(params[1]);

                        return [];
                    }
                ]
            ]);

            const enrolled = await service.enrollRandomDecks(USER, 30, 3);

            expect(enrolled).toEqual([11, 12, 13]);
            expect(new Set(enrolled).size).toBe(3);

            const inserts = queriesMatching('"Random", "RandomGamesTarget"');

            expect(inserts).toHaveLength(3);
            // Every slot carries the requested swap cadence.
            expect(inserts.every(([, params]) => params[2] === 30)).toBe(true);
        });

        it('returns what it could draw when the collection runs dry', async function () {
            const taken = new Set();

            answer([
                [
                    'ORDER BY random()',
                    (sql, params) => {
                        const excluded = new Set([...(params[1] || []), ...taken]);

                        return [21, 22].filter((id) => !excluded.has(id)).map((id) => ({ Id: id }));
                    }
                ],
                ['FROM "DeckCards"', deckCardRows],
                ['FROM "DeckHouses"', deckHouseRows],
                [
                    'FROM "Decks" d WHERE d."Id"',
                    (sql, params) => [{ Id: params[0], Name: `Deck ${params[0]}`, Uuid: 'u' }]
                ],
                [
                    '"Random", "RandomGamesTarget"',
                    (sql, params) => {
                        taken.add(params[1]);

                        return [];
                    }
                ]
            ]);

            // Asked for five, owns two eligible: a partial fill is the answer,
            // not an error.
            expect(await service.enrollRandomDecks(USER, 20, 5)).toEqual([21, 22]);
        });

        it('never fills more slots than the roster holds', async function () {
            answer([['ORDER BY random()', []]]);

            await service.enrollRandomDecks(USER, 20, 999);

            // maxEnrolledPerUser is 8, so the loop cannot run 999 times.
            expect(queriesMatching('ORDER BY random()').length).toBeLessThanOrEqual(
                config.maxEnrolledPerUser
            );
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

        /**
         * ARCHON: the member's chosen strategies and the menu of them are two
         * different lists, and they used to share one name.
         *
         * `getLabReport` spread the member's settings (whose `strategies` is
         * their choice: ['amber']) and then set `strategies` to the CATALOGUE,
         * silently overwriting it. The panel read that as the selection, so a
         * saved strategy never showed as chosen - and saving any other setting
         * posted the catalogue back as the choice, where the server dropped every
         * entry as unrecognised and the member's filter was wiped.
         */
        it('sends the member’s chosen strategies and the menu under separate names', async function () {
            reportAnswers();
            service.gauntletService.settingsFor = vi.fn().mockResolvedValue({
                enabled: true,
                fieldSharePct: 50,
                sets: [],
                houses: [],
                strategies: ['amber'],
                minSas: null,
                maxSas: null
            });

            const report = await service.getLabReport(USER);

            // The choice, as keys - which is what the save endpoint accepts back.
            expect(report.gauntlet.strategies).toEqual(['amber']);
            // The menu, as labelled options.
            expect(report.gauntlet.strategyOptions.map((option) => option.key)).toContain('amber');
            expect(
                report.gauntlet.strategyOptions.every(
                    (option) => option.label && option.description
                )
            ).toBe(true);
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
