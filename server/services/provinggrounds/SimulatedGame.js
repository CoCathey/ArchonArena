const { randomUUID } = require('node:crypto');

// The playing policy itself - how any prompt is answered - lives in
// services/botplayer/BotPolicy so the Helper Bot table (F9) plays with
// exactly the same hands. This file keeps what is the LAB's: the loop, the
// caps, the yields, and the result record.
const { BotPolicy } = require('../botplayer/BotPolicy');

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
 * shortcut: what the lab needs first is games that always FINISH. The policy
 * (see BotPolicy) answers any prompt from the buttons and selectable cards
 * the prompt itself publishes; this driver adds the lab's own termination
 * guards:
 *
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
        this.policy = new BotPolicy({ rng: this.rng });
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

                if (this.policy.respond(game, player)) {
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
            winnerFirstHouse: this.policy.firstHouse[winner] || null,
            loserFirstHouse: this.policy.firstHouse[loser] || null,
            winnerHouseCalls: this.policy.houseCalls[winner] || {},
            loserHouseCalls: this.policy.houseCalls[loser] || {},
            interactions: this.interactions,
            durationMs: Date.now() - startedAt
        };
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
