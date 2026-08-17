const ChampionsChallengeService = require('../../../../server/services/championschallenge/ChampionsChallengeService');
const BotPolicyService = require('../../../../server/services/championschallenge/BotPolicyService');
const { PLAYER_ONE } = require('../../../../server/services/championschallenge/SimulatedGame');
const {
    PERSONA_KEYS,
    personaByKey
} = require('../../../../server/services/championschallenge/labPersonas');
const { MIN_STYLE_GAMES } = require('../../../../server/services/championschallenge/labMath');

/**
 * ARCHON (N28): three pilots in the sweep, and the record they leave behind.
 *
 * The unit tests for the personas themselves live in labPersonas.spec.js. What
 * is pinned here is the wiring, where the interesting mistakes are:
 *
 *  - both seats of a sparring game share the pilot. That is not a detail: with
 *    two different pilots in one game, every result would carry "which bot flew
 *    it", and the whole point is a result that is about the decks.
 *  - the pilot is RECORDED. A game whose pilot went unrecorded can never be
 *    attributed afterwards, and the per-style records are read off that column.
 *  - a showcase game is unstyled, because a showcase is meant to be the best
 *    play the site can produce.
 *  - the duels pair their seeds and swap the pilots, so a persona ladder
 *    measures the players rather than the decks.
 */
const USER = 42;

describe('sparring personas in the sweep', function () {
    let db;
    let service;
    let config;

    const configService = { getValue: () => ({}) };
    const settingsService = {
        getSectionWithDefaults: (name) => (name === 'championsChallenge' ? { ...config } : {}),
        getSection: () => ({})
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

    const queriesMatching = (fragment) =>
        db.query.mock.calls.filter(([sql]) => sql.includes(fragment));

    const deckCardRows = [
        { CardId: 'anger', Count: 12, House: null, IsNonDeck: false },
        { CardId: 'hand-of-dis', Count: 12, House: null, IsNonDeck: false },
        { CardId: 'foggify', Count: 12, House: null, IsNonDeck: false }
    ];
    const deckHouseRows = [{ Code: 'brobnar' }, { Code: 'dis' }, { Code: 'logos' }];

    const champion = { version: 3, weights: { 'a:act:reap': 0.2 }, cardWeights: {} };

    const fakeResult = (winnerId, loserId) => ({
        completed: true,
        winner: PLAYER_ONE,
        winnerDeck: { dbId: winnerId, uuid: `u-${winnerId}` },
        loserDeck: { dbId: loserId, uuid: `u-${loserId}` },
        winnerKeys: 3,
        loserKeys: 1,
        turns: 21,
        winnerWentFirst: true,
        winnerFirstHouse: 'brobnar',
        loserFirstHouse: 'dis',
        winnerHouseCalls: { brobnar: 5 },
        loserHouseCalls: { dis: 4 },
        durationMs: 500,
        decisions: []
    });

    const sweepAnswers = () =>
        answer([
            [
                'SELECT "UserId", "DeckId" FROM "ProvingGroundsDecks"',
                [
                    { UserId: USER, DeckId: 1 },
                    { UserId: USER, DeckId: 2 }
                ]
            ],
            ["date_trunc('day'", []],
            ['FROM "UserRoles"', [{ IsAdmin: false }]],
            [
                'FROM "Memberships"',
                [{ UserId: USER, Tier: 'vault_master', Status: 'active', ExpiresAt: null }]
            ],
            ['FROM "DeckCards"', deckCardRows],
            ['FROM "DeckHouses"', deckHouseRows],
            [
                'FROM "Decks" d WHERE d."Id"',
                (sql, params) => [{ Id: params[0], Name: `Deck ${params[0]}`, Uuid: 'u' }]
            ]
        ]);

    beforeEach(function () {
        config = {
            enabled: true,
            sweepIntervalSeconds: 60,
            gamesPerSweep: 1,
            gamesPerDeckPerDay: 12,
            maxEnrolledPerUser: 8,
            maxTurnsPerGame: 80,
            personasEnabled: true,
            personaStrength: 1,
            personaDuelPairsPerSweep: 0,
            deepGamesPerDay: 0
        };
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new ChampionsChallengeService(configService, db, settingsService);
        service.policyService = {
            champion: vi.fn().mockResolvedValue(champion),
            candidate: vi.fn().mockResolvedValue(null),
            recordTrainingGame: vi.fn().mockResolvedValue(1),
            trainCandidate: vi.fn().mockResolvedValue(null),
            recordPersonaDuel: vi.fn().mockResolvedValue(true),
            personaLadder: vi.fn().mockResolvedValue([]),
            vitals: vi.fn().mockResolvedValue(null),
            strengthCurve: vi.fn().mockResolvedValue([])
        };
        service.gauntletService.anyoneWantsField = vi.fn().mockResolvedValue(false);
        service.gauntletService.settingsFor = vi.fn().mockResolvedValue({ enabled: false });
        service.ariService.applyGameResult = vi.fn().mockResolvedValue(true);
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    describe('the mirror lab', function () {
        it('flies one pilot, both seats, and writes down which', async function () {
            sweepAnswers();
            service.runMatch = vi.fn().mockResolvedValue(fakeResult(1, 2));

            await service.runSweep();

            const options = service.runMatch.mock.calls[0][2];

            // One model for the game, not one per seat: `policies` is the arena's
            // head-to-head mode and would put the pilot into the result.
            expect(options.policies).toBeUndefined();
            expect(PERSONA_KEYS).toContain(options.policy.persona);
            // The champion's own weights are still in there - a persona ADDS to
            // the trained brain, it does not replace it. (Every persona has a
            // view on reaping, so this one key is enough to tell the two apart.)
            const bias = personaByKey(options.policy.persona).bias['a:act:reap'];

            expect(options.policy.weights['a:act:reap']).toBeCloseTo(0.2 + bias, 6);

            const [insert] = queriesMatching('INSERT INTO "ProvingGroundsGames"');

            expect(insert[0]).toContain('"Persona"');
            expect(insert[1][14]).toBe(options.policy.persona);
        });

        it('tags the diary row with the pilot too', async function () {
            sweepAnswers();
            service.runMatch = vi.fn().mockResolvedValue({
                ...fakeResult(1, 2),
                decisions: [{ state: {}, action: {} }]
            });

            await service.runSweep();

            const [[logged]] = service.policyService.recordTrainingGame.mock.calls;

            expect(PERSONA_KEYS).toContain(logged.persona);
        });

        it('rotates the pilots rather than flying one all sweep', async function () {
            sweepAnswers();
            config.gamesPerSweep = 6;
            config.gamesPerDeckPerDay = 99;
            service.runMatch = vi.fn().mockResolvedValue(fakeResult(1, 2));

            await service.runSweep();

            const flown = new Set(
                service.runMatch.mock.calls.map(([, , options]) => options.policy.persona)
            );

            expect(flown.size).toBe(3);
        });

        // The champion, unstyled, is what the bot can do. A stylised exhibition
        // annotated as the bot's best thinking would be a strange thing to show.
        it('leaves a showcase game unstyled', async function () {
            sweepAnswers();
            config.deepGamesPerDay = 5;
            service.runDeep = vi.fn().mockResolvedValue(fakeResult(1, 2));
            service.runMatch = vi.fn();

            await service.runSweep();

            expect(service.runDeep).toHaveBeenCalled();
            expect(service.runDeep.mock.calls[0][2].policy).toBe(champion);

            const [insert] = queriesMatching('INSERT INTO "ProvingGroundsGames"');

            expect(insert[1][14]).toBeNull();
        });

        it('plays the champion itself when styles are switched off', async function () {
            sweepAnswers();
            config.personasEnabled = false;
            service.runMatch = vi.fn().mockResolvedValue(fakeResult(1, 2));

            await service.runSweep();

            expect(service.runMatch.mock.calls[0][2].policy).toBe(champion);

            const [insert] = queriesMatching('INSERT INTO "ProvingGroundsGames"');

            expect(insert[1][14]).toBeNull();
        });

        // No trained brain, no styles: the heuristic bot plays as it always has.
        it('does not style the heuristics', async function () {
            sweepAnswers();
            service.policyService.champion = vi.fn().mockResolvedValue(null);
            service.runMatch = vi.fn().mockResolvedValue(fakeResult(1, 2));

            await service.runSweep();

            expect(service.runMatch.mock.calls[0][2].policy).toBeNull();
        });
    });

    describe('the calibration duels', function () {
        it('plays a pair on one seed with the pilots swapped', async function () {
            service.runMatch = vi.fn().mockResolvedValue({ completed: true, winner: PLAYER_ONE });

            const pairs = await service.runPersonaDuels(
                { ...config, personaDuelPairsPerSweep: 1 },
                champion
            );

            expect(pairs).toBe(1);
            expect(service.runMatch).toHaveBeenCalledTimes(2);

            const [first, second] = service.runMatch.mock.calls.map(([, , options]) => options);

            // One seed, played twice - so both pilots meet the same shuffles, the
            // same draws and the same first-player advantage, once from each side.
            expect(first.seed).toBe(second.seed);
            expect(first.policies.alpha.persona).toBe(second.policies.omega.persona);
            expect(first.policies.omega.persona).toBe(second.policies.alpha.persona);
            // A duel is a measurement, not training: no exploration, nothing
            // logged, and it never touches anyone's deck stats.
            expect(first.temperature).toBe(0);
            expect(first.recordDecisions).toBe(false);
            expect(queriesMatching('INSERT INTO "ProvingGroundsGames"')).toHaveLength(0);
        });

        it('records the winner of each half', async function () {
            // Alpha wins both halves, which is one win for each pilot: the pair
            // is what cancels the seat, so a swept pair is a drawn pair.
            service.runMatch = vi.fn().mockResolvedValue({ completed: true, winner: PLAYER_ONE });

            await service.runPersonaDuels({ ...config, personaDuelPairsPerSweep: 1 }, champion);

            const duels = service.policyService.recordPersonaDuel.mock.calls;

            expect(duels).toHaveLength(2);
            expect(duels[0][0]).not.toBe(duels[1][0]);
        });

        it('drops a pair whose second half could not be played', async function () {
            service.runMatch = vi
                .fn()
                .mockResolvedValueOnce({ completed: true, winner: PLAYER_ONE })
                .mockResolvedValueOnce({ completed: false, reason: 'stuck' });

            const pairs = await service.runPersonaDuels(
                { ...config, personaDuelPairsPerSweep: 1 },
                champion
            );

            // Half a pair is an unpaired game, which is the noise the pairing
            // exists to remove.
            expect(pairs).toBe(0);
            expect(service.policyService.recordPersonaDuel).not.toHaveBeenCalled();
        });

        it('measures a different pair each time it runs', async function () {
            service.runMatch = vi.fn().mockResolvedValue({ completed: true, winner: PLAYER_ONE });

            const seen = [];

            for (let round = 0; round < 3; round++) {
                await service.runPersonaDuels({ ...config, personaDuelPairsPerSweep: 1 }, champion);
                seen.push(
                    service.policyService.recordPersonaDuel.mock.calls
                        .slice(-2)
                        .map(([winner]) => winner)
                        .sort()
                        .join('/')
                );
            }

            expect(new Set(seen).size).toBe(3);
        });

        it('does not duel without a champion, a strength, or a budget', async function () {
            service.runMatch = vi.fn();

            expect(await service.runPersonaDuels({ ...config }, champion)).toBe(0);
            expect(
                await service.runPersonaDuels({ ...config, personaDuelPairsPerSweep: 1 }, null)
            ).toBe(0);
            expect(
                await service.runPersonaDuels(
                    { ...config, personaDuelPairsPerSweep: 1, personasEnabled: false },
                    champion
                )
            ).toBe(0);
            expect(service.runMatch).not.toHaveBeenCalled();
        });
    });

    describe('the record a member reads', function () {
        const gameUnder = (persona, winnerId, loserId) => ({
            WinnerDeckId: winnerId,
            LoserDeckId: loserId,
            WinnerKeys: 3,
            LoserKeys: 1,
            Turns: 20,
            WinnerWentFirst: true,
            Persona: persona,
            FinishedAt: '2026-01-01T00:00:00Z'
        });

        const aggregate = (games) =>
            service.aggregateDeck(
                { DeckId: 1, Name: 'Mine', SasRating: 70, Uuid: 'u-1', EnrolledAt: null },
                games,
                new Map([
                    [1, 70],
                    [2, 70]
                ]),
                { sasWeight: 1 }
            );

        it('reports the deck under each pilot, and how far apart they are', function () {
            const games = [];

            // The Racer beats this deck; the Bruiser loses to it. One overall
            // percentage would read as "about even" and say nothing.
            for (let i = 0; i < MIN_STYLE_GAMES; i++) {
                games.push(gameUnder('racer', 1, 2));
                games.push(gameUnder('bruiser', 2, 1));
            }

            const deck = aggregate(games);
            const racer = deck.styles.find((style) => style.persona === 'racer');

            expect(racer.games).toBe(MIN_STYLE_GAMES);
            expect(racer.rate).toBe(1);
            expect(racer.label).toBe('The Racer');
            expect(deck.styleSpread).toBe(1);
            expect(deck.hardestStyle.persona).toBe('bruiser');
            // The overall record is unchanged by any of this - it is the same
            // games, counted once.
            expect(deck.games).toBe(MIN_STYLE_GAMES * 2);
        });

        // Two five-game records "disagreeing" is noise with a caption.
        it('refuses to call a spread on thin records', function () {
            const deck = aggregate([gameUnder('racer', 1, 2), gameUnder('bruiser', 2, 1)]);

            expect(deck.styles).toHaveLength(2);
            expect(deck.styleSpread).toBeNull();
            expect(deck.hardestStyle).toBeNull();
        });

        it('says nothing about styles for games played before them', function () {
            const deck = aggregate([gameUnder(null, 1, 2)]);

            expect(deck.styles).toEqual([]);
            expect(deck.styleSpread).toBeNull();
            expect(deck.games).toBe(1);
        });
    });

    describe('the ladder', function () {
        let policyService;
        let ladderDb;

        beforeEach(function () {
            ladderDb = { query: vi.fn().mockResolvedValue([]) };
            policyService = new BotPolicyService(configService, ladderDb, settingsService);
        });

        it('files a pair one way round however the winner is named', async function () {
            await policyService.recordPersonaDuel('schemer', 'racer');

            const [sql, params] = ladderDb.query.mock.calls[0];

            expect(sql).toContain('ON CONFLICT ("PersonaA", "PersonaB")');
            // Sorted keys, so one pair is one row rather than two halves of the
            // same record filed under different names.
            expect(params.slice(0, 2)).toEqual(['racer', 'schemer']);
            expect(params.slice(2)).toEqual([0, 1]);
        });

        it('refuses a persona duelling itself', async function () {
            expect(await policyService.recordPersonaDuel('racer', 'racer')).toBe(false);
            expect(ladderDb.query).not.toHaveBeenCalled();
        });

        it('adds up both sides of every pair, with the interval', async function () {
            ladderDb.query.mockResolvedValue([
                { PersonaA: 'bruiser', PersonaB: 'racer', WinsA: 30, WinsB: 10 },
                { PersonaA: 'bruiser', PersonaB: 'schemer', WinsA: 20, WinsB: 20 }
            ]);

            const ladder = await policyService.personaLadder();

            expect(ladder[0].persona).toBe('bruiser');
            expect(ladder[0].wins).toBe(50);
            expect(ladder[0].losses).toBe(30);
            expect(ladder[0].games).toBe(80);
            expect(ladder[0].label).toBe('The Bruiser');
            // A rate with no interval invites reading 40 games as a settled fact.
            expect(ladder[0].low).toBeLessThan(ladder[0].rate);
            expect(ladder[0].high).toBeGreaterThan(ladder[0].rate);
            expect(ladder[ladder.length - 1].persona).toBe('racer');
        });

        it('is empty, not broken, before any duel', async function () {
            expect(await policyService.personaLadder()).toEqual([]);

            ladderDb.query.mockRejectedValue(new Error('no table'));

            expect(await policyService.personaLadder()).toEqual([]);
        });
    });

    // The property the whole Challenge stands on, extended to the duels.
    it('never touches the official games, players or rating tables', async function () {
        sweepAnswers();
        config.personaDuelPairsPerSweep = 1;
        service.runMatch = vi.fn().mockResolvedValue(fakeResult(1, 2));

        await service.runSweep();

        for (const [sql] of db.query.mock.calls) {
            expect(sql).not.toMatch(/"(Games|GamePlayers|RatingHistory)"/);
        }
    });
});
