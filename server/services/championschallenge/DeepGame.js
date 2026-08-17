const { SimulatedGame, replayTo } = require('./SimulatedGame');
const { stateFeatures, decisionRecord } = require('./labFeatures');
const { scoreState, scoreDecision } = require('./labPolicy');

/**
 * ARCHON (N21): the deep bot - the one that thinks before it clicks.
 *
 * The fast bot answers "which of these moves looks best?" from the learned
 * model alone. The deep bot answers it by TRYING them: at a decision worth
 * the time, it forks the live game (deterministic replay of the input log),
 * plays the candidate move in the fork - where the card's REAL ability code
 * resolves, chains, combos and all - rolls the fork forward a few turns with
 * the fast policy under a different future (fresh randomness, so it plans
 * against likelihoods rather than replaying fate), and scores where each
 * road leads with the learned value model. Several samples per candidate,
 * averaged; the best road wins.
 *
 * That is planning in the only sense an engine has it, and it is also the
 * honest kind: what the bot learns about a card comes from executing the
 * card, not from a summary somebody wrote about it.
 *
 * Every analyzed decision leaves an annotation - what was chosen, what the
 * alternatives promised, and how much the choice mattered - which is what
 * the Challenge page's showcase panel renders, and the moment with the
 * largest gap between the best and worst road is flagged as where the game
 * turned.
 *
 * Budgets everywhere, because a thoughtful move costs real CPU: how many
 * decisions per game get the treatment, how many candidates, how many
 * samples, how deep the rollout. A deep game at the defaults is roughly a
 * minute of compute against the fast bot's half second - which is exactly
 * why the fast bot keeps the volume and this one plays the showcases.
 */

class DeepGame {
    /**
     * @param {object} deckAlpha engine-ready deck
     * @param {object} deckOmega engine-ready deck
     * @param {object} [options]
     * @param {number} [options.seed] required in practice; defaulted randomly by the service
     * @param {object} [options.policy] the champion model - used for scoring AND rollouts
     * @param {number} [options.maxAnalyzedDecisions] deep looks per game
     * @param {number} [options.candidatesCap] most roads tried per decision
     * @param {number} [options.samplesPerCandidate] futures averaged per road
     * @param {number} [options.rolloutTurns] how far each future is played
     * @param {number} [options.maxTurns] inherited game cap
     */
    constructor(deckAlpha, deckOmega, options = {}) {
        this.deckAlpha = deckAlpha;
        this.deckOmega = deckOmega;
        this.seed = options.seed;
        this.policy = options.policy || null;
        this.maxAnalyzedDecisions = options.maxAnalyzedDecisions || 12;
        this.candidatesCap = options.candidatesCap || 6;
        this.samplesPerCandidate = options.samplesPerCandidate || 3;
        this.rolloutTurns = options.rolloutTurns || 6;
        this.maxTurns = options.maxTurns || 80;

        this.analyzed = 0;
        this.forksPlayed = 0;
        this.annotations = [];
    }

    /**
     * Play one deep game to completion.
     *
     * @returns {Promise<object>} the SimulatedGame result, plus
     *          `annotations` and `deep: true`
     */
    async run() {
        const sim = new SimulatedGame(this.deckAlpha, this.deckOmega, {
            seed: this.seed,
            policy: this.policy,
            // Greedy between analyzed decisions: a showcase game does not
            // explore, it performs.
            temperature: 0,
            maxTurns: this.maxTurns,
            analyzer: (context) => this.analyze(context)
        });

        const result = await sim.run();

        if (!result.completed) {
            return result;
        }

        this.markTurningPoint();

        return {
            ...result,
            deep: true,
            forksPlayed: this.forksPlayed,
            annotations: this.annotations
        };
    }

    /**
     * The analyzer SimulatedGame awaits at each choice point. Returns the
     * chosen candidate index, or null to let the fast policy decide.
     */
    async analyze({ sim, game, player, kind, candidates }) {
        if (this.analyzed >= this.maxAnalyzedDecisions) {
            return null;
        }

        if (!this.worthAnalyzing(game, player, kind)) {
            return null;
        }

        this.analyzed++;

        const prefix = sim.inputLog.slice();
        const shortlist = this.shortlist(game, player, kind, candidates);
        const evaluated = [];

        for (const candidate of shortlist) {
            let total = 0;
            let samples = 0;

            for (let sample = 0; sample < this.samplesPerCandidate; sample++) {
                const value = await this.tryRoad(game, player, prefix, kind, candidate, sample);

                if (value !== null) {
                    total += value;
                    samples++;
                }
            }

            evaluated.push({
                index: candidate.index,
                label: describeCandidate(candidates[candidate.index]),
                winProb: samples ? total / samples : null
            });
        }

        const scored = evaluated.filter((entry) => entry.winProb !== null);

        if (!scored.length) {
            return null;
        }

        const best = scored.reduce((a, b) => (b.winProb > a.winProb ? b : a));
        const worst = scored.reduce((a, b) => (b.winProb < a.winProb ? b : a));

        this.annotations.push({
            turn: game.round || 0,
            side: player.name,
            kind,
            chosen: best.label,
            winProb: round3(best.winProb),
            options: evaluated.map((entry) => ({
                label: entry.label,
                winProb: entry.winProb === null ? null : round3(entry.winProb)
            })),
            swing: round3(best.winProb - worst.winProb)
        });

        return best.index;
    }

    /**
     * Deep thought is spent where games are decided: every house call, and
     * board decisions whenever either side is within reach of forging.
     */
    worthAnalyzing(game, player, kind) {
        if (kind === 'house') {
            return true;
        }

        const opponent = player.opponent;
        const near = (side) => side && side.amber >= Math.max(0, side.getCurrentKeyCost() - 3);

        return near(player) || near(opponent) || (game.round || 0) <= 2;
    }

    /** Cap the candidate list, keeping the fast model's favourites. */
    shortlist(game, player, kind, candidates) {
        const indexed = candidates.map((candidate, index) => ({ candidate, index }));

        if (indexed.length <= this.candidatesCap) {
            return indexed;
        }

        const scoreOf = ({ candidate }) =>
            this.policy
                ? scoreDecision(
                      this.policy,
                      decisionRecord(game, player, {
                          kind: candidate.kind,
                          card: candidate.card,
                          house: candidate.house,
                          player
                      })
                  )
                : 0.5;

        return indexed
            .map((entry) => ({ ...entry, score: scoreOf(entry) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, this.candidatesCap);
    }

    /**
     * One sampled future for one candidate: fork the game at the decision,
     * force the candidate move, roll forward, and read the scoreboard.
     * Returns a win probability for the deciding player, or null when the
     * fork could not be played (determinism tripwire, engine error) - a
     * failed road is dropped, never guessed at.
     */
    async tryRoad(game, player, prefix, kind, { index }, sample) {
        this.forksPlayed++;

        try {
            const rolloutSeed =
                (this.seed ^ (this.analyzed * 2654435761) ^ (index * 40503) ^ (sample * 923)) >>> 0;
            const { sim: fork } = await replayTo(this.deckAlpha, this.deckOmega, {
                seed: this.seed,
                inputLog: prefix,
                rolloutSeed,
                options: {
                    policy: this.policy,
                    temperature: 0,
                    maxTurns: this.maxTurns
                }
            });

            const forkPlayer = fork.game.getPlayerByName(player.name);

            // Force the candidate move on the fork, through the same
            // interface as ever.
            if (kind === 'house') {
                const buttons = (forkPlayer.promptState.buttons || []).filter(
                    (button) => !button.disabled
                );

                if (!(await forceHouse(fork, forkPlayer, buttons, index))) {
                    return null;
                }
            } else if (!(await forceAction(fork, forkPlayer, index))) {
                return null;
            }

            fork.game.continue();
            fork.stopAfterRound = (fork.game.round || 0) + this.rolloutTurns;

            const outcome = await fork.run();

            if (outcome.completed) {
                return outcome.winner === player.name ? 1 : 0;
            }

            if (outcome.reason !== 'horizon') {
                return null;
            }

            const horizonPlayer = fork.game.getPlayerByName(player.name);

            return this.policy
                ? scoreState(this.policy, stateFeatures(fork.game, horizonPlayer))
                : heuristicValue(fork.game, horizonPlayer);
        } catch (err) {
            // The tripwire: determinism broke, or a fork hit an engine edge.
            // Drop the sample; the live game is untouched.
            return null;
        }
    }

    /** Flag the analyzed moment where the roads diverged the most. */
    markTurningPoint() {
        if (!this.annotations.length) {
            return;
        }

        const turning = this.annotations.reduce((a, b) => (b.swing > a.swing ? b : a));

        turning.turningPoint = true;
    }
}

/** Dispatch a specific house button on a fork. */
async function forceHouse(fork, player, buttons, index) {
    if (!buttons[index]) {
        return false;
    }

    fork.houseCalls[player.name] = fork.houseCalls[player.name] || {};

    const house = String(
        typeof buttons[index].text === 'object'
            ? buttons[index].text.text || ''
            : buttons[index].text
    ).toLowerCase();

    fork.houseCalls[player.name][house] = (fork.houseCalls[player.name][house] || 0) + 1;

    if (!fork.firstHouse[player.name]) {
        fork.firstHouse[player.name] = house;
    }

    return fork.pressButtonAt(fork.game, player, buttons, index);
}

/**
 * Dispatch a specific main-window candidate on a fork. The fork enumerates
 * candidates with the SAME code the live game used (mainWindowCandidates),
 * so "play candidate 3" names the same move in both worlds - determinism
 * guarantees the lists agree.
 */
async function forceAction(fork, player, index) {
    const { hand, inPlay, prophecies, candidates } = fork.mainWindowCandidates(player);
    const chosen = candidates[index];

    if (!chosen) {
        return false;
    }

    fork.pendingIntent = { kind: chosen.kind };

    if (chosen.list === 'prophecy') {
        return fork.clickProphecyAt(fork.game, player, prophecies, chosen.index);
    }

    if (chosen.list === 'play') {
        fork.attacker = chosen.kind === 'fight' ? chosen.card : null;

        return fork.clickCardAt(fork.game, player, inPlay, chosen.index, 'play');
    }

    return fork.clickCardAt(fork.game, player, hand, chosen.index, 'hand');
}

/** A model-free fallback horizon score: the amber-and-keys race, roughly. */
function heuristicValue(game, player) {
    const opponent = player.opponent;
    const mine = player.getForgedKeys() * 8 + player.amber;
    const theirs = opponent ? opponent.getForgedKeys() * 8 + opponent.amber : 0;

    return 1 / (1 + Math.exp(-(mine - theirs) / 6));
}

function describeCandidate(candidate) {
    if (!candidate) {
        return 'unknown';
    }

    if (candidate.kind === 'houseCall' || candidate.house) {
        return `call ${candidate.house}`;
    }

    const verbs = {
        playCreature: 'play',
        playArtifact: 'play',
        playAction: 'play',
        playUpgrade: 'play',
        reap: 'reap with',
        fight: 'fight with',
        useAbility: 'use',
        discard: 'discard'
    };
    const name = candidate.card ? candidate.card.name || candidate.card.id : 'a card';

    return `${verbs[candidate.kind] || candidate.kind} ${name}`;
}

function round3(value) {
    return Math.round(value * 1000) / 1000;
}

async function runDeepGame(deckAlpha, deckOmega, options) {
    return new DeepGame(deckAlpha, deckOmega, options).run();
}

module.exports = { DeepGame, runDeepGame };
