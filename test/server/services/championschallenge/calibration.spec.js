const ChampionsChallengeService = require('../../../../server/services/championschallenge/ChampionsChallengeService');
const BotPolicyService = require('../../../../server/services/championschallenge/BotPolicyService');
const {
    PLAYER_ONE,
    PLAYER_TWO
} = require('../../../../server/services/championschallenge/SimulatedGame');

/**
 * ARCHON (N38): the only measurement in the lab that is not relative.
 *
 * The title fight proves a candidate beats the LAST champion. The persona duels
 * prove the three pilots are of comparable strength. A deck's win rate is
 * against the champion. Every one of those is a comparison with something that
 * moves, and none of them answers the question a member is actually asking when
 * they read "your deck wins 62%": against what standard of play?
 *
 * So the champion is played against opponents that never learn. Two properties
 * carry the whole idea, and both are ways this could look like it works while
 * measuring nothing:
 *
 *  - the rungs must be FIXED (a ladder whose rungs move is not a ladder), and
 *  - the pairing must be honest (same seed, seats swapped), or the ladder is
 *    measuring first-player advantage and calling it skill.
 */
describe('the calibration ladder', function () {
    let db;
    let service;
    let config;

    const configService = { getValue: () => ({}) };
    const settingsService = {
        getSectionWithDefaults: (name) => (name === 'championsChallenge' ? { ...config } : {}),
        getSection: () => ({})
    };

    const champion = { version: 7, weights: {}, bias: 0 };

    beforeEach(function () {
        config = {
            enabled: true,
            calibrationPairsPerSweep: 1,
            personaStrength: 0.6,
            maxTurnsPerGame: 80,
            deepCalibration: false
        };
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new ChampionsChallengeService(configService, db, settingsService);
        service.policyService = new BotPolicyService(configService, db, settingsService);
        service.neutralArenaDecks = () => [{ name: 'a' }, { name: 'b' }];
    });

    const recorded = () =>
        db.query.mock.calls
            .filter(([sql]) => sql.includes('INSERT INTO "ChallengeCalibration"'))
            .map(([, params]) => ({
                opponent: params[0],
                version: params[1],
                wins: params[2],
                losses: params[3]
            }));

    describe('running it', function () {
        it('plays each pair twice on one seed, with the seats swapped', async function () {
            const calls = [];

            service.runMatch = vi.fn(async (a, b, options) => {
                calls.push(options);

                return { completed: true, winner: PLAYER_ONE };
            });

            await service.runCalibration(config, champion);

            expect(calls).toHaveLength(2);
            // Same seed both times - the point of the pairing. Two different
            // seeds would be two games, and the seat advantage would survive.
            expect(calls[0].seed).toBe(calls[1].seed);
            // Champion alpha, then champion omega.
            expect(calls[0].policies.alpha).toBe(champion);
            expect(calls[1].policies.omega).toBe(champion);
        });

        it('scores the champion, not the seat', async function () {
            // PLAYER_ONE wins both games. The champion sat in alpha for the
            // first and omega for the second, so that is one win and one loss -
            // which is exactly what a seat advantage looks like once paired.
            service.runMatch = vi.fn(async () => ({ completed: true, winner: PLAYER_ONE }));

            await service.runCalibration(config, champion);

            const rows = recorded();

            expect(rows).toHaveLength(2);
            expect(rows.filter((row) => row.wins === 1)).toHaveLength(1);
            expect(rows.filter((row) => row.losses === 1)).toHaveLength(1);
        });

        it('measures against the heuristic bot first - the rung that matters most', async function () {
            service.runMatch = vi.fn(async () => ({ completed: true, winner: PLAYER_ONE }));

            await service.runCalibration(config, champion);

            // A learned policy that cannot beat the rules of thumb it replaced
            // is a regression, so that comparison is never optional.
            expect(recorded()[0].opponent).toBe('heuristic');
        });

        it('gives the heuristic rung a null policy, which IS the heuristic bot', async function () {
            const calls = [];

            service.runMatch = vi.fn(async (a, b, options) => {
                calls.push(options);

                return { completed: true, winner: PLAYER_ONE };
            });

            await service.runCalibration(config, champion);

            expect(calls[0].policies.omega).toBeNull();
        });

        it('works through every rung rather than favouring one', async function () {
            config.calibrationPairsPerSweep = 4;
            service.runMatch = vi.fn(async () => ({ completed: true, winner: PLAYER_ONE }));

            await service.runCalibration(config, champion);

            const opponents = [...new Set(recorded().map((row) => row.opponent))];

            // A random pick would leave one rung confidently measured and the
            // rest at three games each.
            expect(opponents.length).toBeGreaterThan(1);
            expect(opponents).toContain('heuristic');
        });

        it('drops a pair it could not finish whole', async function () {
            let played = 0;

            service.runMatch = vi.fn(async () => {
                played++;

                return played === 1
                    ? { completed: true, winner: PLAYER_ONE }
                    : { completed: false, reason: 'turn-cap' };
            });

            await service.runCalibration(config, champion);

            // Half a pair is an unpaired game - the exact noise the pairing
            // exists to remove, so nothing is recorded.
            expect(recorded()).toEqual([]);
        });

        it('plays greedily, because this is a measurement', async function () {
            const calls = [];

            service.runMatch = vi.fn(async (a, b, options) => {
                calls.push(options);

                return { completed: true, winner: PLAYER_ONE };
            });

            await service.runCalibration(config, champion);

            expect(calls[0].temperature).toBe(0);
            // And never into the diary: the champion playing itself variants is
            // not training data about how KeyForge is played.
            expect(calls[0].recordDecisions).toBe(false);
        });

        it('does nothing without a champion or without a budget', async function () {
            service.runMatch = vi.fn();

            expect(await service.runCalibration(config, null)).toBe(0);
            expect(
                await service.runCalibration({ ...config, calibrationPairsPerSweep: 0 }, champion)
            ).toBe(0);
            expect(service.runMatch).not.toHaveBeenCalled();
        });

        it('skips the persona rungs when styling is switched off', async function () {
            config.personaStrength = 0;
            config.calibrationPairsPerSweep = 3;
            service.runMatch = vi.fn(async () => ({ completed: true, winner: PLAYER_ONE }));

            await service.runCalibration(config, champion);

            // A persona at zero strength IS the champion, and a rung that is the
            // champion measures nothing at all.
            expect([...new Set(recorded().map((row) => row.opponent))]).toEqual(['heuristic']);
        });
    });

    describe('the deep rung', function () {
        it('searches on one seat only, and that seat swaps with the pair', async function () {
            const calls = [];

            service.runDeep = vi.fn(async (a, b, options) => {
                calls.push(options);

                return { completed: true, winner: PLAYER_ONE };
            });

            await service.runDeepCalibration({ ...config, deepCalibration: true }, champion);

            expect(calls).toHaveLength(2);
            // If both seats searched, the number would be the searching bot
            // against itself - which is not what anybody is asking.
            expect(calls[0].deepSide).toBe(PLAYER_TWO);
            expect(calls[1].deepSide).toBe(PLAYER_ONE);
            expect(calls[0].seed).toBe(calls[1].seed);
        });

        it('can be switched off, because it is the expensive rung', async function () {
            service.runDeep = vi.fn();

            expect(
                await service.runDeepCalibration({ ...config, deepCalibration: false }, champion)
            ).toBe(0);
            expect(service.runDeep).not.toHaveBeenCalled();
        });

        it('records nothing when the search cannot finish a game', async function () {
            service.runDeep = vi.fn(async () => ({ completed: false, reason: 'turn-cap' }));

            await service.runDeepCalibration({ ...config, deepCalibration: true }, champion);

            expect(recorded()).toEqual([]);
        });
    });

    describe('reading it back', function () {
        it('keeps each champion version apart', async function () {
            const policy = new BotPolicyService(configService, db, settingsService);

            await policy.recordCalibration('heuristic', 7, true);

            const [, params] = db.query.mock.calls.find(([sql]) =>
                sql.includes('INSERT INTO "ChallengeCalibration"')
            );

            // Pooling every model the loop ever promoted would smear a
            // regression across the record of the model that caused it.
            expect(params[1]).toBe(7);
        });

        it('reads the newest champion by default', async function () {
            const policy = new BotPolicyService(configService, db, settingsService);

            await policy.calibration();

            const [sql] = db.query.mock.calls.find(([statement]) =>
                statement.includes('FROM "ChallengeCalibration"')
            );

            expect(sql).toContain('MAX("PolicyVersion")');
        });

        it('carries the interval, not just the rate', async function () {
            db.query = vi.fn(async () => [
                { Opponent: 'heuristic', PolicyVersion: 7, Wins: 30, Losses: 10 }
            ]);

            const policy = new BotPolicyService(configService, db, settingsService);
            const [rung] = await policy.calibration();

            expect(rung.rate).toBeCloseTo(0.75, 5);
            expect(rung.low).toBeLessThan(rung.rate);
            expect(rung.high).toBeGreaterThan(rung.rate);
            expect(rung.games).toBe(40);
        });

        it('is an empty ladder, not an error, before it has run', async function () {
            db.query = vi.fn(async () => {
                throw new Error('nope');
            });

            const policy = new BotPolicyService(configService, db, settingsService);

            expect(await policy.calibration()).toEqual([]);
        });
    });

    it('never touches the official games, players or rating tables', async function () {
        service.runMatch = vi.fn(async () => ({ completed: true, winner: PLAYER_ONE }));

        await service.runCalibration(config, champion);

        for (const [sql] of db.query.mock.calls) {
            expect(sql).not.toMatch(/"(Games|GamePlayers|RatingHistory)"/);
        }
    });
});
