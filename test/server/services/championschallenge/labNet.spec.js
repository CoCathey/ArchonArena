const {
    trainModel,
    emptyModel,
    scoreDecision,
    scoreLinear,
    linearLogit,
    DENSE_LAYOUT
} = require('../../../../server/services/championschallenge/labPolicy');
const {
    cloneNet,
    denseInput,
    denseLayout,
    emptyNet,
    forward,
    netScore
} = require('../../../../server/services/championschallenge/labNet');
const {
    STATE_KEYS,
    ACTION_KINDS,
    ACTION_CONTEXTS_KEYS
} = require('../../../../server/services/championschallenge/labFeatures');
const { REGISTRY } = require('../../../../server/services/settings/registry');

/**
 * ARCHON (N53): a model that can learn its own crosses.
 *
 * The claim this rests on is a provable one, and it is worth stating as a test
 * rather than as a paragraph: a LINEAR model cannot rank two candidates by
 * anything about the position they share. Every candidate at one decision
 * carries the same state, so the state's contribution is identical across them
 * and cancels out of the ranking entirely - which is why "not this card, not
 * here" has had to be hand-written as a crossed feature every time somebody
 * wanted the model to know it (N42, N43, N45, N46).
 *
 * So the first test plants exactly that shape of signal and shows the linear
 * model at chance on it. If that ever passes for the linear model, something
 * about the feature pipeline has changed and this whole module is unnecessary.
 */

/** A decision record shaped as `labFeatures.decisionRecord` emits them. */
function record(amber, kind, side) {
    return {
        state: { bias: 1, myAmber: amber, oppAmber: 0.3, myCreatures: 0.4, turn: 0.3 },
        action: { [`a:act:${kind}`]: 1, [`x:${kind}:noEnemy`]: 1 },
        cardId: null,
        side
    };
}

/** Rich in amber, reaping is right; poor, fighting is. */
const rightMove = (amber) => (amber > 0.5 ? 'reap' : 'fight');

function plantedGames(count) {
    let state = 12345;
    const random = () => {
        state = (state + 0x6d2b79f5) >>> 0;

        let t = state;

        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const games = [];

    for (let i = 0; i < count; i++) {
        const amber = random();
        const kind = random() < 0.5 ? 'reap' : 'fight';

        games.push({
            winnerSide: 'winner',
            decisions: [record(amber, kind, kind === rightMove(amber) ? 'winner' : 'loser')]
        });
    }

    return games;
}

/** Given both moves from one position, how often is the better one preferred? */
function rankingAccuracy(model, samples = 1000) {
    let right = 0;

    for (let i = 0; i < samples; i++) {
        const amber = (i + 0.5) / samples;
        const reap = scoreDecision(model, record(amber, 'reap', 'winner'));
        const fight = scoreDecision(model, record(amber, 'fight', 'winner'));

        if ((reap > fight ? 'reap' : 'fight') === rightMove(amber)) {
            right++;
        }
    }

    return right / samples;
}

describe('a model that learns its own crosses', function () {
    const options = { learningRate: 0.1, epochs: 12, lambda: 0, l2: 1e-6 };

    describe('the interaction a linear model cannot represent', function () {
        it('leaves the linear model at chance, however much it is trained', function () {
            const model = trainModel(emptyModel(), plantedGames(4000), options);

            // Not "does badly" - CANNOT. The difference between the two
            // candidates' scores is w[a:act:reap] - w[a:act:fight], a constant
            // that no amount of evidence can make depend on the amber.
            expect(rankingAccuracy(model)).toBeLessThan(0.6);
        });

        it('is learned by a hidden layer', function () {
            const model = trainModel(emptyModel(), plantedGames(4000), {
                ...options,
                hiddenUnits: 24
            });

            expect(model.net).toBeTruthy();
            expect(rankingAccuracy(model)).toBeGreaterThan(0.9);
        });
    });

    describe('it is a correction, never a replacement', function () {
        it('scores a model with no net exactly as it always did', function () {
            const model = emptyModel();

            model.weights['s:myAmber'] = 0.7;
            model.weights['a:act:reap'] = 0.3;

            const decision = record(0.8, 'reap', 'winner');

            // The linear path and the public one must agree to the bit, or
            // every champion ever trained starts playing differently.
            expect(scoreDecision(model, decision)).toBe(scoreLinear(model, decision, 0));
            expect(model.net).toBeUndefined();
        });

        it('starts a fresh net near zero, so a candidate is its champion plus a whisper', function () {
            const net = emptyNet(DENSE_LAYOUT.length, 16);
            const vector = denseInput(record(0.5, 'reap', 'winner'), DENSE_LAYOUT);

            expect(Math.abs(netScore(net, vector))).toBeLessThan(0.5);
        });

        it('does not zero the output layer, which would freeze the hidden one', function () {
            // Tempting, because it would make a candidate identical to its
            // champion - and it would also make the FIRST layer's gradient
            // identically zero, so the hidden units would never learn at all.
            const net = emptyNet(DENSE_LAYOUT.length, 8);

            expect(net.w2.some((weight) => weight !== 0)).toBe(true);
        });

        it('never reaches back into the model it was trained from', function () {
            const base = trainModel(emptyModel(), plantedGames(200), {
                ...options,
                hiddenUnits: 8
            });
            const before = JSON.stringify(base.net);

            trainModel(base, plantedGames(200), options);

            // A candidate that trained through its champion's own weights
            // would change the reigning model while the arena was measuring
            // it, which is the one thing the title fight cannot survive.
            expect(JSON.stringify(base.net)).toBe(before);
        });
    });

    describe('the dense layout is a contract', function () {
        it('reads the vector by position, so it is built from the vocabularies', function () {
            const layout = denseLayout(STATE_KEYS);

            expect(layout.length).toBe(DENSE_LAYOUT.length);
            // State first, then kinds, then contexts - appending is safe and
            // inserting silently points every later weight at another input.
            expect(layout.slice(0, STATE_KEYS.length)).toEqual(STATE_KEYS.map((key) => `s:${key}`));
            expect(layout).toContain(`a:act:${ACTION_KINDS[0]}`);
            expect(layout).toContain(`x:${ACTION_CONTEXTS_KEYS[0]}`);
        });

        it('reads the live contexts out of the row rather than recomputing them', function () {
            // A stored row's player is long gone, so the row itself is the
            // only honest source - and it means a row and a live decision give
            // the same vector by construction rather than by two functions
            // happening to agree.
            const decision = {
                state: { bias: 1 },
                action: { 'a:act:reap': 1, 'x:reap:losingRace': 1, 'x:reap:keyReady': 1 }
            };
            const vector = denseInput(decision, DENSE_LAYOUT);

            expect(vector[DENSE_LAYOUT.indexOf('x:losingRace')]).toBe(1);
            expect(vector[DENSE_LAYOUT.indexOf('x:keyReady')]).toBe(1);
            expect(vector[DENSE_LAYOUT.indexOf('x:noBoard')]).toBe(0);
        });

        it('agrees with itself between the forward pass and the score', function () {
            const net = emptyNet(DENSE_LAYOUT.length, 12);
            const vector = denseInput(record(0.4, 'fight', 'winner'), DENSE_LAYOUT);

            expect(forward(net, vector).z).toBe(netScore(net, vector));
        });
    });

    describe('the model stays a JSON row', function () {
        it('round-trips through JSON unchanged', function () {
            const model = trainModel(emptyModel(), plantedGames(300), {
                ...options,
                hiddenUnits: 8
            });
            const decision = record(0.7, 'reap', 'winner');
            const revived = JSON.parse(JSON.stringify(model));

            expect(scoreDecision(revived, decision)).toBe(scoreDecision(model, decision));
        });

        it('stays small enough to ride to a game node with every table', function () {
            // The stated reason labFeatures limits the per-card crosses to two.
            const net = emptyNet(DENSE_LAYOUT.length, 24);
            const params = net.w1.length * net.w1[0].length + net.b1.length + net.w2.length + 1;

            expect(params).toBeLessThan(4000);
        });

        it('deep-copies rather than sharing arrays', function () {
            const net = emptyNet(DENSE_LAYOUT.length, 4);
            const copy = cloneNet(net);

            copy.w1[0][0] = 999;
            copy.w2[0] = 999;

            expect(net.w1[0][0]).not.toBe(999);
            expect(net.w2[0]).not.toBe(999);
            expect(cloneNet(null)).toBe(null);
        });
    });

    describe('it is off until it has earned its way on', function () {
        it('ships with no hidden units', function () {
            // Proven to learn what the linear model cannot, and NOT yet proven
            // to win games: on real self-play its held-out loss reaches parity
            // at 300 games with the gap still closing. The loop's whole
            // doctrine is that the bot can never quietly get worse.
            expect(REGISTRY.championsChallenge.fields.hiddenUnits.default).toBe(0);
        });

        it('leaves a model alone when asked for none', function () {
            const model = trainModel(emptyModel(), plantedGames(50), options);

            expect(model.net).toBeUndefined();
        });

        it('keeps a net once a model has one, whatever the setting says later', function () {
            // A model keeps what it was trained with; the arena is what decides
            // whether it keeps the title. Tearing a net off a reigning champion
            // because a knob moved would change how it plays without measuring
            // the change.
            const grown = trainModel(emptyModel(), plantedGames(50), {
                ...options,
                hiddenUnits: 8
            });
            const again = trainModel(grown, plantedGames(50), options);

            expect(again.net).toBeTruthy();
            expect(again.net.hidden).toBe(8);
        });
    });

    describe('a styled pilot is still the champion underneath', function () {
        it('carries the net through a persona', function () {
            const {
                personaModel,
                PERSONAS
            } = require('../../../../server/services/championschallenge/labPersonas');
            const champion = trainModel(emptyModel(), plantedGames(200), {
                ...options,
                hiddenUnits: 8
            });
            const styled = personaModel(champion, PERSONAS[0], 1);

            // A style is a bias on the champion's own weights (N31). A styled
            // pilot that quietly lost the hidden layer would not be the
            // champion wearing a plan, it would be a different and weaker bot
            // - and the Racer a member meets in the lobby is supposed to be
            // the Racer their decks are measured against in the lab.
            expect(styled.net).toBe(champion.net);
        });
    });

    describe('the logit is computed once', function () {
        it('splits into a linear part and a net part that sum back', function () {
            const model = trainModel(emptyModel(), plantedGames(200), {
                ...options,
                hiddenUnits: 8
            });
            const decision = record(0.6, 'reap', 'winner');
            const vector = denseInput(decision, DENSE_LAYOUT);
            const netZ = forward(model.net, vector).z;

            expect(scoreLinear(model, decision, netZ)).toBeCloseTo(
                scoreDecision(model, decision),
                12
            );
            expect(typeof linearLogit(model, decision)).toBe('number');
        });
    });
});
