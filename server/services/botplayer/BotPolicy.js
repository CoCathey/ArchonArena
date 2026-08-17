/**
 * ARCHON: the bot's playing policy - how a computer answers a prompt.
 *
 * Extracted from the Proving Grounds' SimulatedGame (N18) so the same player
 * can sit anywhere a bot is needed: the lab's background games, and the
 * Helper Bot table a human joins on the game node (the F9 practice opponent).
 * One policy, two hosts - a strength upgrade lands in both at once, and the
 * termination guarantees documented below stay in one place.
 *
 * The policy drives the engine through the ordinary player interface - the
 * same `menuButton`/`cardClicked` calls a browser click becomes - so a bot
 * game obeys exactly the rules a real one does, card fixes and all. Nothing
 * here reaches into game state to move cards or amber; if the engine would
 * not offer a human the button, the bot cannot press it.
 *
 * The player is honest but plain, and that is a design choice rather than a
 * shortcut: what every host needs first is games that always FINISH. So the
 * policy is a few sound KeyForge instincts - call the house you can use most
 * of, play everything playable, reap with what is ready, end the turn -
 * wrapped in a completely generic prompt handler that can answer ANY prompt
 * the 2,700-odd card implementations can raise, because it answers from the
 * buttons and selectable cards the prompt itself publishes.
 *
 * Termination is treated as a hard requirement rather than a hope:
 *
 *  - `Done`/`Autoresolve` are pressed once a selection prompt has what it
 *    needs (a multi-select prompt only completes on Done - a driver that
 *    never presses it spins forever; found empirically).
 *  - `Cancel` is never pressed while any other button exists, so the bot
 *    cannot open a card menu, cancel it, and open it again all day.
 *  - The caller must stop asking the moment `game.winner` is set - the
 *    engine queues a rematch prompt after a win, and a click-anything bot
 *    would cheerfully start a rematch. Both hosts enforce this in their
 *    loops; the policy itself only ever answers the prompt in front of it.
 */

// Buttons the bot must never press while any alternative exists. Concede and
// rematch protect the game; manual-mode toggles protect the bot's honesty.
const NEVER_PRESS = ['cancel', 'concede'];

// When a card menu is open, take the first of these that is offered. Play
// everything, ready the board, harvest amber, and only then look for a fight
// - the bot wants games that end, and amber is what ends them.
const ACTION_PREFERENCE = [
    'play this creature',
    'play this artifact',
    'play this action',
    'play this upgrade',
    "remove this creature's stun",
    'reap with this creature',
    "use this card's action ability",
    "use this card's omni ability",
    'fight with this creature',
    'discard this card'
];

/** Prompt titles the policy gives special answers to. */
const MAIN_WINDOW_TITLE = 'choose a card to play, discard or use';
const HOUSE_CHOICE_TITLE = 'choose which house you want to activate this turn';
const END_TURN_CONFIRM_TITLE = 'are you sure you want to end your turn?';
const MULLIGAN_TITLE = 'keep starting hand?';

/** menuTitle / button.text can be a string or { text, values }. */
function textOf(value) {
    if (!value) {
        return '';
    }

    return String(typeof value === 'object' ? value.text || '' : value).toLowerCase();
}

function pick(list, rng) {
    return list[Math.floor(rng() * list.length)];
}

class BotPolicy {
    /**
     * @param {object} [options]
     * @param {function} [options.rng] injectable for reproducible tests
     */
    constructor(options = {}) {
        this.rng = options.rng || Math.random;

        // How each seat has played, keyed by player name and filled lazily so
        // the policy serves any table, not just the lab's fixed seat names.
        this.houseCalls = {};
        this.firstHouse = {};
    }

    /**
     * Answer this player's current prompt, if they have one.
     *
     * @returns {boolean} whether an input was dispatched
     */
    respond(game, player) {
        const state = player.promptState;
        const buttons = (state.buttons || []).filter((button) => !button.disabled);
        const title = textOf(state.menuTitle);
        const selectable = state.selectableCards || [];

        // --- The main action window -------------------------------------
        if (title === MAIN_WINDOW_TITLE) {
            return this.playFromMainWindow(game, player, buttons);
        }

        // --- The house call ----------------------------------------------
        if (title === HOUSE_CHOICE_TITLE && buttons.length) {
            return this.chooseHouse(game, player, buttons);
        }

        // --- Fixed answers ------------------------------------------------
        if (title === END_TURN_CONFIRM_TITLE) {
            return this.press(game, player, buttons, ['yes']);
        }

        if (title === MULLIGAN_TITLE) {
            // Always keep: a deterministic answer that can never loop, and
            // mulligan strategy is far below the noise floor of this player.
            return this.press(game, player, buttons, ['keep hand']);
        }

        // --- Selection prompts --------------------------------------------
        if (state.selectCard && selectable.length) {
            const selected = state.selectedCards || [];
            const unselected = selectable.filter((card) => !selected.includes(card));
            const doneButton = buttons.find((button) => textOf(button.text) === 'done');

            // Keep selecting while the prompt wants more; press Done once it
            // is offered and something is selected (or nothing CAN be).
            if (unselected.length && (!doneButton || !selected.length)) {
                game.cardClicked(player.name, pick(unselected, this.rng).uuid);

                return true;
            }

            if (doneButton) {
                game.menuButton(player.name, doneButton.arg, doneButton.uuid, doneButton.method);

                return true;
            }
        }

        // --- Any other prompt: press something sensible -------------------
        if (buttons.length) {
            // A card's action menu is answered by preference - play beats
            // reap beats fight beats discard - so a card clicked to be
            // played is not then discarded on a coin flip.
            if (this.press(game, player, buttons, ACTION_PREFERENCE)) {
                return true;
            }

            // Autoresolve collapses a trigger-ordering window in one press.
            const autoresolve = buttons.find((button) => textOf(button.text) === 'autoresolve');

            if (autoresolve) {
                game.menuButton(player.name, autoresolve.arg, autoresolve.uuid, autoresolve.method);

                return true;
            }

            const preferred = buttons.filter(
                (button) => !NEVER_PRESS.includes(textOf(button.text))
            );
            const pool = preferred.length ? preferred : buttons;
            const button = pick(pool, this.rng);

            game.menuButton(player.name, button.arg, button.uuid, button.method);

            return true;
        }

        return false;
    }

    /**
     * The turn itself: play what can be played, use what can be used, then
     * end the turn. `getLegalActions` is the engine's own legality check, so
     * "can be played" here means precisely what it would mean to a human.
     */
    playFromMainWindow(game, player, buttons) {
        const playableFromHand = player.hand.filter(
            (card) => card.getLegalActions(player).length > 0
        );

        if (playableFromHand.length) {
            game.cardClicked(player.name, pick(playableFromHand, this.rng).uuid);

            return true;
        }

        const usableInPlay = player.cardsInPlay.filter(
            (card) => card.getLegalActions(player).length > 0
        );

        if (usableInPlay.length) {
            game.cardClicked(player.name, pick(usableInPlay, this.rng).uuid);

            return true;
        }

        return this.press(game, player, buttons, ['end turn']);
    }

    /**
     * Call the house this hand and board can do the most with: one point per
     * card in hand, one per ready card in play, and a whisper of randomness
     * so equal houses trade off across games instead of always resolving the
     * same way.
     */
    chooseHouse(game, player, buttons) {
        let best = null;
        let bestScore = -1;

        for (const button of buttons) {
            const house = textOf(button.text);
            const inHand = player.hand.filter((card) => card.hasHouse(house)).length;
            const ready = player.cardsInPlay.filter(
                (card) => card.hasHouse(house) && !card.exhausted
            ).length;
            const score = inHand + ready + this.rng() * 0.75;

            if (score > bestScore) {
                bestScore = score;
                best = button;
            }
        }

        if (!best) {
            return false;
        }

        const house = textOf(best.text);
        const calls = (this.houseCalls[player.name] = this.houseCalls[player.name] || {});

        calls[house] = (calls[house] || 0) + 1;

        if (!this.firstHouse[player.name]) {
            this.firstHouse[player.name] = house;
        }

        game.menuButton(player.name, best.arg, best.uuid, best.method);

        return true;
    }

    /** Press the first offered button whose text is in `wanted`. */
    press(game, player, buttons, wanted) {
        for (const text of wanted) {
            const button = buttons.find((candidate) => textOf(candidate.text) === text);

            if (button) {
                game.menuButton(player.name, button.arg, button.uuid, button.method);

                return true;
            }
        }

        return false;
    }
}

module.exports = { BotPolicy, NEVER_PRESS, ACTION_PREFERENCE };
