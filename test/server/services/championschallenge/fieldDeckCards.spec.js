const {
    withCardData,
    toEngineCards
} = require('../../../../server/services/championschallenge/masterVault');
const {
    getCardIndex,
    cloneCard
} = require('../../../../server/services/championschallenge/packCards');
const {
    runSimulatedGame,
    PLAYER_ONE
} = require('../../../../server/services/championschallenge/SimulatedGame');
const VaultTourService = require('../../../../server/services/championschallenge/VaultTourService');
const GauntletService = require('../../../../server/services/championschallenge/GauntletService');

/**
 * ARCHON (N32): the bug this file exists to make impossible.
 *
 * The field tables store card IDS. The engine's deck builder reads `entry.card`
 * and DROPS every entry that has none (server/game/deck.js logs "Corrupt deck"
 * and moves on), so a stored deck handed straight to the engine is a legal game
 * against an EMPTY draw pile. It does not throw. It does not abandon. It plays
 * to a clean three-nothing win for whoever has cards, in about nine turns.
 *
 * Every Vault Tour and Gauntlet result was therefore 100%, and nothing anywhere
 * said why: a rigged game and a real one produce the same shape of row, and the
 * matrix rendered the lie with a percentage sign after it. The specs that
 * existed all passed, because every one of them stubbed the engine.
 *
 * So there are three guards here, deliberately overlapping:
 *
 *  1. the draw attaches card data (unit);
 *  2. a deck built the way a field table stores it LOSES EVERY GAME, and one
 *     built through withCardData does not (a real game, no stubs - this is the
 *     only kind of test that could have caught it);
 *  3. the simulator refuses a game a side cannot play, so any future path that
 *     loses card data reports 'short-deck' instead of a plausible result.
 */

/** A legal-shaped 36-card deck, as a field table would store it: ids only. */
function storedCards(houses) {
    const byHouse = {};

    for (const card of Object.values(getCardIndex())) {
        if (
            houses.includes(card.house) &&
            !card.isNonDeck &&
            ['creature', 'artifact', 'action', 'upgrade'].includes(card.type)
        ) {
            (byHouse[card.house] = byHouse[card.house] || []).push(card);
        }
    }

    const cards = [];

    for (const house of houses) {
        const pool = byHouse[house];

        for (let i = 0; i < 12; i++) {
            cards.push({ id: pool[(i * 5) % pool.length].id, count: 1 });
        }
    }

    return cards;
}

const deckOf = (name, houses, cards) => ({
    name,
    uuid: `field-${name}`,
    expansion: 341,
    houses,
    cards
});

const ALPHA_HOUSES = ['brobnar', 'dis', 'logos'];
const OMEGA_HOUSES = ['sanctum', 'shadows', 'untamed'];

describe('field decks carry their card data', function () {
    describe('withCardData', function () {
        it('attaches the card the engine needs to every stored entry', function () {
            const { cards, missing } = withCardData(storedCards(ALPHA_HOUSES));

            expect(missing).toEqual([]);
            expect(cards).toHaveLength(36);
            expect(cards.every((entry) => entry.card && entry.card.id === entry.id)).toBe(true);
        });

        it('keeps what the stored entry said about the card', function () {
            const [first] = storedCards(ALPHA_HOUSES);
            const { cards } = withCardData([
                { ...first, count: 2, maverick: 'untamed', enhancements: ['amber'] }
            ]);

            expect(cards[0].count).toBe(2);
            expect(cards[0].maverick).toBe('untamed');
            expect(cards[0].enhancements).toEqual(['amber']);
        });

        it('reports a card this build has no data for rather than dropping it quietly', function () {
            const { cards, missing } = withCardData([
                { id: 'a-card-that-was-never-printed', count: 1 }
            ]);

            expect(missing).toEqual(['a-card-that-was-never-printed']);
            expect(cards).toEqual([]);
        });

        it('is what toEngineCards does NOT do - the stored shape is ids only', function () {
            // Not a redundant assertion: it pins the reason this module exists.
            // The moment toEngineCards starts inlining card data, storage grows
            // by two orders of magnitude and freezes at fetch time, and whoever
            // makes that change should have to change this line to do it.
            const { cards } = toEngineCards([{ id: storedCards(ALPHA_HOUSES)[0].id, count: 1 }]);

            expect(cards[0].card).toBeUndefined();
        });
    });

    // Real games. Slow (a few seconds each), few on purpose, and the only test
    // in the suite that could have caught the original bug: everything else
    // stubs runMatch, and a stub cannot tell an empty deck from a bad one.
    describe('a real game', function () {
        it('is a walkover when the opponent is built the way the row stores it', async function () {
            const alpha = deckOf(
                'alpha',
                ALPHA_HOUSES,
                withCardData(storedCards(ALPHA_HOUSES)).cards
            );
            const omega = deckOf('omega', OMEGA_HOUSES, storedCards(OMEGA_HOUSES));
            const result = await runSimulatedGame(alpha, omega, { seed: 4242 });

            // The guard catches it now. Before the guard this returned a normal
            // completed game: winner alpha, three keys to nothing.
            expect(result.completed).toBe(false);
            expect(result.reason).toBe('short-deck');
            expect(result.deckSize).toBe(0);
        }, 60000);

        it('is a contest when both sides went through withCardData', async function () {
            const alpha = deckOf(
                'alpha',
                ALPHA_HOUSES,
                withCardData(storedCards(ALPHA_HOUSES)).cards
            );
            const omega = deckOf(
                'omega',
                OMEGA_HOUSES,
                withCardData(storedCards(OMEGA_HOUSES)).cards
            );
            const result = await runSimulatedGame(alpha, omega, { seed: 4242 });

            expect(result.completed).toBe(true);
            expect(result.winReason).toBe('keys');
            expect([PLAYER_ONE, 'challenger-omega']).toContain(result.winner);
            // The tell. Every rigged game ended 3-0 in under a dozen turns
            // because one side never played a card.
            expect(result.turns).toBeGreaterThan(9);
        }, 60000);
    });

    describe('the Vault Tour draw', function () {
        const configService = { getValue: () => ({}) };
        const settingsService = {
            getSectionWithDefaults: () => ({ enabled: true, vaultTourEnabled: true }),
            getSection: () => ({})
        };

        it('hands the engine cards, not ids', async function () {
            const stored = storedCards(OMEGA_HOUSES);
            const db = {
                query: vi.fn(async (sql) =>
                    sql.includes('FROM "VaultTourDecks"') && sql.startsWith('SELECT')
                        ? [
                              {
                                  Uuid: 'deck-1',
                                  Name: 'A Tournament Winner',
                                  Expansion: 341,
                                  Houses: OMEGA_HOUSES.join(','),
                                  Cards: JSON.stringify(stored),
                                  Event: 'Vault Tour Atlanta',
                                  Placing: 'winner'
                              }
                          ]
                        : []
                )
            };
            const service = new VaultTourService(configService, db, settingsService);
            const opponent = await service.drawOpponent(7);

            expect(opponent.deck.cards).toHaveLength(36);
            expect(opponent.deck.cards.every((entry) => entry.card)).toBe(true);
        });

        it('withdraws a deck this build can no longer assemble', async function () {
            const db = {
                query: vi.fn(async (sql) =>
                    sql.includes('FROM "VaultTourDecks"') && sql.startsWith('SELECT')
                        ? [
                              {
                                  Uuid: 'deck-2',
                                  Name: 'Made Of Cards We Lost',
                                  Expansion: 341,
                                  Houses: OMEGA_HOUSES.join(','),
                                  Cards: JSON.stringify([{ id: 'never-printed', count: 1 }]),
                                  Event: 'Vault Tour Atlanta',
                                  Placing: 'winner'
                              }
                          ]
                        : []
                )
            };
            const service = new VaultTourService(configService, db, settingsService);

            // No opponent is the right answer: a deck that cannot be built is
            // not an opponent that loses.
            expect(await service.drawOpponent(7)).toBeNull();

            const withdrawn = db.query.mock.calls.filter(([sql]) =>
                sql.includes('SET "Playable" = false')
            );

            expect(withdrawn).toHaveLength(1);
            expect(withdrawn[0][1]).toEqual(['deck-2', 'never-printed']);
        });
    });

    describe('the Gauntlet draw', function () {
        const configService = { getValue: () => ({}) };
        const settingsService = {
            getSectionWithDefaults: () => ({ enabled: true, gauntletEnabled: true }),
            getSection: () => ({})
        };

        it('hands the engine cards, not ids', async function () {
            const stored = storedCards(OMEGA_HOUSES);
            const db = {
                query: vi.fn(async (sql) =>
                    sql.includes('ORDER BY g."LastPlayedAt"')
                        ? [
                              {
                                  Uuid: 'pool-1',
                                  Name: 'A Stranger’s Deck',
                                  Expansion: 341,
                                  Houses: OMEGA_HOUSES.join(','),
                                  Cards: JSON.stringify(stored),
                                  SasRating: 70
                              }
                          ]
                        : []
                )
            };
            const service = new GauntletService(configService, db, settingsService);
            const opponent = await service.drawOpponent(7, {
                sets: [],
                houses: [],
                strategies: [],
                minSas: null,
                maxSas: null
            });

            expect(opponent.deck.cards).toHaveLength(36);
            expect(opponent.deck.cards.every((entry) => entry.card)).toBe(true);
        });
    });

    describe('the simulator', function () {
        it('refuses a side that has no deck instead of playing it', async function () {
            const alpha = deckOf(
                'alpha',
                ALPHA_HOUSES,
                withCardData(storedCards(ALPHA_HOUSES)).cards
            );
            const empty = deckOf('empty', OMEGA_HOUSES, []);
            const result = await runSimulatedGame(alpha, empty, { seed: 11 });

            expect(result.completed).toBe(false);
            expect(result.reason).toBe('short-deck');
            expect(result.shortSide).toBe('challenger-omega');
        }, 60000);

        it('names the short side, whichever seat it is', async function () {
            const half = withCardData(storedCards(ALPHA_HOUSES)).cards.slice(0, 10);
            const alpha = deckOf('alpha', ALPHA_HOUSES, half);
            const omega = deckOf(
                'omega',
                OMEGA_HOUSES,
                withCardData(storedCards(OMEGA_HOUSES)).cards
            );
            const result = await runSimulatedGame(alpha, omega, { seed: 12 });

            expect(result.completed).toBe(false);
            expect(result.reason).toBe('short-deck');
            expect(result.shortSide).toBe(PLAYER_ONE);
            expect(result.deckSize).toBe(10);
        }, 60000);
    });

    it('the pack index can still build a card, which everything above assumes', function () {
        const [entry] = storedCards(ALPHA_HOUSES);

        expect(cloneCard(entry.id)).toBeTruthy();
    });
});
