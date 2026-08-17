/**
 * ARCHON: the bot's playing policy - how a computer answers a prompt.
 *
 * Extracted from the Champion’s Challenge SimulatedGame (N18) as the honest,
 * plain baseline player, and today it is the Helper Bot's brain (the F9
 * practice opponent a human joins on the game node). The Challenge's own
 * sparring driver has since grown past it - N21 gave SimulatedGame seeded
 * determinism, decision logging, and a learned policy - but this class stays
 * the reference for how ANY prompt gets a safe answer, and its termination
 * guarantees hold wherever it sits.
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
 * of, build the board before playing the cards that need one, fight only
 * the fights it wins, reap with the rest, keep what it cannot use, end the
 * turn - wrapped in a completely generic prompt handler that can answer ANY
 * prompt the 2,700-odd card implementations can raise, because it answers
 * from the buttons and selectable cards the prompt itself publishes.
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

// ARCHON (N21/F9): the learned play. The move list is the one every bot
// enumerates, and the model that ranks it is the Champion's Challenge's
// reigning champion - so the opponent in the lobby plays what the lab
// learned, rather than a second, worse bot maintained separately.
const { chooseDecision } = require('../championschallenge/labPolicy');
const { decisionRecord } = require('../championschallenge/labFeatures');
const {
    INTENT_BUTTONS,
    bestCandidates,
    bestFightTarget,
    houseScore,
    mainWindowCandidates,
    textOf
} = require('./decisions');

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
// The opponent's request to switch manual mode on. Matched loosely because
// the title interpolates their name.
const MANUAL_MODE_MARKER = 'manual mode';

function pick(list, rng) {
    return list[Math.floor(rng() * list.length)];
}

class BotPolicy {
    /**
     * @param {object} [options]
     * @param {object} [options.policy] the Champion's Challenge model; absent
     *        falls back to the plain heuristics, which is also what a site
     *        that has never trained one gets
     * @param {function} [options.rng] injectable for reproducible tests
     */
    constructor(options = {}) {
        this.rng = options.rng || Math.random;
        this.policy = options.policy || null;
        // Set when a card is clicked for a specific reason, so the menu that
        // opens next is answered with the move that was intended rather than
        // by a fixed preference order.
        this.pendingIntent = null;
        // The creature that was sent to fight, held until the prompt asking
        // WHO it fights has been answered.
        this.attacker = null;

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
            // Back at the main window means the last card's menu is closed,
            // whatever became of it.
            this.pendingIntent = null;
            this.attacker = null;

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

        // --- Manual mode: always yes -------------------------------------
        //
        // The person across the table asked to switch manual mode on and the
        // engine is asking the bot to allow it. This used to fall through to
        // the generic "press something sensible" branch, which picks among
        // Yes and No at RANDOM - so the bot allowed it once and refused the
        // next time, for no reason anyone could see. A bot has nothing to
        // protect from manual mode and no way to judge the request, and the
        // person it is playing is the only one who can want it. Always yes.
        if (
            title.includes(MANUAL_MODE_MARKER) &&
            buttons.some((button) => textOf(button.text) === 'yes')
        ) {
            return this.press(game, player, buttons, ['yes']);
        }

        // --- Selection prompts --------------------------------------------
        if (state.selectCard && selectable.length) {
            const selected = state.selectedCards || [];
            const unselected = selectable.filter((card) => !selected.includes(card));
            const doneButton = buttons.find((button) => textOf(button.text) === 'done');

            // Keep selecting while the prompt wants more; press Done once it
            // is offered and something is selected (or nothing CAN be).
            if (unselected.length && (!doneButton || !selected.length)) {
                // The one prompt the bot can answer with judgement rather
                // than a coin flip: having sent a creature to fight, this is
                // the engine asking whom. Every other selection is a card
                // ability's own question, and the bot has no business
                // guessing at those.
                const target = bestFightTarget(this.attacker, unselected);

                this.attacker = null;

                game.cardClicked(player.name, (target || pick(unselected, this.rng)).uuid);

                return true;
            }

            if (doneButton) {
                game.menuButton(player.name, doneButton.arg, doneButton.uuid, doneButton.method);

                return true;
            }
        }

        // --- Any other prompt: press something sensible -------------------
        if (buttons.length) {
            // The menu that follows a card click is answered with the move
            // the choice was made for - a creature picked to fight is not
            // reaped on the way through. Cleared either way, so a stale
            // intent cannot steer a later, unrelated prompt.
            if (this.pendingIntent) {
                const wanted = INTENT_BUTTONS[this.pendingIntent.kind] || [];

                this.pendingIntent = null;

                if (wanted.length && this.press(game, player, buttons, wanted)) {
                    return true;
                }
            }

            // Otherwise by preference - play beats reap beats fight beats
            // discard - so a card clicked to be played is not then discarded
            // on a coin flip.
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
     * The turn itself: choose a move, or end the turn when none is left.
     *
     * The candidate list is the engine's own legality check (`getLegalActions`
     * via the shared enumeration), so every option here is one a human could
     * take. With a learned model the choice is the model's; without one it is
     * the old order - play out the hand, then use the board, preferring to
     * reap. End Turn is offered only once nothing else remains, which is what
     * stops a young model from discovering the strategy of doing nothing.
     */
    playFromMainWindow(game, player, buttons) {
        const { hand, inPlay, candidates } = mainWindowCandidates(player);

        if (!candidates.length) {
            return this.press(game, player, buttons, ['end turn']);
        }

        const chosen = this.chooseCandidate(game, player, candidates);
        const list = chosen.list === 'hand' ? hand : inPlay;
        const card = list[chosen.index];

        if (!card) {
            return this.press(game, player, buttons, ['end turn']);
        }

        // Remember WHY this card was clicked: the menu that opens next is
        // answered with that move rather than by preference order, so a
        // creature chosen to fight is not reaped on the way through.
        this.pendingIntent = chosen.list === 'play' ? { kind: chosen.kind } : null;
        this.attacker = chosen.kind === 'fight' ? card : null;

        game.cardClicked(player.name, card.uuid);

        return true;
    }

    /**
     * Rank the moves: the learned model when there is one, else the plain
     * player's order.
     *
     * The fallback is not a stub. Until a site has run the Champion's
     * Challenge there IS no model, so this order is what every practice
     * opponent plays - it has to be sound by itself. It lives in the shared
     * move module so the lab's own unmodelled play matches it exactly.
     */
    chooseCandidate(game, player, candidates) {
        if (this.policy && candidates.length > 1) {
            const records = candidates.map((candidate) =>
                decisionRecord(game, player, { kind: candidate.kind, card: candidate.card })
            );
            // Temperature zero: a practice opponent performs, it does not
            // explore. Exploration is the lab's job, where the games are
            // training data and nobody is waiting.
            const index = chooseDecision(this.policy, records, 0, this.rng);

            return candidates[Math.max(0, index)];
        }

        return pick(bestCandidates(player, candidates), this.rng);
    }

    /**
     * Call the house this hand and board can do the most with - and, when
     * the opponent forges at the start of their next turn, the house that
     * can take that amber off them first. The scoring is shared with the lab
     * (`decisions.houseScore`); the whisper of randomness on top is so equal
     * houses trade off across games instead of always resolving the same way.
     */
    chooseHouse(game, player, buttons) {
        let best = null;

        if (this.policy && buttons.length > 1) {
            const records = buttons.map((button) =>
                decisionRecord(game, player, {
                    kind: 'houseCall',
                    house: textOf(button.text),
                    player
                })
            );
            const index = chooseDecision(this.policy, records, 0, this.rng);

            best = buttons[Math.max(0, index)] || null;
        }

        if (!best) {
            let bestScore = -1;

            for (const button of buttons) {
                const score = houseScore(player, textOf(button.text)) + this.rng() * 0.75;

                if (score > bestScore) {
                    bestScore = score;
                    best = button;
                }
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
