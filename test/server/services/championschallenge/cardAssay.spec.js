const CardAssayService = require('../../../../server/services/championschallenge/CardAssayService');

/**
 * ARCHON (N44): the assay, pinned against fakes.
 *
 * The claims that matter: mining counts PLAYS and never lesson rows, pairs
 * are admitted only on a tag hypothesis, the cursor moves; an experiment's
 * two decks differ by exactly one card and the winning DECK (not the seat)
 * is what scores; budgets are respected and a finished measurement is
 * recorded with its games; and the report flags pairs whose observed lift
 * argues with the tags.
 */
describe('the card assay', function () {
    let db;
    let runMatch;
    let synergyMap;

    const service = () =>
        new CardAssayService(db, {
            policyService: { champion: async () => null },
            runMatch,
            newSeed: () => 42,
            synergiesFor: (id) => synergyMap[id] || null
        });

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

    beforeEach(function () {
        db = { query: vi.fn().mockResolvedValue([]) };
        runMatch = vi.fn();
        synergyMap = {
            'bear-flute': { provides: [], wants: ['bigCreature'] },
            'ancient-bear': { provides: ['bigCreature'], wants: [] }
        };
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    describe('mining (phase 1)', function () {
        it('counts plays, skips lesson rows, admits only hypothesized pairs', async function () {
            answer([
                ['FROM "ChallengeAssayState"', [{ MinedThroughDiaryId: 0 }]],
                [
                    'FROM "BotTrainingGames"',
                    [
                        {
                            Id: 7,
                            WinnerSide: 'challenger-alpha',
                            Decisions: [
                                { cardId: 'bear-flute', side: 'challenger-alpha' },
                                { cardId: 'ancient-bear', side: 'challenger-alpha' },
                                { cardId: 'krump', side: 'challenger-alpha' },
                                { cardId: 'toad', side: 'challenger-omega' },
                                // A deep lesson: a road, not a play.
                                { cardId: 'gateway', side: 'challenger-alpha', target: 0.7 },
                                // A teacher lesson: same.
                                { cardId: 'gateway', side: 'challenger-alpha', weight: 3 }
                            ]
                        },
                        {
                            Id: 9,
                            WinnerSide: 'challenger-omega',
                            Decisions: [{ cardId: 'toad', side: 'challenger-omega' }]
                        }
                    ]
                ],
                ['COUNT(*)::int AS "Count" FROM "ChallengeCardPairObserved"', [{ Count: 0 }]]
            ]);

            const mined = await service().minePendingGames();

            expect(mined).toBe(2);

            // Cards: unnest arrays, ids sorted per game side.
            const [cardInsert] = queriesMatching('INSERT INTO "ChallengeCardObserved"');
            const [ids, games, wins] = cardInsert[1];
            const rowOf = (id) => ({ games: games[ids.indexOf(id)], wins: wins[ids.indexOf(id)] });

            expect(rowOf('bear-flute')).toEqual({ games: 1, wins: 1 });
            expect(rowOf('toad')).toEqual({ games: 2, wins: 1 });
            expect(ids).not.toContain('gateway');

            // Pairs: only the flute+bear hypothesis, sorted, credited a win.
            const [pairInsert] = queriesMatching('INSERT INTO "ChallengeCardPairObserved"');

            expect(pairInsert[1][0]).toEqual(['ancient-bear']);
            expect(pairInsert[1][1]).toEqual(['bear-flute']);
            expect(pairInsert[1][3]).toEqual([1]);

            // The cursor lands on the last row folded in.
            const [stateUpdate] = queriesMatching('INSERT INTO "ChallengeAssayState"');

            expect(stateUpdate[1][0]).toBe(9);
        });

        it('an empty diary advances nothing', async function () {
            answer([
                ['FROM "ChallengeAssayState"', [{ MinedThroughDiaryId: 40 }]],
                ['FROM "BotTrainingGames"', []]
            ]);

            expect(await service().minePendingGames()).toBe(0);
            expect(queriesMatching('INSERT INTO "ChallengeAssayState"')).toHaveLength(0);
        });
    });

    describe('the instrument (assayDecks)', function () {
        it('builds two 36-card decks differing by exactly one card', function () {
            const decks = service().assayDecks('krump');

            expect(decks).not.toBeNull();
            expect(decks.target.cards).toHaveLength(36);
            expect(decks.control.cards).toHaveLength(36);

            const count = (deck) => {
                const tally = {};

                for (const entry of deck.cards) {
                    tally[entry.id] = (tally[entry.id] || 0) + 1;
                }

                return tally;
            };
            const target = count(decks.target);
            const control = count(decks.control);

            expect(target.krump).toBe(1);
            expect(control.krump).toBeUndefined();
            expect(control[decks.replacementId]).toBe((target[decks.replacementId] || 0) + 1);

            // Everything else identical.
            for (const id of Object.keys(target)) {
                if (id !== 'krump' && id !== decks.replacementId) {
                    expect(control[id]).toBe(target[id]);
                }
            }
        });

        it('seats a partner in BOTH arms, so only the target differs', function () {
            const decks = service().assayDecks('bear-flute', null, 'ancient-bear');

            expect(decks).not.toBeNull();

            const has = (deck, id) => deck.cards.some((entry) => entry.id === id);

            expect(has(decks.target, 'ancient-bear')).toBe(true);
            expect(has(decks.control, 'ancient-bear')).toBe(true);
            expect(has(decks.target, 'bear-flute')).toBe(true);
            expect(has(decks.control, 'bear-flute')).toBe(false);
        });

        it('an unplayable target is a null, not a crash', function () {
            expect(service().assayDecks('no-such-card')).toBeNull();
        });
    });

    describe('experiments (phase 2)', function () {
        const config = { assayGamesPerSweep: 4, assayGamesPerExperiment: 40, maxTurnsPerGame: 80 };

        it('starts on the most-played unmeasured card and scores by winning DECK', async function () {
            answer([
                ['"Status" = \'running\'', []],
                ['FROM "ChallengeCardPairObserved"', []],
                ['FROM "ChallengeCardObserved"', [{ CardId: 'krump' }]],
                ['INSERT INTO "ChallengeCardExperiments"', [{ Id: 3 }]]
            ]);
            // The target arm wins the first game of each pair, loses the second.
            runMatch.mockImplementation(async (alpha) => ({
                completed: true,
                winner: 'challenger-alpha',
                winnerDeck: { uuid: alpha.uuid }
            }));

            await service().runExperimentStep(config, 4);

            expect(runMatch).toHaveBeenCalledTimes(4);

            const [update] = queriesMatching('UPDATE "ChallengeCardExperiments" SET "Games"');

            // 4 games, and with the alpha seat always winning, the target won
            // exactly its 2 alpha-seat games: seat advantage cancelled into a
            // 50% record, which is the whole point of pairing.
            expect(update[1]).toEqual([3, 4, 2]);
            expect(update[0]).not.toContain('measured');
        });

        it('a finished budget records the measurement', async function () {
            answer([
                [
                    '"Status" = \'running\'',
                    [
                        {
                            Id: 5,
                            CardId: 'krump',
                            PartnerCardId: null,
                            ReplacementCardId: null,
                            Games: 38,
                            Wins: 20
                        }
                    ]
                ]
            ]);
            runMatch.mockResolvedValue({
                completed: true,
                winner: 'challenger-alpha',
                winnerDeck: { uuid: 'assay-Assay Target' }
            });

            await service().runExperimentStep(config, 10);

            // Two more games reach the 40-game budget and stop, mid-budget.
            expect(runMatch).toHaveBeenCalledTimes(2);

            const [update] = queriesMatching('UPDATE "ChallengeCardExperiments" SET "Games"');

            expect(update[0]).toContain("'measured'");
            expect(update[1]).toEqual([5, 40, 22]);
        });

        it('with nothing observed yet there is nothing to measure', async function () {
            answer([
                ['"Status" = \'running\'', []],
                ['FROM "ChallengeCardPairObserved"', []],
                ['FROM "ChallengeCardObserved"', []]
            ]);

            await service().runExperimentStep(config, 4);
            expect(runMatch).not.toHaveBeenCalled();
        });
    });

    describe('the report', function () {
        it('flags hypothesized pairs whose observed lift is negative', async function () {
            answer([
                [
                    'FROM "ChallengeCardObserved"',
                    [
                        { CardId: 'bear-flute', Games: 100, Wins: 60 },
                        { CardId: 'ancient-bear', Games: 100, Wins: 56 }
                    ]
                ],
                [
                    'FROM "ChallengeCardPairObserved"',
                    [{ CardA: 'ancient-bear', CardB: 'bear-flute', Games: 40, Wins: 18 }]
                ],
                ['FROM "ChallengeCardExperiments"', []]
            ]);

            const report = await service().report();

            // Together 45% against 58% apart: the tags said combo, the games
            // said worse - exactly what the advisor should be shown.
            expect(report.tagAudit.contradicted).toHaveLength(1);
            expect(report.tagAudit.contradicted[0].lift).toBeLessThan(-0.05);
            expect(report.observedCards.strongest[0].games).toBe(100);
        });
    });
});
