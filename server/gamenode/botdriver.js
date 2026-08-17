const { BotPolicy } = require('../services/botplayer/BotPolicy');

/**
 * ARCHON (F9): the bot's seat at a real table.
 *
 * The Champion’s Challenge SimulatedGame owns a whole game and loops both seats
 * to completion. Here the shape is inverted: a HUMAN owns the pace of the
 * game, and the bot must answer whatever prompts are its to answer, then get
 * out of the way. So instead of a run loop there is `pump()`: called by the
 * game server after every event that can change state (start, every human
 * input, the periodic sweeps), it answers the bot's pending prompts until
 * the bot has nothing left to answer, and returns.
 *
 * The same termination doctrine as the lab, adapted to a table with a person
 * at it - a wedged bot cannot simply be "recorded nowhere", because somebody
 * is sitting across from it waiting:
 *
 *  - The pump never dispatches an input once `game.winner` is set, so the
 *    bot can never press anything on the post-game menu (rematch, continue).
 *  - A lifetime interaction cap and a turn cap end in an honest CONCEDE, not
 *    a hang: the human gets the win and the table frees itself. The caps are
 *    generous - a full bot-vs-bot game fits inside the same budget.
 *  - Within one pump, a pass over the bot seats that dispatches nothing ends
 *    the pump. Anything the bot cannot answer is left standing, where the
 *    force-pass path (Game.checkInactivity) remains the human's remedy.
 *
 * Everything is dispatched through the ordinary player interface via
 * BotPolicy - the bot cannot cheat, and notePlayerEvent is called for each
 * input exactly as the socket path does for a human, so the inactivity
 * bookkeeping sees the bot as the player it is.
 */
class BotDriver {
    /**
     * @param {string[]} botNames usernames of the seats this driver plays
     * @param {object} [options]
     * @param {number} [options.maxTurns] concede past this many rounds
     * @param {number} [options.maxInteractions] concede past this many inputs
     * @param {object} [options.policy] the learned model to play with
     * @param {number} [options.thinkMs] pause between plays; 0 plays instantly
     * @param {number} [options.maxPumpMs] event-loop budget for one pump
     * @param {function} [options.resume] continue a pump that ran out of budget
     * @param {function} [options.schedule] injectable timer, for tests
     * @param {function} [options.now] injectable clock, for tests
     * @param {function} [options.rng] injectable for reproducible tests
     */
    constructor(botNames, options = {}) {
        this.botNames = botNames;
        // Number.isFinite rather than ||, so a spec can pin the caps at
        // tiny values (including 0) without the default swallowing them.
        this.maxTurns = Number.isFinite(options.maxTurns) ? options.maxTurns : 80;
        this.maxInteractions = Number.isFinite(options.maxInteractions)
            ? options.maxInteractions
            : 5000;
        /**
         * ARCHON (F9): the bot may never hold the node's event loop.
         *
         * Everything here is synchronous inside the engine, and the node is
         * single-threaded and shared: every other game on it, and the ping
         * the lobby uses to decide whether this node is alive, wait behind a
         * pump. A node that stops answering for a minute is declared timed
         * out, and the lobby then clears every game on it - so an expensive
         * bot turn is not "the bot is slow", it is every player on the node
         * losing their game.
         *
         * A pump therefore runs on a quarter-second budget and, if it needs
         * longer, hands the loop back and finishes on a later tick. A quarter
         * second is far more than one play needs and far less than any
         * timeout that matters, so the node stays answerable even if a bot
         * somehow finds a position it wants to think very hard about.
         */
        this.maxPumpMs = Number.isFinite(options.maxPumpMs) ? options.maxPumpMs : 250;
        /**
         * ARCHON (F9): the bot thinks visibly.
         *
         * It decides in microseconds, and a whole turn landing in one frame
         * reads as a glitch rather than as an opponent: cards appear already
         * played, and the person across the table cannot follow what
         * happened to them. So each play waits a moment, with a little
         * jitter so the rhythm is not metronomic.
         *
         * Zero means instantly, which is what the specs and any bot-vs-bot
         * game want - nobody is watching those in real time.
         */
        this.thinkMs = Number.isFinite(options.thinkMs) ? Math.max(0, options.thinkMs) : 0;
        this.resume = options.resume || null;
        this.schedule = options.schedule || ((callback, delay) => setTimeout(callback, delay || 0));
        this.now = options.now || (() => Date.now());
        this.policy = new BotPolicy({ rng: options.rng, policy: options.policy });

        this.interactions = 0;
        this.conceded = false;
        this.resumeScheduled = false;
        // True only while a scheduled continuation is running: a pump that
        // arrives any other way (a human's move, the sweep) is the start of
        // a think, not the end of one.
        this.resuming = false;
    }

    /** How long to pause before the next play. */
    thinkDelay() {
        if (this.thinkMs <= 0) {
            return 0;
        }

        // +/- 25%, so a chain of plays does not tick like a clock.
        return Math.round(this.thinkMs * (0.75 + this.rngValue() * 0.5));
    }

    rngValue() {
        return this.policy && typeof this.policy.rng === 'function'
            ? this.policy.rng()
            : Math.random();
    }

    /** Has a seat this driver plays got something it could answer? */
    botCanAct(game) {
        return this.botNames.some((name) => {
            const player = game.getPlayerByName(name);

            if (!player || player.left) {
                return false;
            }

            const state = player.promptState;
            const buttons = (state && state.buttons) || [];
            const selectable = (state && state.selectableCards) || [];

            return buttons.some((button) => !button.disabled) || selectable.length > 0;
        });
    }

    /**
     * Answer every prompt currently waiting on a bot seat.
     *
     * Ends when the winner is decided, when a seat this driver does not play
     * holds a prompt (the human's move - not ours to press), or when the game
     * goes quiet. A quiet game gets a handful of bare `continue()` calls
     * first: the pipeline occasionally needs one to cross a phase boundary
     * with no input pending on anyone (the same empirical allowance
     * SimulatedGame makes), and between pumps a human's inputs provide them.
     *
     * @param {import("../game/game")} game
     * @returns {boolean} whether any input was dispatched
     */
    pump(game) {
        const deadline = this.now() + this.maxPumpMs;
        let acted = false;
        let idleContinues = 0;

        // A pump that arrives from outside - the human moved, the game just
        // started, the sweep came round - is the moment the bot starts
        // thinking, not the moment it plays. The pause happens first so the
        // opponent's move lands on screen alone, the way a person's does.
        if (this.thinkMs > 0 && !this.resuming && this.botCanAct(game)) {
            this.scheduleResume(game, this.thinkDelay());

            return false;
        }

        while (!game.winner) {
            // Budget first: whatever is left to do is picked up by the
            // continuation below rather than done at the node's expense.
            if (this.now() >= deadline) {
                this.scheduleResume(game);

                return acted;
            }

            let progressed = false;

            for (const name of this.botNames) {
                if (game.winner) {
                    break;
                }

                const player = game.getPlayerByName(name);

                if (!player || player.left) {
                    continue;
                }

                if (this.interactions >= this.maxInteractions || game.round > this.maxTurns) {
                    this.concede(game, player);

                    return true;
                }

                if (this.policy.respond(game, player)) {
                    progressed = true;
                    acted = true;
                    this.interactions++;
                    game.notePlayerEvent(name);
                    game.continue();

                    // One play, then think again - so a turn arrives as a
                    // sequence a person can follow rather than as a single
                    // finished position. The continuation pushes the board
                    // out as it goes.
                    if (this.thinkMs > 0) {
                        this.scheduleResume(game, this.thinkDelay());

                        return true;
                    }
                }
            }

            if (progressed) {
                idleContinues = 0;

                continue;
            }

            if (this.otherSeatCanAct(game) || idleContinues >= 50) {
                break;
            }

            game.continue();
            idleContinues++;
        }

        return acted;
    }

    /**
     * Finish this pump on a later tick, so the node can serve everybody else
     * (and answer the lobby's ping) in between. One continuation at a time:
     * the pump that resumes reschedules itself if it too runs out of budget.
     */
    scheduleResume(game, delayMs = 0) {
        if (this.resumeScheduled || !this.resume || game.winner) {
            return;
        }

        this.resumeScheduled = true;

        this.schedule(() => {
            this.resumeScheduled = false;
            this.resuming = true;

            try {
                this.resume();
            } finally {
                this.resuming = false;
            }
        }, delayMs);
    }

    /**
     * Is a seat this driver does NOT play currently holding an answerable
     * prompt? While one is, a quiet pass is their turn to think, not a
     * pipeline boundary to push through.
     */
    otherSeatCanAct(game) {
        return game.getPlayers().some((player) => {
            if (this.botNames.includes(player.name) || player.left) {
                return false;
            }

            const state = player.promptState;
            const buttons = (state && state.buttons) || [];
            const selectable = (state && state.selectableCards) || [];

            return buttons.some((button) => !button.disabled) || selectable.length > 0;
        });
    }

    /**
     * The honest way out of a game the bot cannot finish: say so, concede,
     * and let the ordinary win flow (GAMEWIN, post-game menu) take over.
     */
    concede(game, player) {
        if (this.conceded) {
            return;
        }

        this.conceded = true;

        game.addAlert(
            'warning',
            '{0} has reached the limit of what it knows how to play and concedes',
            player
        );
        game.concede(player.name);
        game.continue();
    }
}

module.exports = BotDriver;
