const BotPolicyService = require('../../../../server/services/championschallenge/BotPolicyService');
const {
    HUMAN_OVERALL,
    bandFor,
    calibrationKeys,
    isHumanKey,
    countsTowardLadder
} = require('../../../../server/services/championschallenge/humanLadder');
const { DEFAULT_ELO_CONFIG } = require('../../../../server/services/rating/eloDefaults');

/**
 * ARCHON (N50): the rung that is a person.
 *
 * The calibration ladder (N39) measures the champion against opponents the lab
 * built, so it tops out at the lab's own ceiling and can never answer the
 * question anybody actually asks about a game bot. Nothing else on the site
 * could answer it either: practice games are deliberately never results, so a
 * bot that had never beaten a human being looked identical, from every
 * published number, to one that always did.
 *
 * Four things carry the idea, and each is a way this could look like it works
 * while measuring nothing:
 *
 *  - the SPLIT by opponent strength (one average is a number about the site's
 *    population, not about the bot),
 *  - the games that DO NOT count (the bot concedes itself past its own caps,
 *    and filing those as somebody's wins would turn a bot that got worse at
 *    finishing games into people getting better at beating it),
 *  - the seats being identified rather than guessed at, and
 *  - the human rows staying out of the fixed ladder's own query, which reads
 *    "the newest version anybody calibrated".
 */
describe('the human ladder', function () {
    const settings = (overrides = {}) => ({
        getSection: (name) => (name === 'rating' ? overrides : {}),
        getSectionWithDefaults: () => ({})
    });
    const configService = { getValue: () => ({}) };

    describe('which band a player lands in', function () {
        it('uses the rating engine’s own thresholds rather than a second opinion', function () {
            const elo = DEFAULT_ELO_CONFIG;

            expect(bandFor({ rating: 1500, gamesPlayed: elo.provisionalGames - 1 }, elo)).toBe(
                'provisional'
            );
            expect(bandFor({ rating: 1500, gamesPlayed: elo.provisionalGames }, elo)).toBe(
                'established'
            );
            expect(bandFor({ rating: elo.highRatingThreshold, gamesPlayed: 50 }, elo)).toBe(
                'strong'
            );
        });

        it('counts a player with no rating at all rather than dropping them', function () {
            // Dropping them would quietly make this a record of rated players
            // only, which on a young site is almost nobody - and the people who
            // join a practice table are exactly the unrated ones.
            expect(bandFor(null, DEFAULT_ELO_CONFIG)).toBe('provisional');
            expect(bandFor({ rating: NaN, gamesPlayed: 4 }, DEFAULT_ELO_CONFIG)).toBe(
                'provisional'
            );
        });

        it('reads the thresholds from settings when an admin has moved them', function () {
            const service = new BotPolicyService(
                configService,
                { query: vi.fn() },
                settings({ elo: { provisionalGames: 3, highRatingThreshold: 1500 } })
            );

            expect(service.eloThresholds()).toEqual({
                provisionalGames: 3,
                highRatingThreshold: 1500
            });
            expect(bandFor({ rating: 1600, gamesPlayed: 4 }, service.eloThresholds())).toBe(
                'strong'
            );
        });

        it('falls back to the shipped thresholds when the settings read throws', function () {
            const service = new BotPolicyService(
                configService,
                { query: vi.fn() },
                {
                    getSection: () => {
                        throw new Error('settings are down');
                    }
                }
            );

            expect(service.eloThresholds()).toEqual({
                provisionalGames: DEFAULT_ELO_CONFIG.provisionalGames,
                highRatingThreshold: DEFAULT_ELO_CONFIG.highRatingThreshold
            });
        });
    });

    describe('which games count', function () {
        it('throws away concessions and abandonments', function () {
            // The practice bot CONCEDES ITSELF past its interaction and turn
            // caps, so counting concessions would file the bot's own wedges as
            // wins for whoever was sitting across from it.
            expect(countsTowardLadder('concede')).toBe(false);
            expect(countsTowardLadder('abandoned')).toBe(false);
        });

        it('keeps every game the engine actually decided', function () {
            expect(countsTowardLadder('keys')).toBe(true);
            expect(countsTowardLadder('keys after time')).toBe(true);
            expect(countsTowardLadder('amber after time')).toBe(true);
        });
    });

    describe('what one finished game writes', function () {
        it('files a total and a band, and never only one of them', async function () {
            const query = vi.fn().mockResolvedValue([{ Rating: 1450, GamesPlayed: 40 }]);
            const service = new BotPolicyService(configService, { query }, settings());

            expect(
                await service.recordHumanLadderGame({
                    username: 'cathey',
                    botWon: false,
                    policyVersion: 11
                })
            ).toBe(true);

            const written = query.mock.calls
                .filter((call) => /INSERT INTO "ChallengeCalibration"/.test(call[0]))
                .map((call) => call[1]);

            expect(written.map((params) => params[0]).sort()).toEqual([
                'human',
                'human:established'
            ]);
            // The total is kept rather than summed back out of the bands:
            // the day a band is added, every historic row would be missing
            // from the new split, and the total is the number that must
            // never be wrong.
            expect(written.every((params) => params[1] === 11)).toBe(true);
            // The human won, so the bot lost: 0 wins, 1 loss, on both rows.
            expect(written.every((params) => params[2] === 0 && params[3] === 1)).toBe(true);
        });

        it('credits the model that actually played, not the model reigning now', async function () {
            const query = vi.fn().mockResolvedValue([]);
            const service = new BotPolicyService(configService, { query }, settings());

            await service.recordHumanLadderGame({
                username: 'someone',
                botWon: true,
                policyVersion: 7
            });

            const written = query.mock.calls
                .filter((call) => /INSERT INTO "ChallengeCalibration"/.test(call[0]))
                .map((call) => call[1]);

            expect(written.length).toBe(2);
            expect(written.every((params) => params[1] === 7)).toBe(true);
            expect(written.every((params) => params[2] === 1 && params[3] === 0)).toBe(true);
        });

        it('records nothing without a seat to record it against', async function () {
            const query = vi.fn().mockResolvedValue([]);
            const service = new BotPolicyService(configService, { query }, settings());

            expect(await service.recordHumanLadderGame({ botWon: true })).toBe(false);
            expect(query).not.toHaveBeenCalled();
        });

        it('still files the game when the standing cannot be read', async function () {
            // A ratings lookup that fails is not a reason to lose the result;
            // the player simply bands as provisional.
            const query = vi.fn().mockImplementation((sql) => {
                if (/FROM "Ratings"/.test(sql)) {
                    return Promise.reject(new Error('no database'));
                }

                return Promise.resolve([]);
            });
            const service = new BotPolicyService(configService, { query }, settings());

            expect(await service.recordHumanLadderGame({ username: 'x', botWon: true })).toBe(true);

            const written = query.mock.calls
                .filter((call) => /INSERT INTO "ChallengeCalibration"/.test(call[0]))
                .map((call) => call[1][0]);

            expect(written.sort()).toEqual(['human', 'human:provisional']);
        });
    });

    describe('reading the record back', function () {
        it('sums across every champion, and separates the total from the bands', async function () {
            const query = vi.fn().mockResolvedValue([
                { Opponent: 'human', Wins: 3, Losses: 9 },
                { Opponent: 'human:provisional', Wins: 3, Losses: 2 },
                { Opponent: 'human:strong', Wins: 0, Losses: 7 }
            ]);
            const service = new BotPolicyService(configService, { query }, settings());
            const ladder = await service.humanLadder();

            expect(ladder.overall.games).toBe(12);
            expect(ladder.overall.rate).toBeCloseTo(0.25, 5);
            expect(ladder.bands.map((row) => row.band).sort()).toEqual(['provisional', 'strong']);

            // The shape the whole panel exists to show: it beats the
            // newcomers and loses every game to the good players.
            const strong = ladder.bands.find((row) => row.band === 'strong');

            expect(strong.rate).toBe(0);
            expect(strong.games).toBe(7);
        });

        it('reports an empty record rather than throwing', async function () {
            const service = new BotPolicyService(
                configService,
                { query: vi.fn().mockRejectedValue(new Error('no database')) },
                settings()
            );

            expect(await service.humanLadder()).toEqual({ overall: null, bands: [] });
        });
    });

    describe('keeping off the fixed ladder', function () {
        it('excludes human rows from the calibration query, both halves', async function () {
            // The ladder reads "the newest version anybody calibrated". Human
            // rows are written at the champion version too, so one practice
            // game finishing after a promotion and before the lab's next sweep
            // would make MAX(PolicyVersion) name a version holding nothing but
            // that game - and the whole ladder would vanish from the page.
            const query = vi.fn().mockResolvedValue([]);
            const service = new BotPolicyService(configService, { query }, settings());

            await service.calibration();

            const sql = query.mock.calls[0][0];
            const guards = sql.match(/"Opponent" <> 'human'/g) || [];

            expect(guards.length).toBe(2);
            expect(sql).toContain('"Opponent" NOT LIKE \'human:%\'');
        });

        it('agrees with the key helpers about what a human row is', function () {
            expect(isHumanKey(HUMAN_OVERALL)).toBe(true);
            expect(isHumanKey('human:strong')).toBe(true);
            expect(isHumanKey('heuristic')).toBe(false);
            expect(isHumanKey('deep')).toBe(false);
            expect(calibrationKeys('strong')).toEqual(['human', 'human:strong']);
        });
    });
});
