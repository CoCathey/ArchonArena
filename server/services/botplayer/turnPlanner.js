const { fork } = require('../../game/positionSnapshot');
const { withRandomSource, seededSource } = require('../../game/secureRandom');
const { stateFeatures } = require('../championschallenge/labFeatures');
const { scoreState } = require('../championschallenge/labPolicy');
const { BotPolicy } = require('./BotPolicy');
const { determinize } = require('./determinize');
const { textOf } = require('./decisions');

/**
 * ARCHON (N52): choose the house by PLAYING the turn, not by describing it.
 *
 * The house call is the worst-informed decision the bot makes and the most
 * consequential one it makes. N46 said exactly why it could not be modelled: a
 * house call "emits nothing at all: its consequence is the whole rest of the
 * turn". So the afterstate work that taught the model what a reap or a fight
 * does could say nothing whatever about the choice that decides which reaps
 * and fights are available in the first place.
 *
 * Every other move the bot scores is one it can describe. This one can only be
 * answered by finding out - and since N51 a position can be copied, so finding
 * out is possible: fork the game, call each house, play that turn out, and
 * look at where each one left the board.
 *
 * ## Why this is planning and not a better heuristic
 *
 * The worth of a house is not a property of the cards it holds. It is what
 * this board, this hand, this amber pool and this opponent let those cards do
 * before the turn ends. Three creatures are worth a great deal on an empty
 * board and much less into a board that will kill them; a steal is worth a key
 * when the opponent is at check and nearly nothing when they are at zero. No
 * count of cards in hand expresses that, which is why every version of
 * `houseScore` has been a guess.
 *
 * Rolling the turn out with THE SAME POLICY that will actually play it makes
 * the estimate the honest one: not "what could this house do" but "what will
 * this bot do with it".
 *
 * ## Fairness is not optional, and it is not free
 *
 * A fork is exact, and exactness is the problem: it holds the real deck in its
 * real order, so a planner handed one unmodified calls the house whose cards it
 * is about to draw. Every rollout is therefore determinized first (see
 * `determinize`), which is what keeps the bot a player anybody would agree was
 * playing fair - the same rule `labFeatures` already states for what the model
 * is allowed to read.
 *
 * That makes each world a sample rather than an answer, so several are
 * averaged - and every house is judged on THE SAME worlds. Sharing them is not
 * a nicety: with a world each, a house can win for having been dealt a better
 * shuffle and the planner would be measuring the deal. Same common-random-
 * numbers correction DeepGame applies to its own rollouts.
 *
 * ## The budget is the design, not a safety valve
 *
 * Measured on real positions: a fork costs about 10ms, determinizing half a
 * millisecond, playing a turn out about 25ms - so one rollout is roughly 35ms,
 * and three houses at two worlds each is about 200ms. The game node is
 * single-threaded and shared, and a bot that holds it is every other game on
 * that node waiting, including the ping the lobby uses to decide the node is
 * alive.
 *
 * So the planner spends a wall-clock budget rather than a fixed count, and
 * spends it BREADTH FIRST: one world for every house before a second world for
 * any of them. A house nobody rolled has no score, and preferring a house that
 * was tried over one that was not is worse than not planning at all - so if
 * the budget cannot cover one world per house, the planner declines and the
 * caller chooses the way it always did.
 */

/** Stop a rollout that will not end, whatever the reason. */
const MAX_ROLLOUT_STEPS = 500;

/** A small deterministic generator, so one world can be asked for by number. */
function rngFrom(seed) {
    let state = seed >>> 0;

    return () => {
        state = (state + 0x6d2b79f5) >>> 0;

        let t = state;

        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Plan the house call by rolling each choice out.
 *
 * @param {object} game the live game, sitting at a house call
 * @param {object} player the seat deciding
 * @param {object[]} buttons the house buttons the prompt is offering
 * @param {object} options
 * @param {object} options.policy the champion model - required
 * @param {number} [options.samples] worlds per house (default 2)
 * @param {number} [options.budgetMs] wall-clock ceiling (default 150)
 * @param {number} [options.seed] fixes the worlds, for reproducible tests
 * @param {function} [options.now] injectable clock
 * @returns {{house: string, values: object[], rollouts: number}|null} null when
 *          the planner declines and the caller should choose as it always did
 */
function planHouse(game, player, buttons, options = {}) {
    const {
        policy,
        samples = 2,
        budgetMs = 150,
        seed = 1,
        rounds = 1,
        now = () => Date.now()
    } = options;

    // No champion means no value model, and nothing to score a rolled-out turn
    // with. A planner scoring by the plain heuristic would be an expensive way
    // to reproduce the answer the plain heuristic already gives.
    if (!policy || !buttons || buttons.length < 2) {
        return null;
    }

    const deadline = now() + budgetMs;
    const houses = buttons.map((button) => textOf(button.text));
    const totals = new Map(houses.map((house) => [house, { house, total: 0, worlds: 0 }]));
    let rollouts = 0;

    for (let world = 0; world < samples; world++) {
        for (const house of houses) {
            // The first pass is never cut short: a comparison missing a
            // candidate is not a comparison. Later passes stop on the clock.
            if (world > 0 && now() >= deadline) {
                break;
            }

            const value = rollOut(game, player.name, house, seed + world * 7919, policy, rounds);

            rollouts++;

            if (value === null) {
                continue;
            }

            const entry = totals.get(house);

            entry.total += value;
            entry.worlds++;
        }
    }

    const values = [...totals.values()]
        .filter((entry) => entry.worlds > 0)
        .map((entry) => ({
            house: entry.house,
            value: entry.total / entry.worlds,
            worlds: entry.worlds
        }));

    // Every house, or none. Picking the best of whichever happened to survive
    // would quietly prefer the ones that were tried first.
    if (values.length !== houses.length) {
        return null;
    }

    const best = values.reduce((left, right) => (right.value > left.value ? right : left));

    return { house: best.house, values, rollouts };
}

/**
 * One world, one house: fork, forget what the seat cannot see, call the house,
 * play the turn out, and score where it ended.
 *
 * The live game is never touched - `fork` reads it and builds elsewhere - so
 * this is safe to call repeatedly from a position somebody is sitting at.
 *
 * @returns {number|null} the end-of-turn value to the deciding seat, or null
 *          when the world could not be played
 */
function rollOut(liveGame, seatName, house, worldSeed, policy, rounds) {
    try {
        // The engine's randomness for this world and the bot's own dice, both
        // derived from the world seed - so every house faces the identical
        // future and the difference between them is the house.
        const engine = seededSource((Math.imul(worldSeed, 2654435761) ^ 0x5bf03635) >>> 0);
        const dice = rngFrom((worldSeed ^ 0x9e3779b9) >>> 0);

        return withRandomSource({ next: () => engine.next() }, () => {
            const copy = fork(liveGame);

            if (!copy.ok) {
                return null;
            }

            const game = copy.game;
            const seat = game.getPlayerByName(seatName);

            if (!seat) {
                return null;
            }

            determinize(game, seat, dice);

            const chosen = (seat.promptState.buttons || [])
                .filter((button) => !button.disabled)
                .find((button) => textOf(button.text) === house);

            if (!chosen) {
                return null;
            }

            game.menuButton(seatName, chosen.arg, chosen.uuid, chosen.method);
            game.continue();

            playOutTurn(game, seatName, dice, policy, rounds);

            const ended = game.getPlayerByName(seatName);

            // The board the moment the turn ends, read from the seat that took
            // it and before the opponent answers - which is the only thing the
            // house call is a choice between.
            return scoreState(policy, stateFeatures(game, ended));
        });
    } catch (err) {
        // A world that cannot be played is dropped, never guessed at - the same
        // rule DeepGame applies to a fork that will not replay. One bad world
        // costs a sample; a thrown planner would cost the table its turn.
        return null;
    }
}

/**
 * Play until the seat's turn is over - or, past one round, until it comes back
 * round to them, so the score reflects what the opponent did about it.
 */
function playOutTurn(game, seatName, rng, policy, rounds = 1) {
    const pilot = new BotPolicy({ rng, policy });
    const client = {
        cardClicked: (name, uuid) => game.cardClicked(name, uuid),
        menuButton: (name, arg, uuid, method) => game.menuButton(name, arg, uuid, method),
        clickProphecy: (name, uuid) => game.clickProphecy(name, uuid)
    };

    let handovers = 0;
    let mine = true;

    for (let step = 0; step < MAX_ROLLOUT_STEPS * rounds; step++) {
        if (game.winner) {
            return;
        }

        const isMine = !!game.activePlayer && game.activePlayer.name === seatName;

        if (isMine !== mine) {
            handovers++;
            mine = isMine;

            // One handover ends a turn; two ends a round. Past the horizon the
            // comparison is taken, because everything after it is the same
            // game whichever house started it.
            if (handovers >= rounds * 2 - 1) {
                return;
            }
        }

        let acted = false;

        // Every seat, not only the deciding one: a turn raises prompts the
        // opponent has to answer, and a rollout that left them standing would
        // stall on the first card that asks the other player anything.
        for (const seat of game.getPlayers()) {
            if (pilot.respond(client, seat)) {
                acted = true;
                game.continue();
                break;
            }
        }

        if (!acted) {
            return;
        }
    }
}

module.exports = { planHouse, rngFrom, MAX_ROLLOUT_STEPS };
