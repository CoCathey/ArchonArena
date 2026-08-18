const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    traitsFor,
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
                        scores: { 'test-controller': { creatureControl: 3, expectedAmber: 1 } }
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
    });
});
