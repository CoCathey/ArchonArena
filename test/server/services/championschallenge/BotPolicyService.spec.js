const BotPolicyService = require('../../../../server/services/championschallenge/BotPolicyService');

// The title-fight machinery against a mocked db: the diary is pruned, a
// candidate is only born from enough evidence, and the crown changes hands
// only on a Wilson bound - the same conservatism as the hidden-gem badge,
// applied to the bot's own brain.

describe('BotPolicyService', function () {
    let db;
    let service;

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
        service = new BotPolicyService({ getValue: () => ({}) }, db, { getSection: () => ({}) });
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    it('logs a game, prunes the diary, and reports its depth', async function () {
        answer([['COUNT(*)::int', [{ Count: 7 }]]]);

        const count = await service.recordTrainingGame(
            { policyVersion: 3, winnerSide: 'challenger-alpha', decisions: [{ side: 'x' }] },
            4000
        );

        expect(count).toBe(7);

        const [insert] = queriesMatching('INSERT INTO "BotTrainingGames"');

        expect(insert[1][0]).toBe(3);
        expect(insert[1][1]).toBe('challenger-alpha');

        const [prune] = queriesMatching('DELETE FROM "BotTrainingGames"');

        expect(prune[1]).toEqual([4000]);
    });

    describe('trainCandidate', function () {
        const diaryRows = (count) =>
            Array.from({ length: count }, (_, index) => ({
                WinnerSide: index % 2 ? 'challenger-alpha' : 'challenger-omega',
                Decisions: [
                    {
                        state: { bias: 1 },
                        action: { 'act:reap': 1 },
                        cardId: null,
                        side: index % 2 ? 'challenger-alpha' : 'challenger-omega'
                    }
                ]
            }));

        it('refuses to train from too thin a diary', async function () {
            answer([
                ['FROM "BotTrainingGames"', diaryRows(5)],
                ["'candidate'", []]
            ]);

            expect(await service.trainCandidate()).toBeNull();
            expect(queriesMatching('INSERT INTO "BotPolicies"')).toEqual([]);
        });

        it('will not start a second title fight while one is on', async function () {
            answer([["'candidate'", [{ Id: 9, Version: 4, Model: {} }]]]);

            expect(await service.trainCandidate()).toBeNull();
        });

        it('trains a versioned candidate from the diary', async function () {
            // The INSERT's own SQL contains the literal 'candidate', so it
            // must dispatch ahead of the candidate-lookup handler.
            answer([
                ['INSERT INTO "BotPolicies"', [{ Id: 12 }]],
                ["'candidate'", []],
                ["'champion'", []],
                ['ORDER BY "Id" DESC LIMIT', diaryRows(60)],
                ['COALESCE(MAX("Version")', [{ Version: 4 }]]
            ]);

            const candidate = await service.trainCandidate({ batchGames: 100 });

            expect(candidate.Version).toBe(5);

            const [insert] = queriesMatching('INSERT INTO "BotPolicies"');

            expect(insert[1][0]).toBe(5);
            expect(JSON.parse(insert[1][1]).version).toBe(5);
        });
    });

    describe('recordArenaResult', function () {
        it('keeps fighting while the record proves nothing', async function () {
            answer([
                ['UPDATE "BotPolicies" SET', [{ Version: 5, ArenaWins: 30, ArenaLosses: 25 }]]
            ]);

            expect(await service.recordArenaResult(12, true)).toBe('fighting');
        });

        it('promotes only when the Wilson bound clears 50%', async function () {
            // 120-60 over 180 games: lower bound ~0.593 - a real title.
            answer([
                ['UPDATE "BotPolicies" SET', [{ Version: 5, ArenaWins: 120, ArenaLosses: 60 }]]
            ]);

            expect(
                await service.recordArenaResult(12, true, { minGames: 150, decideGames: 400 })
            ).toBe('promoted');

            const flips = queriesMatching("'champion'").filter(([sql]) => sql.includes('UPDATE'));

            expect(flips.length).toBeGreaterThan(0);
        });

        it('does not promote a 52% record even over many games', async function () {
            answer([
                ['UPDATE "BotPolicies" SET', [{ Version: 5, ArenaWins: 104, ArenaLosses: 96 }]]
            ]);

            expect(
                await service.recordArenaResult(12, true, { minGames: 150, decideGames: 400 })
            ).toBe('fighting');
        });

        it('retires a candidate that cannot prove itself in the window', async function () {
            answer([
                ['UPDATE "BotPolicies" SET', [{ Version: 5, ArenaWins: 205, ArenaLosses: 195 }]]
            ]);

            expect(
                await service.recordArenaResult(12, false, { minGames: 150, decideGames: 400 })
            ).toBe('retired');

            const retire = queriesMatching("'retired'").filter(([sql]) =>
                sql.includes('WHERE "Id" = $1')
            );

            expect(retire.length).toBe(1);
        });
    });

    it('reports vitals the page can render', async function () {
        answer([
            [
                'FROM "BotPolicies"',
                [
                    {
                        Version: 6,
                        Status: 'candidate',
                        TrainedGames: 300,
                        ArenaWins: 40,
                        ArenaLosses: 31
                    },
                    {
                        Version: 5,
                        Status: 'champion',
                        TrainedGames: 250,
                        ArenaWins: 160,
                        ArenaLosses: 90
                    }
                ]
            ]
        ]);

        const vitals = await service.vitals();

        expect(vitals.championVersion).toBe(5);
        expect(vitals.candidate.version).toBe(6);
        expect(vitals.candidate.arenaWins).toBe(40);
    });
});
