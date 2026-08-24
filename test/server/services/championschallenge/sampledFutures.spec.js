const {
    SimulatedGame,
    replayTo,
    PLAYER_ONE
} = require('../../../../server/services/championschallenge/SimulatedGame');
const {
    getCardIndex,
    cloneCard
} = require('../../../../server/services/championschallenge/packCards');
const { REGISTRY } = require('../../../../server/services/settings/registry');

/**
 * ARCHON (N54): a fork has to face a DIFFERENT future, or averaging is a lie.
 *
 * `DeepGame` measures a road by rolling it forward several times and averaging,
 * and derives a fresh `rolloutSeed` per sample precisely so the samples differ.
 * They did not. `SimulatedGame` builds `this.source` from its seed in the
 * constructor and `run()` enters that source's scope, so passing the ORIGINAL
 * seed to the fork meant every sample re-entered an identical fresh stream and
 * played an identical future. Measured at 5, 10 and 16 rollout turns, four
 * samples of a road agreed to the last bit 100% of the time.
 *
 * Nothing was broken-looking about it. `samplesPerCandidate` simply multiplied
 * the cost of every deep game by N and averaged a number with itself - a
 * setting whose label promised more accuracy and whose only effect was the
 * bill. That is the exact shape of failure this lab keeps warning about: a
 * measurement that looks like it is working.
 *
 * So the property is pinned from both ends: two different rollout seeds must
 * lead somewhere different, and the same rollout seed must still be
 * reproducible - because a planner that cannot reproduce a world cannot
 * compare two roads across it (the common-random-numbers correction the whole
 * candidate comparison rests on).
 */

function buildDeck(name, houses, offset) {
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
            const card = pool[(i * 7 + offset) % pool.length];

            cards.push({ id: card.id, count: 1, card: cloneCard(card.id) });
        }
    }

    return { name, uuid: `sampled-${name}`, expansion: 341, houses, cards };
}

const alpha = buildDeck('alpha', ['brobnar', 'dis', 'logos'], 0);
const omega = buildDeck('omega', ['sanctum', 'shadows', 'untamed'], 3);

/** Play a game, keep its input log, then roll forks forward from partway in. */
async function rollFrom(inputLog, seed, rolloutSeed, turns) {
    const { sim } = await replayTo(alpha, omega, {
        seed,
        inputLog,
        rolloutSeed,
        options: { temperature: 0, maxTurns: 60 }
    });

    sim.game.continue();
    sim.stopAfterRound = (sim.game.round || 0) + turns;

    const outcome = await sim.run();
    const seat = sim.game.getPlayerByName(PLAYER_ONE);

    return {
        reason: outcome.reason,
        completed: !!outcome.completed,
        // Where the roll actually ENDED, which is what a road's value is read
        // from - not merely whether it finished.
        board: `${sim.game.round}:${seat.amber}:${seat.getForgedKeys()}:${
            seat.cardsInPlay.length
        }:${seat.deck.length}:${seat.discard.length}`
    };
}

describe('a fork faces a future of its own', function () {
    let inputLog;
    const seed = 7373;

    beforeAll(async function () {
        const sim = new SimulatedGame(alpha, omega, { seed, maxTurns: 14, temperature: 0 });

        await sim.run();
        // Partway in, so there is a game to fork and a game left to play.
        inputLog = sim.inputLog.slice(0, Math.floor(sim.inputLog.length / 2));
    }, 120000);

    it('lands somewhere different under a different rollout seed', async function () {
        const one = await rollFrom(inputLog, seed, 111, 8);
        const two = await rollFrom(inputLog, seed, 999999, 8);

        // If these agree, `samplesPerCandidate` is multiplying the cost of
        // every deep game and averaging a value with itself.
        expect(two.board).not.toBe(one.board);
    }, 120000);

    it('lands in the same place twice under the same rollout seed', async function () {
        const one = await rollFrom(inputLog, seed, 4242, 8);
        const two = await rollFrom(inputLog, seed, 4242, 8);

        // The other half of the contract: candidates are compared across
        // SHARED futures, so a world has to be reproducible or a road can win
        // for having been dealt a better one.
        expect(two.board).toBe(one.board);
    }, 120000);

    it('still replays the recorded past exactly, whatever the rollout seed', async function () {
        // The replay runs under its own scope on the ORIGINAL seed; only the
        // continuation is re-seeded. A rollout seed that leaked backwards
        // would break the fork's determinism tripwire instead of its future.
        const one = await rollFrom(inputLog, seed, 5, 0);
        const two = await rollFrom(inputLog, seed, 600000, 0);

        expect(two.board).toBe(one.board);
    }, 120000);
});

describe('the deep budget', function () {
    it('buys sampled futures that now differ, so the spend is worth paying', function () {
        // Kept at more than one deliberately: with the seeding fixed, a road's
        // value across futures was measured to spread by about 0.57 on a
        // [0,1] scale, and these rows train at `trainingTargetWeight` - so a
        // single noisy sample would pull eight times as hard as a played one.
        expect(REGISTRY.championsChallenge.fields.deepSamples.default).toBeGreaterThan(1);
    });

    it('plays more deep games per day than it used to', function () {
        // The measured cost of a deep game at these defaults is ~73s, so this
        // sits inside the "about half an hour of CPU a day" the budget was
        // written for, and the rows it produces are the only ones whose value
        // was measured rather than inferred.
        expect(REGISTRY.championsChallenge.fields.deepGamesPerDay.default).toBeGreaterThanOrEqual(
            16
        );
    });
});
