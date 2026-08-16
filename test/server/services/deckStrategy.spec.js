const AercAnalyticsService = require('../../../server/services/membership/AercAnalyticsService');

/**
 * ARCHON: what a deck is good against, and what beats it.
 *
 * The methodology is the feature. A matchup claim over three games is worse
 * than no claim, so the bar for saying anything is high and the tests are
 * mostly about the cases where the answer must be "not enough to say".
 */
describe('deck strategy profile', function () {
    let db;
    let service;
    let state;

    // Cut points that put a value of 1 in Low and 19 in Very high.
    const CUTS = { q1: 5, q2: 10, q3: 15, decks: 400 };

    beforeEach(function () {
        state = {
            deck: { Id: 7, Uuid: 'uuid-1', Name: 'Test Deck', UserId: 3 },
            record: { games: 40, wins: 20 },
            // Keyed by trait: rows the band query returns.
            bands: {}
        };

        db = {
            query: vi.fn(async (sql) => {
                if (/percentile_cont/.test(sql)) {
                    return [CUTS];
                }

                if (/SELECT "Id", "Uuid", "Name", "UserId" FROM "Decks"/.test(sql)) {
                    return state.deck ? [state.deck] : [];
                }

                if (/COUNT\(\*\)::int AS "games"/.test(sql) && !/AS "band"/.test(sql)) {
                    return [state.record];
                }

                if (/AS "band"/.test(sql)) {
                    const trait = Object.keys(state.bands).find((key) => sql.includes(key));

                    return trait ? state.bands[trait] : [];
                }

                return [];
            })
        };

        service = new AercAnalyticsService(db);
    });

    describe('matching the deck', function () {
        it('matches games by the uuid they recorded, pooling every copy', async function () {
            const deck = await service.resolveDeck(7);

            expect(deck.predicate).toBe('gp."DeckUuid" = $1');
            expect(deck.param).toBe('uuid-1');
            expect(deck.pooled).toBe(true);
        });

        it('falls back to the row for a deck with no uuid', async function () {
            // Alliance and standalone decks. Their profile covers that row
            // alone, which is the honest answer for a deck with no identity
            // beyond itself.
            state.deck = { Id: 7, Uuid: null, Name: 'Alliance Deck', UserId: 3 };

            const deck = await service.resolveDeck(7);

            expect(deck.predicate).toBe('gp."DeckId" = $1');
            expect(deck.pooled).toBe(false);
        });

        it('reaches the opponent SAS without needing their deck to still exist', async function () {
            await service.deckByOpponentTrait(await service.resolveDeck(7), 'creatureControl');

            const sql = db.query.mock.calls.map((call) => call[0]).find((s) => /AS "band"/.test(s));

            // A game against a deck its owner later deleted is still a game.
            expect(sql).toContain('COALESCE(ogp."DeckUuid", od."Uuid")');
        });
    });

    describe('what it will and will not claim', function () {
        const lopsided = () => ({
            creatureControl: [
                { band: 'Low', games: 20, wins: 16 },
                { band: 'Very high', games: 20, wins: 4 }
            ]
        });

        it('names the bands the deck over- and under-performs itself in', async function () {
            state.bands = lopsided();

            const profile = await service.deckStrategyProfile(7);

            expect(profile.goodAgainst[0]).toMatchObject({
                trait: 'creatureControl',
                band: 'Low'
            });
            expect(profile.badAgainst[0]).toMatchObject({
                trait: 'creatureControl',
                band: 'Very high'
            });
        });

        it('measures the edge against the deck itself, not against the site', async function () {
            state.bands = lopsided();

            const profile = await service.deckStrategyProfile(7);

            // 80% in the band, 50% overall.
            expect(profile.record.winRate).toBe(0.5);
            expect(profile.goodAgainst[0].winRate).toBe(0.8);
            expect(profile.goodAgainst[0].edge).toBeCloseTo(0.3, 5);
        });

        it('says nothing at all about a deck with too few games', async function () {
            state.record = { games: 4, wins: 4 };
            state.bands = lopsided();

            const profile = await service.deckStrategyProfile(7);

            expect(profile.enoughGames).toBe(false);
            expect(profile.gamesShort).toBe(6);
            expect(profile.goodAgainst).toEqual([]);
            expect(profile.badAgainst).toEqual([]);
        });

        it('ignores a band too thin to lean on, however lopsided', async function () {
            // A 100% record over two games is otherwise always the headline.
            state.bands = { creatureControl: [{ band: 'Low', games: 2, wins: 2 }] };

            const profile = await service.deckStrategyProfile(7);

            expect(profile.goodAgainst).toEqual([]);
        });

        it('ignores a difference too small to be a finding', async function () {
            // 55% against 50% overall is noise wearing a headline.
            state.bands = { creatureControl: [{ band: 'Low', games: 20, wins: 11 }] };

            const profile = await service.deckStrategyProfile(7);

            expect(profile.goodAgainst).toEqual([]);
            expect(profile.badAgainst).toEqual([]);
        });

        it('still returns the bands it will not draw a conclusion from', async function () {
            state.bands = { creatureControl: [{ band: 'Low', games: 2, wins: 2 }] };

            const profile = await service.deckStrategyProfile(7);

            // The reader can look at the table even where the summary is silent.
            const trait = profile.traits.find((entry) => entry.key === 'creatureControl');

            expect(trait.bands).toHaveLength(4);
            expect(trait.bands[0]).toMatchObject({ band: 'Low', games: 2, confident: false });
        });

        it('ranks the strongest edge first', async function () {
            state.bands = {
                creatureControl: [{ band: 'Low', games: 20, wins: 13 }],
                amberControl: [{ band: 'Low', games: 20, wins: 18 }]
            };

            const profile = await service.deckStrategyProfile(7);

            expect(profile.goodAgainst.map((entry) => entry.trait)).toEqual([
                'amberControl',
                'creatureControl'
            ]);
        });

        it('returns null for a deck that does not exist', async function () {
            state.deck = null;

            expect(await service.deckStrategyProfile(7)).toBeNull();
        });
    });
});
