const logger = require('../log');
const { decisionRecord } = require('../services/championschallenge/labFeatures');
const { INTENT_BUTTONS, mainWindowCandidates, textOf } = require('../services/botplayer/decisions');
// The bot's own pool filter, imported rather than copied: "was there a choice
// here" has to get the same answer on both sides of the table, and a second
// copy of the list is a second thing to forget.
const { NEVER_PRESS } = require('../services/botplayer/BotPolicy');

/**
 * ARCHON (N45): what the person across the table just decided, written down
 * in the bot's own handwriting.
 *
 * The Champion's Challenge learns from the bot playing itself, which is a
 * closed system: it can get steadily better at beating its own habits and
 * never learn that the habits are the problem. The one source of moves the
 * lab cannot generate is a person, and the site already runs thousands of
 * games where one is sitting right there.
 *
 * ## The rows have to be identical to the bot's, or they are worse than useless
 *
 * A model is a weight per feature. Feed it rows whose features were computed
 * slightly differently and it does not learn less - it learns something
 * wrong, confidently, and there is no signal in the output that says so. This
 * is why the capture happens HERE, live, on the game node, at the moment the
 * human's click arrives and BEFORE the engine runs it:
 *
 *  - `decisionRecord` is called with the same (game, player, action) triple
 *    the bot's own driver passes. There is no second feature extractor to go
 *    out of step with the first.
 *  - The position is the one the move was chosen FROM. A row built after the
 *    engine resolved the move would describe the consequence and label it as
 *    the cause.
 *  - Deck composition features (labFeatures reads what is LEFT in the deck)
 *    exist here and do not exist in a replay. Rebuilding these rows from a
 *    recording afterwards was the obvious cheap route and it is a trap: a
 *    recording knows a deck's SIZE, not its contents, so those features would
 *    be absent - and absent reads as FALSE, not as unknown. Every human row
 *    would then carry a quiet, systematic lie.
 *
 * ## Only the choices the bot would also have scored
 *
 * The bot answers a great many prompts from fixed rules rather than from the
 * model - the mulligan, the end-of-turn confirmation, its own prophecy
 * question - and it never scores a choice it did not have (one button, one
 * legal move). Capturing those would teach the model that forced moves are
 * good moves, weighted by however often the engine forces them. So this
 * mirrors the bot's skip list exactly, and a decision with fewer than two
 * options is not a decision.
 *
 * Never throws into gameplay. A capture is a nice-to-have; the game is not.
 */

/** The prompt titles the policy reads, lower-cased as `textOf` leaves them. */
const MAIN_WINDOW_TITLE = 'choose a card to play, discard or use';
const HOUSE_CHOICE_TITLE = 'choose which house you want to activate this turn';

/**
 * Prompts the bot answers from a rule rather than from the model. A human's
 * answer to one of these is not a row the bot could ever use, and minting a
 * prompt weight for it would put keys in the model that play never reaches.
 */
const UNSCORED_TITLES = [
    'are you sure you want to end your turn?',
    'keep starting hand?',
    'activate prophecy?'
];

/** Matched loosely - the title interpolates the asking player's name. */
const UNSCORED_MARKERS = ['manual mode'];

/**
 * Buttons that end or advance a prompt rather than answer it. Pressing Done
 * is not a choice about the game; it is saying the choices are finished.
 */
const NOT_A_MOVE = ['cancel', 'concede', 'done', 'autoresolve'];

/** Which move a card-menu button expresses - `INTENT_BUTTONS`, read backwards. */
const KIND_BY_BUTTON = new Map();

for (const [kind, titles] of Object.entries(INTENT_BUTTONS)) {
    for (const title of titles) {
        KIND_BY_BUTTON.set(title, kind);
    }
}

/**
 * A ceiling on one game's rows, so a pathological table cannot inflate the
 * GAMEWIN payload without bound. A long KeyForge game is a few hundred
 * decisions across both seats; this is far above that and exists only as a
 * backstop. Excess is dropped and counted, never silently.
 */
const MAX_DECISIONS = 800;

class HumanCapture {
    /**
     * @param {string[]} humanNames the seats to capture - everyone at the
     *        table who is not a bot
     */
    constructor(humanNames = []) {
        this.humans = new Set(humanNames);
        this.decisions = [];
        this.dropped = 0;
        // A main-window click names the CARD; the menu that opens next names
        // the MOVE. The row waits here in between, per seat.
        this.pending = new Map();
    }

    /** Whether this table is capturing anything at all. */
    get active() {
        return this.humans.size > 0;
    }

    /**
     * Note one command a human is about to send into the engine.
     *
     * MUST be called before the engine runs it: the row describes the
     * position the move was chosen from.
     *
     * @param {object} game the live game
     * @param {string} playerName who sent it
     * @param {string} command the engine method the client asked for
     * @param {any[]} args its arguments
     * @returns {boolean} whether a row was written
     */
    note(game, playerName, command, args = []) {
        if (!this.humans.has(playerName) || !game || game.winner) {
            return false;
        }

        const player = game.getPlayerByName ? game.getPlayerByName(playerName) : null;

        if (!player || !player.promptState) {
            return false;
        }

        try {
            return this.capture(game, player, command, args);
        } catch (err) {
            // A half-made move whose reading threw is dropped rather than
            // resolved against a state nobody can vouch for.
            this.pending.delete(playerName);
            logger.error('Human capture: could not read a decision', err);

            return false;
        }
    }

    /** @private */
    capture(game, player, command, args) {
        const state = player.promptState;
        const title = textOf(state.menuTitle);

        if (command === 'cardClicked') {
            return this.noteCardClick(game, player, state, title, args[0]);
        }

        if (command === 'menuButton') {
            return this.noteButton(game, player, state, title, args);
        }

        if (command === 'clickProphecy') {
            const pending = this.pending.get(player.name);

            this.pending.delete(player.name);

            if (title !== MAIN_WINDOW_TITLE) {
                return false;
            }

            const { candidates } = mainWindowCandidates(player);
            const chosen = candidates.find(
                (candidate) => candidate.card && candidate.card.uuid === args[0]
            );

            return chosen && !pending
                ? this.push(
                      game,
                      player,
                      { kind: chosen.kind, card: chosen.card },
                      candidates.length
                  )
                : false;
        }

        // Chat, settings, manual-mode toggles: not moves, and not disturbances
        // either - a card's menu is still open behind them, so a half-made
        // move is left standing rather than thrown away for a message. What
        // protects a stale one from resolving against an unrelated prompt is
        // the kind check below, not this.
        return false;
    }

    /**
     * A card click: either the answer to a selection prompt, or the first
     * half of a main-window move.
     *
     * @private
     */
    noteCardClick(game, player, state, title, cardId) {
        const selectable = state.selectableCards || [];

        if (state.selectCard && selectable.length) {
            this.pending.delete(player.name);

            const selected = state.selectedCards || [];
            const unselected = selectable.filter((card) => !selected.includes(card));
            const card = unselected.find((entry) => entry.uuid === cardId);

            return card
                ? this.push(
                      game,
                      player,
                      { kind: 'select', card, prompt: state.menuTitle },
                      unselected.length
                  )
                : false;
        }

        if (title !== MAIN_WINDOW_TITLE) {
            this.pending.delete(player.name);

            return false;
        }

        const { candidates } = mainWindowCandidates(player);
        const forThisCard = candidates.filter(
            (candidate) => candidate.card && candidate.card.uuid === cardId
        );

        if (!forThisCard.length) {
            this.pending.delete(player.name);

            return false;
        }

        // Held, not written. Which move this becomes is the next press, and a
        // click that is cancelled was never a move at all.
        this.pending.set(player.name, {
            card: forThisCard[0].card,
            kinds: new Set(forThisCard.map((candidate) => candidate.kind)),
            choices: candidates.length
        });

        return false;
    }

    /**
     * A button press: the second half of a main-window move, a house call, or
     * a card's own question.
     *
     * @private
     */
    noteButton(game, player, state, title, args) {
        const buttons = (state.buttons || []).filter((button) => !button.disabled);
        const pressed = pressedButton(buttons, args);
        const pending = this.pending.get(player.name);

        this.pending.delete(player.name);

        if (!pressed) {
            return false;
        }

        const text = textOf(pressed.text);

        // The menu a clicked card opened. Reap and fight are the same click
        // and different moves, which is exactly why the row waited for this.
        //
        // The board cannot have changed since the click: opening a card's menu
        // asks a question, it does not resolve anything, so the position read
        // here is still the one the move is being chosen from.
        if (pending) {
            const kind = KIND_BY_BUTTON.get(text);

            if (kind && pending.kinds.has(kind)) {
                return this.push(game, player, { kind, card: pending.card }, pending.choices);
            }

            // Not one of that card's moves. If the card's own menu is still
            // what is open - a Cancel, or an action the enumeration did not
            // offer - the click is simply abandoned, and nothing here is a
            // decision to record. If some OTHER prompt is open, the click has
            // already resolved into something and this is a fresh question,
            // which falls through and is handled like any other.
            if (buttons.some((button) => KIND_BY_BUTTON.has(textOf(button.text)))) {
                return false;
            }
        }

        if (title === HOUSE_CHOICE_TITLE) {
            return this.push(
                game,
                player,
                { kind: 'houseCall', house: text, player },
                buttons.length
            );
        }

        if (NOT_A_MOVE.includes(text) || this.unscored(title)) {
            return false;
        }

        // The same pool `BotPolicy.chooseButton` scores, so "was there a
        // choice here" gets the same answer on both sides of the table.
        const preferred = buttons.filter((button) => !NEVER_PRESS.includes(textOf(button.text)));
        const pool = preferred.length ? preferred : buttons;

        return this.push(
            game,
            player,
            { kind: 'button', prompt: state.menuTitle, button: text },
            pool.length
        );
    }

    /** @private */
    unscored(title) {
        return (
            UNSCORED_TITLES.includes(title) ||
            UNSCORED_MARKERS.some((marker) => title.includes(marker))
        );
    }

    /**
     * Write the row, if there was a decision to write.
     *
     * @private
     * @param {number} choices how many options the seat was choosing between
     */
    push(game, player, action, choices) {
        if (!(choices > 1)) {
            // A forced move is not evidence of anything. Training on one
            // teaches the model that whatever the engine compels is good.
            return false;
        }

        if (this.decisions.length >= MAX_DECISIONS) {
            this.dropped++;

            return false;
        }

        this.decisions.push(decisionRecord(game, player, action));

        return true;
    }

    /**
     * The finished game, in the shape the diary stores.
     *
     * `winnerSide` is a player NAME, which is what `decisionRecord` puts in
     * each row's `side` and what `trainModel` compares it against - so a
     * human game reads exactly like a sparring game to the trainer.
     *
     * @param {string} winnerName
     * @param {string} [reason] why the game ended, from `recordWinner`
     * @returns {{winnerSide: string, decisions: object[]}|null}
     */
    harvest(winnerName, reason) {
        if (!winnerName || !this.decisions.length) {
            return null;
        }

        /**
         * A conceded game is thrown, not lost. Every move the conceder made
         * gets labelled a losing move, including the good ones, and people
         * concede for reasons that have nothing to do with the position -
         * they are late, the connection is bad, they have seen enough. The
         * lab's own bots never do it, so nothing else in the diary carries
         * this distortion and there is no reason to start.
         *
         * An abandoned game is the same thing without the button.
         */
        if (reason === 'concede' || reason === 'abandoned') {
            return null;
        }

        if (this.dropped) {
            logger.info(
                `Human capture: ${this.dropped} decisions past the per-game ceiling were dropped`
            );
        }

        return { winnerSide: winnerName, decisions: this.decisions };
    }
}

/**
 * The button the client pressed, matched on the triple it sends back.
 *
 * Exact first; falling back to the arg alone covers prompts whose buttons
 * carry no uuid or method. Ambiguity resolves to nothing rather than to a
 * guess - a row attributed to the wrong button is worse than no row.
 */
function pressedButton(buttons, [arg, uuid, method] = []) {
    const same = (left, right) =>
        (left === undefined ? null : left) === (right === undefined ? null : right);
    const exact = buttons.filter(
        (button) => same(button.arg, arg) && same(button.uuid, uuid) && same(button.method, method)
    );

    if (exact.length === 1) {
        return exact[0];
    }

    const byArg = buttons.filter((button) => same(button.arg, arg));

    return byArg.length === 1 ? byArg[0] : null;
}

module.exports = HumanCapture;
module.exports.MAX_DECISIONS = MAX_DECISIONS;
