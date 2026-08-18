const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    traitsFor,
    synergiesFor,
    resetCache,
    TRAITS_FILE,
    AXES
} = require('../../../../server/services/championschallenge/cardTraits');
const { actionFeatures } = require('../../../../server/services/championschallenge/labFeatures');

// ARCHON (N43): the AERC-style axes - the file, the scaling, and the graded
// card:ax:* features they become. The contracts: a missing file means no
// axis features (never a crash), zeros are omitted per the sparse
// convention, and scores clamp into the 0-4 scale they were asked for.

describe('cardTraits', function () {
    let dir;
    let file;

    const writeTraits = (scores) =>
        fs.writeFileSync(file, JSON.stringify({ version: 1, axes: AXES, scores }));

    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-traits-'));
        file = path.join(dir, 'cardTraits.json');
        resetCache();
    });

    afterEach(function () {
        resetCache();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    describe('the loader', function () {
        it('a missing file or unknown card is null, not an error', function () {
            expect(traitsFor('krump', path.join(dir, 'nope.json'))).toBeNull();

            writeTraits({ krump: { creatureControl: 2 } });
            expect(traitsFor('stranger', file)).toBeNull();
            expect(traitsFor(null, file)).toBeNull();
        });

        it('scales 0-4 scores to [0, 1], clamps, and omits zeros', function () {
            writeTraits({
                bomb: {
                    expectedAmber: 2,
                    amberControl: 0,
                    creatureControl: 4,
                    artifactControl: 9,
                    efficiency: 'garbage',
                    disruption: 0.5
                }
            });

            const traits = traitsFor('bomb', file);

            expect(traits.expectedAmber).toBeCloseTo(0.5, 10);
            expect(traits.creatureControl).toBe(1);
            expect(traits.artifactControl).toBe(1);
            expect(traits.disruption).toBeCloseTo(0.125, 10);
            expect(traits.amberControl).toBeUndefined();
            expect(traits.efficiency).toBeUndefined();
        });

        it('a card that does nothing on any axis is null, same as unknown', function () {
            writeTraits({ vanilla: { expectedAmber: 0, creatureControl: 0 } });

            expect(traitsFor('vanilla', file)).toBeNull();
        });

        it('reads synergy lists, drops tags outside the vocabulary', function () {
            writeTraits({
                payoff: { wants: ['capture', 'notATag'], provides: [] },
                enabler: { provides: ['capture'] },
                vanilla: { expectedAmber: 1 }
            });

            expect(synergiesFor('payoff', file)).toEqual({ provides: [], wants: ['capture'] });
            expect(synergiesFor('enabler', file).provides).toEqual(['capture']);
            expect(synergiesFor('vanilla', file)).toBeNull();
            expect(synergiesFor('stranger', file)).toBeNull();
        });
    });

    /**
     * The features: axis values ride into every candidate whose card has
     * them. These write the REAL traits file location (the repo ships
     * without one until the job runs), so they clean up after themselves.
     */
    describe('graded card features', function () {
        let hadRealFile;

        beforeEach(function () {
            hadRealFile = fs.existsSync(TRAITS_FILE);

            if (!hadRealFile) {
                fs.mkdirSync(path.dirname(TRAITS_FILE), { recursive: true });
                fs.writeFileSync(
                    TRAITS_FILE,
                    JSON.stringify({
                        version: 1,
                        scores: {
                            'test-controller': { creatureControl: 3, expectedAmber: 1 },
                            'combo-payoff': { wants: ['capture'] },
                            'combo-enabler': { provides: ['capture'] }
                        }
                    })
                );
            }

            resetCache();
        });

        afterEach(function () {
            if (!hadRealFile) {
                fs.rmSync(TRAITS_FILE, { force: true });
            }

            resetCache();
        });

        it('a scored card carries its axes; an unscored card carries none', function () {
            if (hadRealFile) {
                // A generated file is present; assert against a card we can
                // rely on existing in it instead of planting a fixture.
                return;
            }

            const { features } = actionFeatures({
                kind: 'playAction',
                card: { id: 'test-controller', cardData: {} }
            });

            expect(features['card:ax:creatureControl']).toBeCloseTo(0.75, 10);
            expect(features['card:ax:expectedAmber']).toBeCloseTo(0.25, 10);
            expect(features['card:ax:disruption']).toBeUndefined();

            const plain = actionFeatures({
                kind: 'playAction',
                card: { id: 'never-scored', cardData: {} }
            });

            expect(Object.keys(plain.features).filter((key) => key.startsWith('card:ax:'))).toEqual(
                []
            );
        });

        it('a payoff lights differently for a landed partner and a waiting one', function () {
            if (hadRealFile) {
                return;
            }

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
            const payoff = { id: 'combo-payoff', cardData: {} };
            const play = (seat) =>
                actionFeatures({ kind: 'playAction', card: payoff, player: seat }).features;

            // The enabler has landed: cash in.
            const landed = play(player({ cardsInPlay: [{ id: 'combo-enabler' }] }));

            expect(landed['card:syn:board']).toBeCloseTo(0.5, 10);
            expect(landed['card:syn:hand']).toBeUndefined();

            // The enabler is still in hand: the combo exists but has not
            // landed - the sequencing signal.
            const waiting = play(player({ hand: [{ id: 'combo-enabler' }, payoff] }));

            expect(waiting['card:syn:hand']).toBeCloseTo(0.5, 10);
            expect(waiting['card:syn:board']).toBeUndefined();

            // A card is not its own combo partner, and no partner anywhere
            // means no signal at all.
            const alone = play(player({ hand: [payoff] }));

            expect(alone['card:syn:board']).toBeUndefined();
            expect(alone['card:syn:hand']).toBeUndefined();
        });
    });
});
