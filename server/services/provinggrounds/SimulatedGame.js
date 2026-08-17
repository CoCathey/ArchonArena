const { randomUUID } = require('node:crypto');

/**
 * ARCHON (N18): one simulated game, played start to finish by the computer.
 *
 * This is the sparring partner behind the Proving Grounds: it drives the real
 * gameplay engine through the ordinary player interface - the same
 * `menuButton`/`cardClicked` calls a browser click becomes - so a simulated
 * game obeys exactly the rules a real one does, card fixes and all. Nothing
 * here reaches into game state to move cards or amber; if the engine would
 * not offer a human the button, the bot cannot press it.
 *
 * The player is honest but plain, and that is a design choice rather than a
 * shortcut: what the lab needs first is games that always FINISH. Strength
 * can grow later (F9 wants the same driver as a showcase and a practice
 * opponent); a stalled game poisons a whole sweep today. So the policy is a
 * few sound KeyForge instincts - call the house you can use most of, play
 * everything playable, reap with what is ready, end the turn - wrapped in a
 * completely generic prompt handler that can answer ANY prompt the 2,700-odd
 * card implementations can raise, because it answers from the buttons and
 * selectable cards the prompt itself publishes.
 *
 * Termination is treated as a hard requirement rather than a hope:
 *
 *  - `Done`/`Autoresolve` are pressed once a selection prompt has what it
 *    needs (a multi-select prompt only completes on Done - a driver that
 *    never presses it spins forever; found empirically).
 *  - `Cancel` is never pressed while any other button exists, so the bot
 *    cannot open a card menu, cancel it, and open it again all day.
 *  - The loop stops the moment `game.winner` is set, BEFORE dispatching
 *    another input - the engine queues a rematch prompt after a win, and a
 *    click-anything bot would cheerfully start a rematch.
 *  - A turn cap and an interaction cap bound the pathological cases. A game
 *    that hits either is reported as non-terminating and recorded nowhere.
 *
 * Fully synchronous inside the engine (no timers unless a time limit is
 * asked for, and none is), but the driver yields to the event loop every few
 * moves: a whole game is roughly half a second of CPU, and the lobby it runs
 * in has real players whose latency matters more than the bot's.
 */

const PLAYER_ONE = 'proving-alpha';
const PLAYER_TWO = 'proving-omega';

// Buttons the bot must never press while any alternative exists. Concede and
// rematch protect the game; manual-mode toggles protect the simulation's
// honesty.
const NEVER_PRESS = ['cancel', 'concede'];

// When a card menu is open, take the first of these that is offered. Play
// everything, ready the board, harvest amber, and only then look for a fight
// - the lab wants games that end, and amber is what ends them.
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

/** Prompt titles the driver gives special answers to. */
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

class SimulatedGame {
    /**
     * @param {object} deckAlpha engine-ready deck: { name, uuid, expansion, houses, cards: [{ id, count, card, ... }] }
     * @param {object} deckOmega same shape
     * @param {object} [options]
     * @param {number} [options.maxTurns] abort past this many player turns
     * @param {number} [options.maxInteractions] abort past this many inputs
     * @param {number} [options.yieldEvery] event-loop yield cadence, in inputs
     * @param {function} [options.rng] injectable for reproducible tests
     */
    constructor(deckAlpha, deckOmega, options = {}) {
        this.deckAlpha = deckAlpha;
        this.deckOmega = deckOmega;
        this.maxTurns = options.maxTurns || 80;
        this.maxInteractions = options.maxInteractions || 5000;
        this.yieldEvery = options.yieldEvery || 20;
        this.rng = options.rng || Math.random;

        this.interactions = 0;
        this.houseCalls = { [PLAYER_ONE]: {}, [PLAYER_TWO]: {} };
        this.firstHouse = { [PLAYER_ONE]: null, [PLAYER_TWO]: null };
    }

    /**
     * Play the game to completion.
     *
     * @returns {Promise<object>} `{ completed, winner, loser, winnerDeck, loserDeck,
     *   winnerKeys, loserKeys, turns, winnerWentFirst, winnerFirstHouse,
     *   loserFirstHouse, winnerHouseCalls, loserHouseCalls, interactions,
     *   durationMs }` - or `{ completed: false, reason }` for a game that had
     *   to be abandoned. Abandoned games are the caller's cue to record
     *   nothing.
     */
    async run() {
        const startedAt = Date.now();

        // Loaded here rather than at module load: requiring the engine pulls
        // in ~2,600 card classes (~0.7s, once per process), and the lobby
        // should not pay that at boot for a sweep that may be disabled.
        const Game = require('../../game/game.js');
        const Settings = require('../../settings.js');

        const makeUser = (username) =>
            Settings.getUserWithDefaultsSet({
                username,
                settings: {
                    optionSettings: {
                        // Let the engine resolve forced triggers in queue
                        // order instead of prompting the bot to order them.
                        orderForcedAbilities: false,
                        // A card with one legal action resolves on click.
                        confirmOneClick: false
                    }
                }
            });

        const alpha = makeUser(PLAYER_ONE);
        const omega = makeUser(PLAYER_TWO);

        const game = new Game(
            {
                id: randomUUID(),
                name: 'Proving Grounds',
                owner: alpha,
                saveGameId: 0,
                players: [
                    { id: `pg-${PLAYER_ONE}`, user: alpha },
                    { id: `pg-${PLAYER_TWO}`, user: omega }
                ]
            },
            {
                router: {
                    gameWon: () => true,
                    playerLeft: () => true,
                    handleError: (_, error) => {
                        throw error;
                    }
                },
                cardData: {}
            }
        );

        game.started = true;
        // The lab never replays these games; skipping board snapshots saves
        // both time and a few megabytes per game.
        game.recordBoardSnapshot = () => true;

        game.selectDeck(PLAYER_ONE, this.deckAlpha);
        game.selectDeck(PLAYER_TWO, this.deckOmega);
        game.initialise();

        // The engine has already flipped for first player inside
        // initialise(); leave its choice standing so the lab measures
        // first-turn advantage instead of erasing it.
        const firstPlayerName = game.firstPlayer && game.firstPlayer.name;

        let stuckCycles = 0;

        while (!game.winner) {
            if (this.interactions >= this.maxInteractions) {
                return { completed: false, reason: 'interaction-cap' };
            }

            if (game.round > this.maxTurns) {
                return { completed: false, reason: 'turn-cap' };
            }

            let acted = false;

            for (const player of game.getPlayers()) {
                if (game.winner) {
                    break;
                }

                if (this.respond(game, player)) {
                    acted = true;
                    this.interactions++;
                    game.continue();

                    if (this.interactions % this.yieldEvery === 0) {
                        // Let the lobby breathe between moves.
                        await new Promise((resolve) => setImmediate(resolve));
                    }
                }
            }

            if (!acted) {
                // Neither player had a button or a selectable card. One quiet
                // cycle can happen around pipeline boundaries; fifty in a row
                // is a wedged game.
                game.continue();

                if (++stuckCycles > 50) {
                    return { completed: false, reason: 'no-legal-input' };
                }
            } else {
                stuckCycles = 0;
            }
        }

        const winner = game.winner.name;
        const loser = winner === PLAYER_ONE ? PLAYER_TWO : PLAYER_ONE;
        const winnerIsAlpha = winner === PLAYER_ONE;

        return {
            completed: true,
            winner,
            loser,
            winnerDeck: winnerIsAlpha ? this.deckAlpha : this.deckOmega,
            loserDeck: winnerIsAlpha ? this.deckOmega : this.deckAlpha,
            winnerKeys: game.getPlayerByName(winner).getForgedKeys(),
            loserKeys: game.getPlayerByName(loser).getForgedKeys(),
            turns: game.round,
            winReason: game.winReason,
            winnerWentFirst: firstPlayerName === winner,
            winnerFirstHouse: this.firstHouse[winner],
            loserFirstHouse: this.firstHouse[loser],
            winnerHouseCalls: this.houseCalls[winner],
            loserHouseCalls: this.houseCalls[loser],
            interactions: this.interactions,
            durationMs: Date.now() - startedAt
        };
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

        this.houseCalls[player.name][house] = (this.houseCalls[player.name][house] || 0) + 1;

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

/**
 * Play one simulated game between two engine-ready decks.
 *
 * @returns {Promise<object>} see {@link SimulatedGame#run}
 */
async function runSimulatedGame(deckAlpha, deckOmega, options) {
    return new SimulatedGame(deckAlpha, deckOmega, options).run();
}

module.exports = { SimulatedGame, runSimulatedGame, PLAYER_ONE, PLAYER_TWO };
