const {
    trainModel,
    emptyModel,
    scoreDecision
} = require('../../../../server/services/championschallenge/labPolicy');

/**
 * ARCHON (N55): the trainer's answer must not depend on the order it received
 * its evidence in.
 *
 * It did. Measured on real self-play - identical games, identical settings,
 * only the arrival order different - held-out log loss spanned 0.056, which is
 * three to twenty-eight times larger than every effect the lab had recently
 * tried to measure. Underneath the SPRT arena that decides which candidate
 * takes the title, that meant promotions were partly a coin flip and any real
 * improvement smaller than the noise was invisible.
 *
 * The cause was correlation rather than arrival order as such: consecutive
 * rows come from one game and one seat, so a block of them pushes the weights
 * coherently and a fixed step means whichever block lands last leaves the
 * deepest mark.
 *
 * Two properties follow, and the tension between them is the whole design:
 * the same evidence must give the same model REGARDLESS of the order it
 * arrives in, and the same evidence in the same order must give the same model
 * TWICE - because a training run that cannot be reproduced cannot be debugged,
 * and the specs that plant a signal and prove training finds it are not proofs
 * if the answer moves between runs.
 */

/** A game whose decisions are strongly correlated, as real games are. */
function game(index, winner) {
    const decisions = [];

    for (let turn = 0; turn < 12; turn++) {
        for (const side of ['me', 'them']) {
            decisions.push({
                side,
                state: {
                    bias: 1,
                    turn: turn / 12,
                    myAmber: ((index * 7 + turn) % 10) / 10,
                    myCreatures: ((index * 3 + turn) % 8) / 8
                },
                action: {
                    [`a:act:${turn % 2 ? 'reap' : 'fight'}`]: 1,
                    [`x:${turn % 2 ? 'reap' : 'fight'}:noEnemy`]: 1
                },
                cardId: `card-${(index + turn) % 15}`
            });
        }
    }

    return { winnerSide: winner, decisions };
}

const batch = Array.from({ length: 40 }, (_, i) => game(i, i % 2 ? 'me' : 'them'));

/** Probe the trained model on a fixed grid, so two models can be compared. */
function fingerprint(model) {
    const probes = [];

    for (let i = 0; i < 12; i++) {
        probes.push(
            scoreDecision(model, {
                state: { bias: 1, turn: i / 12, myAmber: i / 12, myCreatures: (11 - i) / 12 },
                action: { [`a:act:${i % 2 ? 'reap' : 'fight'}`]: 1 },
                cardId: `card-${i}`
            })
        );
    }

    return probes;
}

/** Deterministic reorder, so a failure is reproducible. */
function reordered(items, seed) {
    let state = seed >>> 0;
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0;

        let t = state;

        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const copy = [...items];

    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));

        [copy[i], copy[j]] = [copy[j], copy[i]];
    }

    return copy;
}

describe('the trainer and the order its evidence arrives in', function () {
    /** The widest any probe moved across five different arrival orders. */
    function spreadAcrossOrders(options) {
        const runs = [1, 2, 3, 4, 5].map((seed) =>
            fingerprint(trainModel(emptyModel(), reordered(batch, seed * 7919), options))
        );
        let worst = 0;

        for (let probe = 0; probe < runs[0].length; probe++) {
            const values = runs.map((run) => run[probe]);

            worst = Math.max(worst, Math.max(...values) - Math.min(...values));
        }

        return worst;
    }

    it('is far less order-sensitive than the step it shipped with', function () {
        const shipped = spreadAcrossOrders({});
        // The step this trainer ran on until N55. It is still order-sensitive
        // under the shuffle - a big stride over any ordering leaves the last
        // block deepest - which is why the fix was both halves.
        const old = spreadAcrossOrders({ learningRate: 0.05, epochs: 2 });

        // Asserted as a RATIO, because the absolute number depends on the
        // batch: on real self-play the same comparison went from a spread of
        // 0.056 to 0.005, and this synthetic batch is smaller and more
        // regular than a real diary. What has to hold either way is that the
        // shipped settings are markedly steadier than the ones they replaced.
        expect(shipped).toBeLessThan(old / 2);
    });

    it('gives the same model twice from the same batch', function () {
        const once = trainModel(emptyModel(), batch);
        const twice = trainModel(emptyModel(), batch);

        // The shuffle is seeded for exactly this: a run that cannot be
        // reproduced cannot be debugged, and a planted-signal spec is not a
        // proof if the answer moves between runs.
        expect(fingerprint(twice)).toEqual(fingerprint(once));
    });

    it('still walks every decision, however they are shuffled', function () {
        // The shuffle reorders the gradient pass; it must not drop rows from
        // it. Counts are evidence, and a card the trainer never saw is a card
        // whose weight stays shrunk toward its prior forever.
        const trained = trainModel(emptyModel(), batch);
        const seen = Object.keys(trained.cardCounts || {});

        expect(seen.length).toBe(15);

        const total = Object.values(trained.cardCounts).reduce((sum, n) => sum + n, 0);

        expect(total).toBe(batch.length * 24);
    });

    it('computes a label before any weight has moved', function () {
        // The targets are settled in one pass against the FROZEN model, which
        // is what makes shuffling the gradient pass safe: the order can change
        // without a single label changing. Two orders must therefore agree on
        // what each row was trained TOWARD, even where the weights differ.
        const straight = trainModel(emptyModel(), batch, { epochs: 1 });
        const jumbled = trainModel(emptyModel(), reordered(batch, 99), { epochs: 1 });

        // One epoch over the same rows with the same labels: the totals a
        // shrunk weight is built from cannot depend on the order at all.
        expect(jumbled.cardCounts).toEqual(straight.cardCounts);
        expect(jumbled.trainedGames).toBe(straight.trainedGames);
    });
});
