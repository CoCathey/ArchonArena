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
        this.policy = new BotPolicy({ rng: options.rng });

        this.interactions = 0;
        this.conceded = false;
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
        let acted = false;
        let idleContinues = 0;

        while (!game.winner) {
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
