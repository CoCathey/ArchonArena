const {
    winProbabilityCurve,
    viewFromFrame,
    findMoments,
    SWING_THRESHOLD
} = require('../../../../server/services/membership/replayValue');
const {
    stateFeatures,
    stateFeaturesFrom
} = require('../../../../server/services/championschallenge/labFeatures');
const { emptyModel } = require('../../../../server/services/championschallenge/labPolicy');

/**
 * ARCHON (N26): the win-probability curve over a real game.
 *
 * The load-bearing test in this file is the FIRST one. A value model's weights
 * are meaningless against features scaled differently from the ones it trained
 * on, and the two inputs here - a live engine position and the recording of that
 * same position - are different shapes of the same facts. Get the adapter wrong
 * and the site ships a confident-looking graph of nothing, with no error
 * anywhere and no way for a reader to tell.
 *
 * So parity is asserted directly: build a live position, build the frame a
 * recording of it would hold, and require identical features. (The production
 * safeguard is stronger than the test - both paths call one
 * `stateFeaturesFrom` - but a future refactor that splits them would be caught
 * here rather than in a member's replay page.)
 */
describe('replay win probability', function () {
    // A live engine player, reduced to what the feature extractor touches.
    const livePlayer = ({
        name,
        amber = 0,
        keys = 0,
        keyCost = 6,
        creatures = [],
        artifacts = 0,
        hand = 0,
        archives = 0,
        deck = 0
    }) => ({
        name,
        amber,
        getForgedKeys: () => keys,
        getCurrentKeyCost: () => keyCost,
        creaturesInPlay: creatures,
        cardsInPlay: [
            ...creatures,
            ...Array.from({ length: artifacts }, () => ({ type: 'artifact' }))
        ],
        hand: Array.from({ length: hand }, () => ({})),
        archives: Array.from({ length: archives }, () => ({})),
        deck: Array.from({ length: deck }, () => ({}))
    });

    // The same position as a recording holds it: printed values in the shared
    // card table, per-frame overrides beside them, piles as counts.
    const frameSeat = ({
        name,
        amber = 0,
        keys = 0,
        keyCost = 6,
        inPlay = [],
        hand = 0,
        archives = 0,
        deck = 0
    }) => ({
        name,
        stats: { amber, keys, keyCost },
        numHandCards: hand,
        numDeckCards: deck,
        cardPiles: {
            cardsInPlay: inPlay,
            archives: Array.from({ length: archives }, () => 0),
            discard: [],
            purged: []
        }
    });

    describe('feature parity with the live game', function () {
        it('reads a recorded frame exactly as the engine reads the position', function () {
            const cards = [
                { id: 'big', type: 'creature', power: 7 },
                { id: 'small', type: 'creature', power: 2 },
                { id: 'thing', type: 'artifact' }
            ];

            // Live: my board is a ready 7-power and an exhausted 2-power whose
            // power an effect has raised to 5, plus an artifact.
            const me = livePlayer({
                name: 'me',
                amber: 5,
                keys: 1,
                keyCost: 7,
                creatures: [
                    { power: 7, exhausted: false, type: 'creature' },
                    { power: 5, exhausted: true, type: 'creature' }
                ],
                artifacts: 1,
                hand: 4,
                archives: 2,
                deck: 20
            });
            const them = livePlayer({
                name: 'them',
                amber: 3,
                keys: 2,
                keyCost: 6,
                creatures: [{ power: 4, exhausted: false, type: 'creature' }],
                hand: 6,
                deck: 15
            });

            me.opponent = them;
            them.opponent = me;

            const live = stateFeatures({ round: 9 }, me);

            const frame = {
                round: 9,
                players: [
                    frameSeat({
                        name: 'me',
                        amber: 5,
                        keys: { red: true },
                        keyCost: 7,
                        inPlay: [
                            { card: 0 },
                            // The effect-modified power, recorded per frame.
                            { card: 1, exhausted: true, power: 5 },
                            { card: 2 }
                        ],
                        hand: 4,
                        archives: 2,
                        deck: 20
                    }),
                    frameSeat({
                        name: 'them',
                        amber: 3,
                        keys: { red: true, blue: true },
                        keyCost: 6,
                        inPlay: [{ card: 1, power: 4 }],
                        hand: 6,
                        deck: 15
                    })
                ]
            };
            const recorded = stateFeaturesFrom(viewFromFrame(frame, cards, 'me'));

            expect(recorded).toEqual(live);
        });

        it('falls back to printed power when no effect changed it', function () {
            const cards = [{ id: 'big', type: 'creature', power: 7 }];
            const view = viewFromFrame(
                {
                    round: 1,
                    players: [frameSeat({ name: 'me', inPlay: [{ card: 0 }] })]
                },
                cards,
                'me'
            );

            expect(view.me.creatures).toEqual([{ power: 7, exhausted: false }]);
        });

        it('counts a per-colour key map the way the engine counts keys', function () {
            const view = viewFromFrame(
                {
                    round: 1,
                    players: [
                        frameSeat({ name: 'me', keys: { red: true, blue: false, yellow: true } })
                    ]
                },
                [],
                'me'
            );

            expect(view.me.keys).toBe(2);
        });

        it('says nothing when the seat is not in the frame', function () {
            expect(viewFromFrame({ players: [frameSeat({ name: 'them' })] }, [], 'me')).toBeNull();
        });
    });

    describe('the curve', function () {
        const model = { ...emptyModel(), weights: { 's:amberDiff': 4, 's:keyDiff': 6 } };

        const growingGame = () => ({
            snapshots: [0, 1, 2, 3].map((step) => ({
                messageIndex: step * 10,
                board: {
                    round: step + 1,
                    players: [
                        frameSeat({ name: 'me', amber: step * 2 }),
                        frameSeat({ name: 'them', amber: 0 })
                    ]
                }
            })),
            cards: []
        });

        it('scores every frame from the named seat', async function () {
            const curve = winProbabilityCurve(growingGame(), model, 'me');

            expect(curve.available).toBe(true);
            expect(curve.seat).toBe('me');
            expect(curve.points).toHaveLength(4);
            // My amber lead grows, so the curve rises - the model was given a
            // positive weight on exactly that.
            expect(curve.points[3].winProbability).toBeGreaterThan(curve.points[0].winProbability);
            // Every point carries the frame it belongs to, so the UI can jump.
            expect(curve.points[2].messageIndex).toBe(20);
        });

        it('reads the same game the other way round from the other seat', function () {
            const mine = winProbabilityCurve(growingGame(), model, 'me');
            const theirs = winProbabilityCurve(growingGame(), model, 'them');

            expect(theirs.points[3].winProbability).toBeLessThan(mine.points[3].winProbability);
        });

        // The honest refusal: no model, no curve. A heuristic stand-in would be
        // indistinguishable from a trained one to a reader.
        it('refuses rather than inventing a curve without a model', function () {
            const curve = winProbabilityCurve(growingGame(), null, 'me');

            expect(curve.available).toBe(false);
            expect(curve.reason).toMatch(/not been trained/i);
        });

        it('refuses a recording with no board frames', function () {
            expect(winProbabilityCurve({ snapshots: [] }, model, 'me').available).toBe(false);
            expect(winProbabilityCurve({}, model, 'me').available).toBe(false);
        });

        it('refuses a recording with a single frame, which is not a curve', function () {
            const one = { snapshots: [growingGame().snapshots[0]], cards: [] };

            expect(winProbabilityCurve(one, model, 'me').available).toBe(false);
        });

        it('carries the model version, so a reader knows what read their game', function () {
            const curve = winProbabilityCurve(growingGame(), { ...model, version: 7 }, 'me');

            expect(curve.modelVersion).toBe(7);
        });
    });

    describe('the moments', function () {
        const point = (messageIndex, winProbability, round = 1) => ({
            messageIndex,
            round,
            winProbability
        });

        it('flags a drop worth pointing at', function () {
            const moments = findMoments([point(0, 0.8), point(10, 0.5, 4)]);

            expect(moments).toHaveLength(1);
            expect(moments[0].before).toBe(0.8);
            expect(moments[0].after).toBe(0.5);
            expect(moments[0].swing).toBeCloseTo(0.3, 6);
            expect(moments[0].round).toBe(4);
        });

        it('ignores ordinary drift', function () {
            expect(findMoments([point(0, 0.5), point(10, 0.5 - SWING_THRESHOLD / 2)])).toEqual([]);
        });

        // A rise is not a moment worth reviewing from this seat - it is the
        // opponent's moment, and this curve belongs to one player.
        it('does not flag the position improving', function () {
            expect(findMoments([point(0, 0.3), point(10, 0.9)])).toEqual([]);
        });

        it('reports the sharpest first and caps the list', function () {
            const points = [point(0, 1)];

            // Ten successive collapses; a list of ten is a list of none.
            for (let i = 1; i <= 10; i++) {
                points.push(point(i * 10, 1 - i * 0.09));
            }

            const moments = findMoments(points);

            expect(moments.length).toBeLessThanOrEqual(5);

            for (let i = 1; i < moments.length; i++) {
                expect(moments[i - 1].swing).toBeGreaterThanOrEqual(moments[i].swing);
            }
        });
    });
});
