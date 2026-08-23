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
    bestFateCard,
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
// Asked after the bot clicks one of its prophecies.
const ACTIVATE_PROPHECY_TITLE = 'activate prophecy?';
// "Choose a card from your hand to place under the prophecy" - the cost of
// activating one, and a decision rather than a formality.
const FATE_CARD_MARKER = 'under the prophecy';

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
        /**
         * ARCHON (N52): whether the house call is PLANNED rather than scored.
         *
         * An object of planner options ({samples, budgetMs, seed}) turns it on;
         * null - the default, and what every rollout inside the planner itself
         * gets - leaves the policy exactly as it was. That default is what
         * stops a plan from planning: the pilot flying a rollout must be the
         * plain greedy one, or the first house call inside the first rollout
         * would start a second planner.
         */
        this.planner = options.planner || null;
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

        if (title === ACTIVATE_PROPHECY_TITLE) {
            // This prompt exists only because the bot clicked the prophecy,
            // and it clicked it because it chose to. Answering Yes here
            // rather than from the intent alone also closes the one loop
            // this move could form: a No leaves the prophecy activatable,
            // and the main window would offer it again forever.
            return this.press(game, player, buttons, ['yes']);
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
                // Two prompts the bot can answer with judgement rather than
                // a coin flip: which creature to attack, having sent one to
                // fight, and which card to bury under a prophecy it just
                // activated. Every other selection is a card ability's own
                // question, and the bot has no business guessing at those.
                const chosen = title.includes(FATE_CARD_MARKER)
                    ? bestFateCard(player, unselected)
                    : bestFightTarget(this.attacker, unselected);

                this.attacker = null;

                game.cardClicked(player.name, (chosen || pick(unselected, this.rng)).uuid);

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

            const button = this.chooseButton(game, player, buttons, title);

            game.menuButton(player.name, button.arg, button.uuid, button.method);

            return true;
        }

        return false;
    }

    /**
     * ARCHON: which button to press, when nothing fixed applies.
     *
     * This is the prompt a card raises - "would you like to use this?",
     * "choose a house", which of two triggers goes first - and there are a
     * great many of them: nearly every optional ability in KeyForge arrives
     * here. It used to be answered by picking a button at random, which made
     * a large part of the game a coin flip.
     *
     * With the champion model it is scored like any other decision, on the
     * prompt's title and the button's own text (labFeatures' `button` kind).
     * Without one it presses **Yes**: an optional ability is shown to the
     * player it benefits, so accepting is the better half of the coin - and
     * the ones where it would not be (concede, cancel) never reach here.
     */
    chooseButton(game, player, buttons, title) {
        const preferred = buttons.filter((button) => !NEVER_PRESS.includes(textOf(button.text)));
        const pool = preferred.length ? preferred : buttons;

        if (pool.length === 1) {
            return pool[0];
        }

        if (this.policy) {
            const records = pool.map((button) =>
                decisionRecord(game, player, {
                    kind: 'button',
                    prompt: title,
                    button: textOf(button.text)
                })
            );
            const index = chooseDecision(this.policy, records, 0, this.rng);

            return pool[Math.max(0, index)];
        }

        return pool.find((button) => textOf(button.text) === 'yes') || pick(pool, this.rng);
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
        const { hand, inPlay, prophecies, candidates } = mainWindowCandidates(player);

        if (!candidates.length) {
            return this.press(game, player, buttons, ['end turn']);
        }

        const chosen = this.chooseCandidate(game, player, candidates);
        const lists = { hand, play: inPlay, prophecy: prophecies };
        const card = (lists[chosen.list] || [])[chosen.index];

        if (!card) {
            return this.press(game, player, buttons, ['end turn']);
        }

        // A prophecy is not clicked the way a card is: it sits beside the
        // board rather than in a zone, and the engine has its own entry
        // point for it.
        if (chosen.list === 'prophecy') {
            this.pendingIntent = { kind: chosen.kind };
            this.attacker = null;

            game.clickProphecy(player.name, card.uuid);

            return true;
        }

        // Remember WHY this card was clicked: the menu that opens next is
        // answered with that move rather than by preference order, so a
        // creature chosen to fight is not reaped on the way through - and a
        // card chosen for the bin is not played instead, which is the whole
        // point of enumerating the two separately.
        this.pendingIntent = { kind: chosen.kind };
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

        /**
         * ARCHON (N52): find out, rather than guess.
         *
         * Every other branch here scores a DESCRIPTION of the choice - the
         * model's weights over a house-call record, or `houseScore` counting
         * what the hand holds. Neither can express what N46 named as the
         * reason this decision was unmodellable: a house call's consequence is
         * the whole rest of the turn.
         *
         * So when a planner is configured, the turn is played out under each
         * house in a fork and the choice is made on where they ended. It
         * declines - returning null - on a position that cannot be forked, on
         * a table with no champion to score with, and whenever it could not
         * afford one world for every house; all three fall through to the
         * scoring below, which is what the bot has always done.
         */
        if (this.planner && this.policy && buttons.length > 1) {
            const { planHouse } = require('./turnPlanner');
            // `player.game`, NOT this method's `game`. Everything else in this
            // class dispatches through the CLIENT it was handed - the object
            // with cardClicked/menuButton/clickProphecy that a driver passes as
            // `game` - which is exactly the point: a bot presses buttons like a
            // browser does and cannot reach into state. A planner is the one
            // thing here that needs the real engine object to copy it, and the
            // seat is the honest way to ask for it.
            const plan = planHouse(player.game, player, buttons, {
                ...this.planner,
                policy: this.policy
            });

            if (plan) {
                best = buttons.find((button) => textOf(button.text) === plan.house) || null;
            }
        }

        if (!best && this.policy && buttons.length > 1) {
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
