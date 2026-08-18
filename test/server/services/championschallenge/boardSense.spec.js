const {
    stateFeaturesFrom,
    seatView,
    actionFeatures
} = require('../../../../server/services/championschallenge/labFeatures');
const { ROLES, rolesIndex } = require('../../../../server/services/membership/cardKnowledge');
const { seatViewFromFrame } = require('../../../../server/services/membership/replayValue');

/**
 * ARCHON (N41): board sense - the facts the model could not see.
 *
 * Three blindnesses, each pinned: board QUALITY (eight tokens and one giant
 * summed the same), captured amber (bounty on their board, liability on
 * ours, invisible in the pools), and the wipe waiting in hand (the ordering
 * question every turn asks, identical states to every non-wipe candidate).
 * Plus the two contracts every feature must honor: an old view without the
 * new facts reads as zero, and a recorded frame reads like the live game.
 */
describe('board sense (N41)', function () {
    const creature = (power, overrides = {}) => ({ power, exhausted: false, ...overrides });
    const view = (mine, theirs) => ({
        round: 5,
        me: { amber: 2, keys: 0, keyCost: 6, creatures: mine, hand: 4, deck: 20 },
        them: { amber: 2, keys: 0, keyCost: 6, creatures: theirs, hand: 4, deck: 20 }
    });

    describe('quality and bounty features', function () {
        it('sees the giant a token swarm was hiding', function () {
            const swarm = stateFeaturesFrom(view([creature(1), creature(1), creature(1)], []));
            const giant = stateFeaturesFrom(view([creature(3)], [creature(12)]));

            expect(swarm.myMaxPower).toBeCloseTo(1 / 12, 10);
            expect(giant.myMaxPower).toBeCloseTo(3 / 12, 10);
            expect(giant.oppMaxPower).toBe(1);
        });

        it('counts amber on creatures, both the bounty and the liability', function () {
            const features = stateFeaturesFrom(
                view(
                    [creature(2, { amber: 1 })],
                    [creature(4, { amber: 3 }), creature(1, { amber: 2 })]
                )
            );

            expect(features.myCapturedAmber).toBeCloseTo(1 / 6, 10);
            expect(features.oppCapturedAmber).toBeCloseTo(5 / 6, 10);
        });

        it('an old view without the new facts reads as zero, not a crash', function () {
            const features = stateFeaturesFrom(view([{ power: 4, exhausted: false }], []));

            expect(features.myCapturedAmber).toBe(0);
            expect(features.oppCapturedAmber).toBe(0);
            expect(features.oppMaxPower).toBe(0);
        });
    });

    describe('the two view builders agree', function () {
        it('the engine seat carries token amber', function () {
            const player = {
                amber: 3,
                hand: [],
                cardsInPlay: [],
                creaturesInPlay: [
                    { power: 5, exhausted: false, tokens: { amber: 2 } },
                    { power: 2, exhausted: true, tokens: {} }
                ],
                archives: [],
                deck: [],
                discard: [],
                getForgedKeys: () => 0,
                getCurrentKeyCost: () => 6
            };

            expect(seatView(player).creatures.map((c) => c.amber)).toEqual([2, 0]);
        });

        it('a recorded frame carries it too, and a frame without tokens degrades to zero', function () {
            const cards = [{ id: 'guard', type: 'creature', power: 4 }];
            const seat = (inPlay) =>
                seatViewFromFrame(
                    {
                        name: 'me',
                        stats: { amber: 0, keys: 0, keyCost: 6 },
                        numHandCards: 0,
                        numDeckCards: 0,
                        cardPiles: { cardsInPlay: inPlay, archives: [], discard: [] }
                    },
                    cards
                );

            expect(seat([{ card: 0, tokens: { amber: 3 } }]).creatures[0].amber).toBe(3);
            expect(seat([{ card: 0 }]).creatures[0].amber).toBe(0);
        });
    });

    describe('the wipe-in-hand and bounty contexts', function () {
        // A REAL wipe from the platform's own classifier, so the context is
        // tested against the index the game will actually consult.
        const wipeId = [...rolesIndex().entries()].find(([, roles]) =>
            roles.has(ROLES.BOARD_WIPE)
        )[0];

        const player = (overrides = {}) => ({
            name: 'me',
            amber: 0,
            hand: [],
            cardsInPlay: [],
            creaturesInPlay: [],
            archives: [],
            deck: [],
            discard: [],
            getForgedKeys: () => 0,
            getCurrentKeyCost: () => 6,
            opponent: null,
            ...overrides
        });

        it('holding a wipe crosses into every other candidate', function () {
            const holding = player({ hand: [{ id: wipeId }] });
            const { features } = actionFeatures({ kind: 'playCreature', player: holding });

            expect(features['x:playCreature:wipeInHand']).toBe(1);

            const empty = actionFeatures({ kind: 'playCreature', player: player() });

            expect(empty.features['x:playCreature:wipeInHand']).toBeUndefined();
        });

        it('a bounty on their board crosses into the fight', function () {
            const opponent = player({
                name: 'them',
                creaturesInPlay: [{ power: 3, exhausted: false, tokens: { amber: 2 } }]
            });
            const me = player({ opponent });
            const { features } = actionFeatures({ kind: 'fight', player: me });

            expect(features['x:fight:bountyOnBoard']).toBe(1);

            opponent.creaturesInPlay[0].tokens = {};
            expect(
                actionFeatures({ kind: 'fight', player: me }).features['x:fight:bountyOnBoard']
            ).toBeUndefined();
        });

        it('a stand-in seat with no hand and no opponent is calm, not a crash', function () {
            const { features } = actionFeatures({ kind: 'reap', player: { name: 'skeleton' } });

            expect(features['x:reap:wipeInHand']).toBeUndefined();
            expect(features['x:reap:bountyOnBoard']).toBeUndefined();
        });
    });
});
