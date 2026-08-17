const VaultTourService = require('../../../../server/services/championschallenge/VaultTourService');
const { SLATE_SIZE } = require('../../../../server/services/championschallenge/VaultTourService');
const ChampionsChallengeService = require('../../../../server/services/championschallenge/ChampionsChallengeService');
const { DEFAULT_FIELD } = require('../../../../server/services/championschallenge/vaultTourField');
const { PLAYER_ONE } = require('../../../../server/services/championschallenge/SimulatedGame');

/**
 * ARCHON (N32): the Vault Tour - a slate against a field somebody won events
 * with.
 *
 * Three separations are the whole design, and each is the sort of thing that
 * would break silently:
 *
 *  - the slate is not the roster, and its games are not the roster's games;
 *  - the daily budget is counted from this table alone, so neither measurement
 *    can starve the other;
 *  - **no ARI, ever**. A hand-picked field of tournament winners is the opposite
 *    of the representative opposition a rating needs, and a rating quietly fed
 *    by an operator's choice of opponents is unfixable after the fact because
 *    nobody can tell which part of the number came from where.
 */
const USER = 42;

describe('the Vault Tour', function () {
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

    // Stubbing fetch means putting the REAL one back afterwards, not leaving it
    // replaced: spec files share a worker process, and a stray stub here breaks
    // unrelated files that spy on fetch - failing only in a full run, which is
    // exactly how it was found the first time.
    let realFetch;

    beforeEach(function () {
        realFetch = global.fetch;
        config = {
            enabled: true,
            vaultTourEnabled: true,
            vaultTourGamesPerSweep: 4,
            gamesPerDeckPerDay: 12,
            maxTurnsPerGame: 80,
            gauntletRequestDelayMs: 0
        };
        db = { query: vi.fn().mockResolvedValue([]) };
        service = new VaultTourService(configService, db, settingsService);
        service.sleep = () => Promise.resolve();
    });

    afterEach(function () {
        global.fetch = realFetch;
        vi.restoreAllMocks();
    });

    describe('the field', function () {
        it('takes a Decks of KeyForge link, a Master Vault link, or a bare id', function () {
            const uuid = 'c0ef2bf4-ccfc-40b6-a0c7-5d1608fe84a3';

            expect(service.parseUuid(`https://decksofkeyforge.com/decks/${uuid}`)).toBe(uuid);
            expect(service.parseUuid(`https://www.keyforgegame.com/deck-details/${uuid}`)).toBe(
                uuid
            );
            expect(service.parseUuid(uuid.toUpperCase())).toBe(uuid);
            expect(service.parseUuid('not a deck')).toBeNull();
        });

        it('refuses an entry with no event, because the event is the point', async function () {
            const result = await service.addDeck({ link: DEFAULT_FIELD[0], event: '  ' });

            expect(result.ok).toBe(false);
            expect(result.message).toMatch(/which event/i);
        });

        /**
         * A deck this server cannot simulate is STORED and marked, not refused.
         * Refusing it leaves the operator with an entry that silently never
         * appears in anybody's matrix and no way to find out why.
         */
        it('keeps a deck it cannot simulate, with the reason', async function () {
            service.deckService = {
                parseDeckResponse: vi.fn().mockResolvedValue({
                    name: 'Half A Deck',
                    expansion: 700,
                    houses: ['dis', 'logos'],
                    cards: [{ id: 'anger', count: 1 }]
                })
            };
            global.fetch = vi
                .fn()
                .mockResolvedValue({ ok: true, json: async () => ({ data: {}, _linked: {} }) });

            const result = await service.addDeck({
                link: DEFAULT_FIELD[0],
                event: 'Vault Tour Atlanta',
                placing: 'winner'
            });

            expect(result.ok).toBe(true);
            expect(result.deck.playable).toBe(false);
            expect(result.message).toMatch(/cannot simulate/i);

            const [insert] = queriesMatching('INSERT INTO "VaultTourDecks"');

            // Stored as unplayable with the reason - a two-house deck is not a
            // game the engine knows how to start.
            expect(insert[1][5]).toBe(false);
            expect(insert[1][6]).toBe('house-count');
        });

        it('seeds the shipped field without overwriting an operator’s edits', async function () {
            answer([['INSERT INTO "VaultTourDecks"', [{ Uuid: 'a' }, { Uuid: 'b' }]]]);

            expect(await service.seedDefaults()).toBe(2);

            const [seed] = queriesMatching('INSERT INTO "VaultTourDecks"');

            // DO NOTHING, so a corrected placing or a deleted entry survives
            // every later sweep.
            expect(seed[0]).toContain('ON CONFLICT ("Uuid") DO NOTHING');
            expect(seed[1][0]).toEqual(DEFAULT_FIELD);
        });

        // The list arrived without placings, and "won the event" is not a claim
        // to invent to fill a column.
        it('seeds them as unconfirmed rather than guessing a placing', async function () {
            await service.seedDefaults();

            const [seed] = queriesMatching('INSERT INTO "VaultTourDecks"');

            expect(seed[0]).toContain("'unknown'");
        });

        it('has no duplicates in the shipped list', function () {
            expect(new Set(DEFAULT_FIELD).size).toBe(DEFAULT_FIELD.length);
        });

        it('fetches cards for the decks that have none, oldest attempt first', async function () {
            service.deckService = {
                parseDeckResponse: vi.fn().mockResolvedValue({
                    name: 'A Real Deck',
                    expansion: 700,
                    houses: ['dis', 'logos', 'mars'],
                    cards: [{ id: 'anger', count: 3 }]
                })
            };
            global.fetch = vi
                .fn()
                .mockResolvedValue({ ok: true, json: async () => ({ data: {}, _linked: {} }) });
            answer([['"Cards" IS NULL', [{ Uuid: DEFAULT_FIELD[0] }]]]);

            const outcome = await service.hydrateField({ decksPerRun: 1 });

            expect(outcome.hydrated).toBe(1);
            expect(queriesMatching('"Cards" IS NULL')[0][0]).toContain('ORDER BY "FetchedAt" ASC');

            const [update] = queriesMatching('UPDATE "VaultTourDecks" SET "Name"');

            expect(update[1][5]).toBe(true);
        });

        /**
         * A deck Master Vault could not answer for still moves its stamp, so the
         * queue rotates instead of grinding on the same row - and it is retried
         * eventually, because the usual cause is a bad minute, not a bad deck.
         */
        it('moves on from a deck Master Vault would not answer for', async function () {
            service.deckService = { parseDeckResponse: vi.fn() };
            global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
            answer([['"Cards" IS NULL', [{ Uuid: DEFAULT_FIELD[0] }]]]);

            const outcome = await service.hydrateField({ decksPerRun: 1 });

            expect(outcome.failed).toBe(1);
            expect(queriesMatching('SET "FetchedAt"')).toHaveLength(1);
        });
    });

    describe('the slate', function () {
        const loadEngineDeck = async () => ({ missing: [], deck: { houses: ['a', 'b', 'c'] } });

        it('holds three decks and says so when it is full', async function () {
            answer([['COUNT(*)::int AS "Count"', [{ Count: SLATE_SIZE }]]]);

            await expect(service.enroll(USER, 7, { loadEngineDeck })).rejects.toThrow(
                new RegExp(`${SLATE_SIZE} decks at a time`)
            );
        });

        it("refuses somebody else's deck", async function () {
            answer([
                ['COUNT(*)::int AS "Count"', [{ Count: 0 }]],
                ['FROM "Decks" d WHERE d."Id"', [{ Id: 7, UserId: USER + 1, Name: 'Theirs' }]]
            ]);

            await expect(service.enroll(USER, 7, { loadEngineDeck })).rejects.toThrow(
                'Not your deck.'
            );
        });

        it('refuses a deck this server cannot simulate', async function () {
            answer([
                ['COUNT(*)::int AS "Count"', [{ Count: 0 }]],
                ['FROM "Decks" d WHERE d."Id"', [{ Id: 7, UserId: USER, Name: 'Mine' }]]
            ]);

            await expect(
                service.enroll(USER, 7, {
                    loadEngineDeck: async () => ({ missing: ['mystery'], deck: { houses: [] } })
                })
            ).rejects.toThrow(/cannot play that deck/i);
        });

        /**
         * No SAS requirement, unlike the roster. The roster compares a deck with
         * what its rating predicted, so it needs one; the Vault Tour compares it
         * with named opponents, and a deck nobody has rated has a place here.
         */
        it('takes a deck Decks of KeyForge has never rated', async function () {
            answer([
                ['COUNT(*)::int AS "Count"', [{ Count: 0 }]],
                [
                    'FROM "Decks" d WHERE d."Id"',
                    [{ Id: 7, UserId: USER, Name: 'Unrated', Banned: false }]
                ]
            ]);

            await expect(service.enroll(USER, 7, { loadEngineDeck })).resolves.toMatchObject({
                deckId: 7
            });
        });
    });

    describe('the matrix', function () {
        it('is this deck against that deck, both records', async function () {
            answer([
                [
                    'FROM "VaultTourGames" WHERE "UserId"',
                    [
                        {
                            DeckId: 1,
                            OpponentUuid: 'u-a',
                            OpponentName: 'Winner A',
                            OpponentEvent: 'VT Atlanta',
                            OpponentPlacing: 'winner',
                            Played: 10,
                            Wins: 7
                        },
                        {
                            DeckId: 1,
                            OpponentUuid: 'u-b',
                            OpponentName: 'Winner B',
                            OpponentEvent: 'VT Madrid',
                            OpponentPlacing: 'runner-up',
                            Played: 10,
                            Wins: 2
                        }
                    ]
                ]
            ]);

            const matrix = await service.matrixFor(USER);

            expect(matrix.opponents.map((o) => o.uuid)).toEqual(['u-a', 'u-b']);
            expect(matrix.cells['1|u-a']).toMatchObject({ games: 10, wins: 7, winRate: 0.7 });
            expect(matrix.cells['1|u-b'].winRate).toBeCloseTo(0.2, 6);
            // The average across the field is 45% - which is exactly the number
            // that would have hidden "loses badly to the Madrid deck".
            expect(matrix.totals[1].games).toBe(20);
            expect(matrix.totals[1].rate).toBeCloseTo(0.45, 6);
            expect(matrix.totals[1].low).toBeLessThan(matrix.totals[1].rate);
        });

        it('is empty rather than broken before any game', async function () {
            expect(await service.matrixFor(USER)).toEqual({
                opponents: [],
                cells: {},
                totals: {}
            });
        });
    });

    describe('in the sweep', function () {
        let lab;

        beforeEach(function () {
            lab = new ChampionsChallengeService(configService, db, settingsService);
            lab.rosterAccess = vi.fn().mockResolvedValue({ mayUse: true, isAdmin: false });
            lab.loadEngineDeck = vi
                .fn()
                .mockResolvedValue({ missing: [], deck: { houses: ['a', 'b', 'c'], dbId: 1 } });
            lab.vaultTourService.seedDefaults = vi.fn().mockResolvedValue(0);
            lab.vaultTourService.hydrateField = vi.fn().mockResolvedValue({});
            lab.vaultTourService.rosters = vi.fn().mockResolvedValue([{ UserId: USER, DeckId: 1 }]);
            lab.vaultTourService.gamesToday = vi.fn().mockResolvedValue(new Map());
            lab.vaultTourService.drawOpponent = vi.fn().mockResolvedValue({
                uuid: 'u-a',
                name: 'Winner A',
                event: 'VT Atlanta',
                placing: 'winner',
                deck: { houses: ['a', 'b', 'c'], cards: [] }
            });
            lab.vaultTourService.recordGame = vi.fn().mockResolvedValue(undefined);
            lab.vaultTourService.noteOpponentPlayed = vi.fn().mockResolvedValue(undefined);
            lab.ariService.applyGameResult = vi.fn();
            lab.runMatch = vi.fn().mockResolvedValue({
                completed: true,
                winner: PLAYER_ONE,
                winnerKeys: 3,
                loserKeys: 1,
                turns: 20,
                winnerWentFirst: true,
                durationMs: 400,
                winnerDeck: { uuid: 'mine' },
                loserDeck: { uuid: 'u-a' }
            });
        });

        const styling = { next: () => null, model: (model) => model, active: false };

        it('plays the slate against the field and records it', async function () {
            const played = await lab.runVaultTourStep(config, { championModel: null, styling });

            expect(played).toBe(1);
            expect(lab.vaultTourService.recordGame).toHaveBeenCalledWith(
                expect.objectContaining({ userId: USER, deckId: 1, won: true })
            );
        });

        /**
         * The load-bearing refusal. ARI is the rating the whole platform prices
         * decks with; feeding it games against a hand-picked field of winners
         * would import the operator's choice of opponents into it, invisibly and
         * unfixably.
         */
        it('never moves ARI', async function () {
            await lab.runVaultTourStep(config, { championModel: null, styling });

            expect(lab.ariService.applyGameResult).not.toHaveBeenCalled();
        });

        it('never writes to the mirror record', async function () {
            await lab.runVaultTourStep(config, { championModel: null, styling });

            for (const [sql] of db.query.mock.calls) {
                expect(sql).not.toContain('INSERT INTO "ProvingGroundsGames"');
            }
        });

        it('rests a deck that has had its twelve for the day', async function () {
            lab.vaultTourService.gamesToday = vi.fn().mockResolvedValue(new Map([[1, 12]]));

            expect(await lab.runVaultTourStep(config, { championModel: null, styling })).toBe(0);
            expect(lab.runMatch).not.toHaveBeenCalled();
        });

        // The person tuning the lab has to be able to flood it.
        it('exempts a site admin from the daily cap', async function () {
            lab.rosterAccess = vi.fn().mockResolvedValue({ mayUse: true, isAdmin: true });
            lab.vaultTourService.gamesToday = vi.fn().mockResolvedValue(new Map([[1, 400]]));

            expect(await lab.runVaultTourStep(config, { championModel: null, styling })).toBe(1);
        });

        it('does nothing for a roster whose owner lost the capability', async function () {
            lab.rosterAccess = vi.fn().mockResolvedValue({ mayUse: false, isAdmin: false });

            expect(await lab.runVaultTourStep(config, { championModel: null, styling })).toBe(0);
        });

        it('does nothing when the field has no opponent for this member', async function () {
            lab.vaultTourService.drawOpponent = vi.fn().mockResolvedValue(null);

            expect(await lab.runVaultTourStep(config, { championModel: null, styling })).toBe(0);
            expect(lab.runMatch).not.toHaveBeenCalled();
        });

        it('is off when the operator switches it off', async function () {
            config.vaultTourEnabled = false;

            expect(await lab.runVaultTourStep(config, { championModel: null, styling })).toBe(0);
            expect(lab.vaultTourService.rosters).not.toHaveBeenCalled();
        });
    });

    // The property the whole Challenge stands on, extended to the Vault Tour.
    it('never touches the official games, players or rating tables', async function () {
        answer([['FROM "VaultTourGames" WHERE "UserId"', []]]);

        await service.matrixFor(USER);
        await service.slateFor(USER);
        await service.field();
        await service.gamesToday(USER);
        await service.drawOpponent(USER);
        await service.seedDefaults();

        for (const [sql] of db.query.mock.calls) {
            expect(sql).not.toMatch(/"(Games|GamePlayers|RatingHistory)"/);
        }
    });
});
