const { profileDeck, AXES } = require('../../../../server/services/championschallenge/deckProfile');
const { getCardIndex } = require('../../../../server/services/championschallenge/packCards');
const { STRATEGIES } = require('../../../../server/services/championschallenge/GauntletService');

/**
 * ARCHON (N30): reading a deck from its own cards.
 *
 * The Gauntlet's strategy filters were computed entirely from Decks of
 * KeyForge's AERC breakdown, which made the most configurable part of the
 * feature depend on somebody else's key: no key, no enrichment, no strategy
 * filter, and a pool that answered every strategy with "no opponents" while
 * looking perfectly healthy.
 *
 * Two things need pinning, and the second is the one that matters.
 *
 * The reading has to mean something - "steal" is amber control, "destroy a
 * friendly creature" is not removal - which is what the first group checks
 * against real cards from the real pack data.
 *
 * And the THRESHOLDS have to select a minority. A filter that matches every deck
 * and a filter that matches none are equally useless, and both fail silently:
 * one hands you the whole pool, the other tells you there are no opponents. So
 * the last test assembles hundreds of decks out of the real card pool and
 * measures what share each strategy actually admits. It is the only test here
 * that could catch a scale drifting after a set release.
 */
describe('reading a deck from its cards', function () {
    const index = getCardIndex();

    // A deck is a list of ids; count defaults to one.
    const deckOf = (...ids) => ids.map((id) => ({ id, count: 1 }));

    describe('what it reads', function () {
        it('counts printed amber as expected amber', function () {
            // Two cards with amber bonus icons, taken from the pack data itself
            // so the test cannot drift from what the engine plays.
            const withAmber = Object.values(index)
                .filter((card) => (card.amber || 0) > 0 && !card.isNonDeck)
                .slice(0, 2);
            const profile = profileDeck(deckOf(...withAmber.map((card) => card.id)), index);

            expect(profile.expectedAmber).toBeGreaterThanOrEqual(
                withAmber.reduce((sum, card) => sum + card.amber, 0)
            );
        });

        it('counts creature power and armour as effective power', function () {
            const creature = Object.values(index).find(
                (card) => card.type === 'creature' && card.power > 0
            );
            const profile = profileDeck(deckOf(creature.id), index);

            expect(profile.effectivePower).toBe((creature.power || 0) + (creature.armor || 0));
        });

        it('multiplies by how many copies the deck holds', function () {
            const creature = Object.values(index).find(
                (card) => card.type === 'creature' && card.power > 0
            );
            const one = profileDeck([{ id: creature.id, count: 1 }], index);
            const three = profileDeck([{ id: creature.id, count: 3 }], index);

            expect(three.effectivePower).toBe(one.effectivePower * 3);
        });

        it('reads stealing as amber control', function () {
            const thief = Object.values(index).find((card) => /\bsteal\b/i.test(card.text || ''));

            expect(profileDeck(deckOf(thief.id), index).amberControl).toBeGreaterThan(0);
        });

        /**
         * The reason matching happens per clause rather than per card: one card
         * routinely does a friendly thing and an unfriendly thing in two
         * sentences, and "destroy a friendly creature" is not removal.
         */
        it('does not count destroying your own creature as removal', function () {
            const friendly = {
                id: 'sacrifice',
                type: 'action',
                text: 'Play: Destroy a friendly creature.'
            };
            const enemy = {
                id: 'removal',
                type: 'action',
                text: 'Play: Destroy an enemy creature.'
            };
            const cards = { sacrifice: friendly, removal: enemy };

            expect(profileDeck(deckOf('sacrifice'), cards).creatureControl).toBe(0);
            expect(profileDeck(deckOf('removal'), cards).creatureControl).toBe(1);
        });

        it('does not count the opponent drawing as your efficiency', function () {
            const cards = {
                mine: { id: 'mine', type: 'action', text: 'Play: Draw 2 cards.' },
                theirs: {
                    id: 'theirs',
                    type: 'action',
                    text: 'Play: Your opponent draws 3 cards.'
                }
            };

            expect(profileDeck(deckOf('mine'), cards).efficiency).toBe(1);
            expect(profileDeck(deckOf('theirs'), cards).efficiency).toBe(0);
        });

        it('counts discard as disruption only when it is aimed at them', function () {
            const cards = {
                cost: { id: 'cost', type: 'action', text: 'Play: Discard a card. Gain 2.' },
                attack: {
                    id: 'attack',
                    type: 'action',
                    text: 'Play: Your opponent discards a random card.'
                }
            };

            expect(profileDeck(deckOf('cost'), cards).disruption).toBe(0);
            expect(profileDeck(deckOf('attack'), cards).disruption).toBe(1);
        });

        it('reports every axis, always', function () {
            const profile = profileDeck(deckOf(Object.keys(index)[0]), index);

            expect(Object.keys(profile).sort()).toEqual([...AXES].sort());
        });

        it('says nothing rather than zero for a list it cannot read', function () {
            expect(profileDeck([], index)).toBeNull();
            expect(profileDeck(null, index)).toBeNull();
            expect(profileDeck(deckOf('not-a-real-card'), index)).toBeNull();
        });
    });

    /**
     * The calibration. Decks are assembled from the real card pool - three
     * houses, twelve cards each, the shape of a real deck - and every strategy
     * has to admit a minority of them.
     *
     * The band is wide on purpose: this is a coarse reading and the point is only
     * that a filter DISCRIMINATES. Outside it, the filter is broken in one of the
     * two ways nobody notices - "every deck matches" or "no decks match" both
     * look like a working filter from the outside.
     */
    describe('the thresholds discriminate', function () {
        const build = (seed0) => {
            let seed = seed0;
            const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
            const byHouse = {};

            for (const card of Object.values(index)) {
                if (
                    card.isNonDeck ||
                    !['creature', 'artifact', 'action', 'upgrade'].includes(card.type)
                ) {
                    continue;
                }

                (byHouse[card.house] = byHouse[card.house] || []).push(card);
            }

            const houses = Object.keys(byHouse).filter((house) => byHouse[house].length >= 12);
            const decks = [];

            for (let deck = 0; deck < 300; deck++) {
                const picked = [...houses].sort(() => rnd() - 0.5).slice(0, 3);
                const cards = [];

                for (const house of picked) {
                    for (let i = 0; i < 12; i++) {
                        const pool = byHouse[house];

                        cards.push({ id: pool[Math.floor(rnd() * pool.length)].id, count: 1 });
                    }
                }

                decks.push(profileDeck(cards, index));
            }

            return decks;
        };

        const decks = build(999);

        for (const [key, strategy] of Object.entries(STRATEGIES)) {
            it(`${key} admits some decks and refuses others`, function () {
                const passing = decks.filter((profile) =>
                    strategy.fields.every(
                        (field) => profile[field] >= strategy.localThresholds[field]
                    )
                ).length;
                const share = passing / decks.length;

                expect(share, `${key} admits ${Math.round(share * 100)}% of decks`).toBeGreaterThan(
                    0.05
                );
                expect(share).toBeLessThan(0.6);
            });
        }

        // The two scales measure different things on different ranges and must
        // never be compared to each other; a strategy missing either set of bars
        // would silently filter on the wrong one.
        it('keeps a local bar for every field it filters on', function () {
            for (const strategy of Object.values(STRATEGIES)) {
                for (const field of strategy.fields) {
                    expect(typeof strategy.thresholds[field]).toBe('number');
                    expect(typeof strategy.localThresholds[field]).toBe('number');
                }
            }
        });
    });
});
