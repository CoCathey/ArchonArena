const { randomUUID } = require('node:crypto');

const { withRandomSource, seededSource } = require('../../game/secureRandom');
const { decisionRecord } = require('./labFeatures');
const { chooseDecision } = require('./labPolicy');
// ARCHON (F9): the move list itself is shared with the practice bots, so the
// opponent a player meets in the lobby enumerates exactly what this lab
// learned on - and a deep game's fork enumerates exactly what its live game
// did. See services/botplayer/decisions.
const {
    INTENT_BUTTONS,
    activatableProphecies,
    bestCandidates,
    bestFateCard,
    bestFightTarget,
    houseScore,
    playableFromHand,
    usableInPlay,
    mainWindowCandidates
} = require('../botplayer/decisions');

/**
 * ARCHON (N18/N21): one simulated game, played start to finish by the computer.
 *
 * This drives the real gameplay engine through the ordinary player interface -
 * the same `menuButton`/`cardClicked` calls a browser click becomes - so a
 * simulated game obeys exactly the rules a real one does. Nothing here reaches
 * into game state to move cards or amber; if the engine would not offer a
 * human the button, the bot cannot press it.
 *
 * Since N21 the player has two brains and a memory:
 *
 *  - **The policy.** With no model it plays the original sound-but-plain
 *    heuristics. Given a learned model (labPolicy) it scores every candidate
 *    decision - which house to call, which card to play, reap or fight - and
 *    picks by softmax (training games explore) or argmax (arena and showcase
 *    games do not). The learned bot chooses among exactly the moves the
 *    heuristic bot could make, so every termination guarantee is inherited.
 *  - **The record.** Run with a seed and the game is DETERMINISTIC: all
 *    engine randomness draws from a scoped generator (secureRandom's
 *    AsyncLocalStorage source - real games never enter the scope), and every
 *    input the bots issue is logged by list-position. Replaying the log with
 *    the same seed reconstructs the exact game to any point, which is what
 *    lets the deep planner fork a live decision and try the road not taken -
 *    with the card's REAL ability code deciding what happens.
 *  - **The diary.** With recording on, each chosen decision's features are
 *    kept, and the finished game labels them: that is the training data the
 *    learning loop turns into the next policy.
 *
 * Termination is still a hard requirement, enforced the same ways as ever:
 * Done/Autoresolve pressed once a selection prompt has what it needs, Cancel
 * never pressed while an alternative exists, the loop stopped on
 * `game.winner` BEFORE the rematch prompt, and turn/interaction caps
 * abandoning the pathological game, which is recorded nowhere.
 *
 * Sibling: the Helper Bot a human joins (F9) plays the plain baseline
 * policy, kept as services/botplayer/BotPolicy - it needs no seed, no log,
 * and no diary, so it did not follow this file into N21.
 */

const PLAYER_ONE = 'challenger-alpha';
const PLAYER_TWO = 'challenger-omega';
// A KeyForge deck is 36 cards. Anything under this is not a deck that lost, it
// is a deck that failed to build - see the short-deck guard in runInner.
const MIN_DECK = 30;

/** Buttons the bot must never press while any alternative exists. */
const NEVER_PRESS = ['cancel', 'concede'];

/**
 * Menu preference when no intent and no policy applies: play everything,
 * ready the board, harvest amber, then look for a fight.
 */
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

/** Menu button texts that satisfy each intended in-play action kind. */
const MAIN_WINDOW_TITLE = 'choose a card to play, discard or use';
const HOUSE_CHOICE_TITLE = 'choose which house you want to activate this turn';
const END_TURN_CONFIRM_TITLE = 'are you sure you want to end your turn?';
const MULLIGAN_TITLE = 'keep starting hand?';
const ACTIVATE_PROPHECY_TITLE = 'activate prophecy?';
// The cost of activating a prophecy: a card from hand, buried under it.
const FATE_CARD_MARKER = 'under the prophecy';

/** menuTitle / button.text can be a string or { text, values }. */
function textOf(value) {
    if (!value) {
        return '';
    }

    return String(typeof value === 'object' ? value.text || '' : value).toLowerCase();
}

class SimulatedGame {
    /**
     * @param {object} deckAlpha engine-ready deck: { name, uuid, expansion, houses, cards: [{ id, count, card, ... }] }
     * @param {object} deckOmega same shape
     * @param {object} [options]
     * @param {number} [options.maxTurns] abandon past this many player turns
     * @param {number} [options.maxInteractions] abandon past this many inputs
     * @param {number} [options.yieldEvery] event-loop yield cadence, in inputs
     * @param {number} [options.seed] run deterministically under this seed,
     *        recording the input log (replay/forking requires it)
     * @param {object} [options.policy] a labPolicy model; absent = heuristics
     * @param {number} [options.temperature] softmax exploration; 0 = greedy
     * @param {boolean} [options.recordDecisions] keep training records
     * @param {boolean} [options.fingerprints] keep per-input state prints (specs/forks)
     * @param {function} [options.rng] injectable for tests
     */
    constructor(deckAlpha, deckOmega, options = {}) {
        this.deckAlpha = deckAlpha;
        this.deckOmega = deckOmega;
        this.maxTurns = options.maxTurns || 80;
        this.maxInteractions = options.maxInteractions || 5000;
        this.yieldEvery = options.yieldEvery || 20;
        this.seed = options.seed;
        this.policy = options.policy || null;
        // Per-seat brains, for arena games where a candidate meets the
        // champion head to head: { alpha, omega }, either side null for the
        // heuristics. Falls back to the single `policy` for both seats.
        this.policies = options.policies || null;
        this.temperature = options.temperature || 0;
        this.recordDecisions = !!options.recordDecisions;
        this.keepFingerprints = !!options.fingerprints;

        // Two SEPARATE streams on purpose. The engine's shuffles draw from
        // the scoped source; the bot's own dice (candidate picks, softmax,
        // tiebreaks) draw from a stream derived from the seed. A replay
        // re-issues the bot's recorded choices without rolling its dice, so
        // if the two shared one stream, every bot roll the replay skips
        // would shift the engine's draws and fork a subtly different game.
        this.source =
            this.seed !== undefined && this.seed !== null ? seededSource(this.seed) : null;

        if (options.rng) {
            this.rng = options.rng;
        } else if (this.source) {
            const botDice = seededSource((this.seed ^ 0x9e3779b9) >>> 0);

            this.rng = () => botDice.next();
        } else {
            this.rng = Math.random;
        }

        // ARCHON (N21): the deep planner's hooks. `analyzer` is awaited at
        // each choice point and may return a candidate index (or null to
        // fall through to the policy); `stopAfterRound` halts a rollout at a
        // horizon so a fork can be scored without playing to the end.
        this.analyzer = options.analyzer || null;
        this.stopAfterRound = options.stopAfterRound || null;

        this.interactions = 0;
        this.houseCalls = { [PLAYER_ONE]: {}, [PLAYER_TWO]: {} };
        this.firstHouse = { [PLAYER_ONE]: null, [PLAYER_TWO]: null };
        this.inputLog = [];
        this.decisions = [];
        this.fingerprints = [];
        // Which menu action a just-clicked in-play card should resolve to.
        this.pendingIntent = null;
        // The creature sent to fight, held until the prompt asking whom.
        this.attacker = null;
        // Set by the replay driver: inputs come from the log, not from choices.
        this.replaying = null;
    }

    /**
     * Play the game to completion.
     *
     * @returns {Promise<object>} `{ completed, winner, loser, ... }` plus,
     * when seeded, `seed`/`inputLog`, and when recording, `decisions` - or
     * `{ completed: false, reason }` for a game that had to be abandoned.
     */
    async run() {
        const work = () => this.runInner();

        return this.source ? withRandomSource(this.source, work) : work();
    }

    async runInner() {
        const startedAt = Date.now();
        const game = this.game || this.buildGame();

        this.game = game;

        // ARCHON (N32): refuse a game one side cannot play.
        //
        // The engine's deck builder drops any card entry that arrives without
        // its card data, so a deck assembled from ids alone becomes a legal
        // game with an EMPTY draw pile. It does not throw. It plays, quickly,
        // and the side with cards wins three keys to nothing - which is why a
        // whole field of opponents once sat at exactly 100% with nothing in the
        // logs to say why. A rigged result is worse than no result, so this is
        // checked before the first input rather than inferred afterwards.
        // `allCards`, not `deck`: the draw pile is meant to shrink, and this sim
        // is also entered mid-game by a fork, where a short pile is the whole
        // point. What cannot legitimately be short is the deck that was BUILT.
        const shortSide = game
            .getPlayers()
            .find((player) => (player.allCards || []).length < MIN_DECK);

        if (shortSide) {
            return {
                completed: false,
                reason: 'short-deck',
                shortSide: shortSide.name,
                deckSize: (shortSide.allCards || []).length
            };
        }

        const firstPlayerName = game.firstPlayer && game.firstPlayer.name;
        const result = await this.loop(game);

        if (!result.completed) {
            return result;
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
            durationMs: Date.now() - startedAt,
            ...(this.seed !== undefined && this.seed !== null
                ? { seed: this.seed, inputLog: this.inputLog }
                : {}),
            ...(this.recordDecisions ? { decisions: this.decisions } : {}),
            ...(this.keepFingerprints ? { fingerprints: this.fingerprints } : {})
        };
    }

    /** Construct the engine game. Loaded lazily - see N18. */
    buildGame() {
        const Game = require('../../game/game.js');
        const Settings = require('../../settings.js');

        const makeUser = (username) =>
            Settings.getUserWithDefaultsSet({
                username,
                settings: {
                    optionSettings: {
                        orderForcedAbilities: false,
                        confirmOneClick: false
                    }
                }
            });

        const alpha = makeUser(PLAYER_ONE);
        const omega = makeUser(PLAYER_TWO);

        const game = new Game(
            {
                id: randomUUID(),
                name: 'Champions Challenge',
                owner: alpha,
                saveGameId: 0,
                players: [
                    { id: `cc-${PLAYER_ONE}`, user: alpha },
                    { id: `cc-${PLAYER_TWO}`, user: omega }
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
        game.recordBoardSnapshot = () => true;
        game.selectDeck(PLAYER_ONE, this.deckAlpha);
        game.selectDeck(PLAYER_TWO, this.deckOmega);
        game.initialise();

        return game;
    }

    async loop(game) {
        let stuckCycles = 0;

        while (!game.winner) {
            if (this.interactions >= this.maxInteractions) {
                return { completed: false, reason: 'interaction-cap' };
            }

            if (game.round > this.maxTurns) {
                return { completed: false, reason: 'turn-cap' };
            }

            if (this.stopAfterRound && game.round > this.stopAfterRound) {
                return { completed: false, reason: 'horizon' };
            }

            let acted = false;

            for (const player of game.getPlayers()) {
                if (game.winner) {
                    break;
                }

                if (await this.respond(game, player)) {
                    acted = true;
                    this.interactions++;
                    game.continue();

                    if (this.keepFingerprints) {
                        this.fingerprints.push(SimulatedGame.fingerprint(game));
                    }

                    if (this.interactions % this.yieldEvery === 0) {
                        await new Promise((resolve) => setImmediate(resolve));
                    }
                }
            }

            if (!acted) {
                game.continue();

                if (++stuckCycles > 50) {
                    return { completed: false, reason: 'no-legal-input' };
                }
            } else {
                stuckCycles = 0;
            }
        }

        return { completed: true };
    }

    /**
     * Answer this player's current prompt, if they have one.
     *
     * @returns {boolean} whether an input was dispatched
     */
    async respond(game, player) {
        const state = player.promptState;
        const buttons = (state.buttons || []).filter((button) => !button.disabled);
        const title = textOf(state.menuTitle);
        const selectable = state.selectableCards || [];

        if (title === MAIN_WINDOW_TITLE) {
            this.pendingIntent = null;
            this.attacker = null;

            return await this.playFromMainWindow(game, player, buttons);
        }

        if (title === HOUSE_CHOICE_TITLE && buttons.length) {
            return await this.chooseHouse(game, player, buttons);
        }

        if (title === END_TURN_CONFIRM_TITLE) {
            return this.pressByText(game, player, buttons, ['yes']);
        }

        if (title === MULLIGAN_TITLE) {
            return this.pressByText(game, player, buttons, ['keep hand']);
        }

        // Only asked because the bot clicked the prophecy, and a No would
        // leave it activatable for the main window to offer again forever.
        if (title === ACTIVATE_PROPHECY_TITLE) {
            return this.pressByText(game, player, buttons, ['yes']);
        }

        if (state.selectCard && selectable.length) {
            const selected = state.selectedCards || [];
            const unselected = selectable.filter((card) => !selected.includes(card));
            const doneIndex = buttons.findIndex((button) => textOf(button.text) === 'done');

            if (unselected.length && (doneIndex === -1 || !selected.length)) {
                // ARCHON (N25): the target is CHOSEN now, not rolled for. This
                // is the prompt that asks "destroy which creature", "steal from
                // whom", "return which card" - most of what one KeyForge player
                // does to another - and it used to be answered by picking a
                // selectable card at random.
                const index = await this.chooseSelection(game, player, unselected, state.menuTitle);

                return this.clickCardAt(game, player, unselected, index, 'sel');
            }

            if (doneIndex !== -1) {
                return this.pressButtonAt(game, player, buttons, doneIndex);
            }
        }

        if (buttons.length) {
            // A just-clicked in-play card's menu resolves to the action the
            // policy intended, not to a fixed preference.
            if (this.pendingIntent) {
                const wanted = INTENT_BUTTONS[this.pendingIntent.kind] || [];
                const index = buttons.findIndex((button) => wanted.includes(textOf(button.text)));

                this.pendingIntent = null;

                if (index !== -1) {
                    return this.pressButtonAt(game, player, buttons, index);
                }
            }

            const preferredIndex = ACTION_PREFERENCE.map((text) =>
                buttons.findIndex((button) => textOf(button.text) === text)
            ).find((index) => index !== -1);

            if (preferredIndex !== undefined) {
                return this.pressButtonAt(game, player, buttons, preferredIndex);
            }

            const autoresolve = buttons.findIndex(
                (button) => textOf(button.text) === 'autoresolve'
            );

            if (autoresolve !== -1) {
                return this.pressButtonAt(game, player, buttons, autoresolve);
            }

            const allowed = buttons
                .map((button, index) => ({ button, index }))
                .filter(({ button }) => !NEVER_PRESS.includes(textOf(button.text)));
            const pool = allowed.length
                ? allowed
                : buttons.map((button, index) => ({ button, index }));
            const pick = pool[Math.floor(this.rng() * pool.length)];

            return this.pressButtonAt(game, player, buttons, pick.index);
        }

        return false;
    }

    /** The brain steering this seat: per-seat when set, shared otherwise. */
    policyFor(player) {
        if (this.policies) {
            return player.name === PLAYER_ONE ? this.policies.alpha : this.policies.omega;
        }

        return this.policy;
    }

    /**
     * The move list, from the module every bot shares. Kept as methods
     * because the deep planner reaches for them through the sim it is
     * analyzing (`sim.playableFromHand`).
     */
    playableFromHand(player) {
        return playableFromHand(player);
    }

    usableInPlay(player) {
        return usableInPlay(player);
    }

    /**
     * Every move the bot could make from the main window right now.
     *
     * Shared with the practice bots (services/botplayer/decisions), because
     * a fork must enumerate the same list in the same order as the game it
     * forked - and because the bot a player meets in the lobby should be
     * choosing from the same moves this lab learned on.
     */
    mainWindowCandidates(player) {
        return mainWindowCandidates(player);
    }

    /**
     * The turn's action choice. Candidates are exactly the moves the old
     * heuristic could make, so the learned policy reorders sound play rather
     * than inventing unsound play. End Turn is offered only once nothing
     * else remains, which is what keeps a young, silly policy from
     * discovering the strategy of never doing anything.
     */
    async playFromMainWindow(game, player, buttons) {
        const { hand, inPlay, prophecies, candidates } = this.mainWindowCandidates(player);

        if (!candidates.length) {
            return this.pressByText(game, player, buttons, ['end turn']);
        }

        const chosen = await this.chooseCandidate(game, player, candidates);

        if (this.recordDecisions) {
            this.decisions.push(
                decisionRecord(game, player, { kind: chosen.kind, card: chosen.card })
            );
        }

        // The menu that opens next is answered with the move that was
        // chosen - hand cards included, since a hand card's menu offers
        // both a play and a discard and the choice between them was the
        // decision.
        this.pendingIntent = { kind: chosen.kind };

        if (chosen.list === 'prophecy') {
            return this.clickProphecyAt(game, player, prophecies, chosen.index);
        }

        if (chosen.list === 'play') {
            this.attacker = chosen.kind === 'fight' ? chosen.card : null;

            return this.clickCardAt(game, player, inPlay, chosen.index, 'play');
        }

        return this.clickCardAt(game, player, hand, chosen.index, 'hand');
    }

    /**
     * ARCHON (N25): pick a target - planner, learned policy, or a roll.
     *
     * The candidates are the selectable cards themselves, described by whose
     * they are, what they are worth and where they stand (labFeatures), plus a
     * weight for this particular prompt so the model can learn that the answer
     * to "choose a creature to destroy" is the opponent's biggest and the answer
     * to "choose a creature to heal" is not.
     *
     * Falls back to a roll when there is no model, which is exactly what every
     * selection used to be - so a site that has never trained one plays no worse
     * than it did.
     *
     * @returns {Promise<number>} index into `unselected`
     */
    async chooseSelection(game, player, unselected, promptTitle) {
        if (unselected.length === 1) {
            return 0;
        }

        const prompt = textOf(promptTitle);

        if (this.analyzer) {
            const analyzed = await this.analyzer({
                sim: this,
                game,
                player,
                kind: 'select',
                candidates: unselected.map((card) => ({ kind: 'select', card, prompt }))
            });

            if (analyzed !== null && analyzed !== undefined && unselected[analyzed]) {
                this.noteDecision(game, player, {
                    kind: 'select',
                    card: unselected[analyzed],
                    prompt
                });

                return analyzed;
            }
        }

        const policy = this.policyFor(player);
        const attacker = this.attacker;

        // A selection resolves whatever the bot clicked for, so the reason it
        // clicked does not survive past this prompt either way.
        this.attacker = null;

        let index;

        if (policy) {
            const records = unselected.map((card) =>
                decisionRecord(game, player, { kind: 'select', card, prompt })
            );

            index = Math.max(0, chooseDecision(policy, records, this.temperature, this.rng));
        } else {
            /**
             * ARCHON (F9): the two selections a plain player can answer
             * without a model - whom a creature it sent to fight should
             * attack, and which card to bury under a prophecy it just
             * activated. Everything else is a card ability's own question,
             * and a bot with no model has no business guessing at those.
             */
            const chosen = prompt.includes(FATE_CARD_MARKER)
                ? bestFateCard(player, unselected)
                : bestFightTarget(attacker, unselected);

            index = chosen
                ? unselected.indexOf(chosen)
                : Math.floor(this.rng() * unselected.length);
        }

        this.noteDecision(game, player, { kind: 'select', card: unselected[index], prompt });

        return index;
    }

    /** Keep a decision for training, when this game is recording. */
    noteDecision(game, player, action) {
        if (this.recordDecisions) {
            this.decisions.push(decisionRecord(game, player, action));
        }
    }

    /** Pick among main-window candidates: planner, learned policy, or the old order. */
    async chooseCandidate(game, player, candidates) {
        if (this.analyzer && candidates.length > 1) {
            const analyzed = await this.analyzer({
                sim: this,
                game,
                player,
                kind: 'action',
                candidates
            });

            if (analyzed !== null && analyzed !== undefined && candidates[analyzed]) {
                return candidates[analyzed];
            }
        }

        const policy = this.policyFor(player);

        if (policy) {
            const records = candidates.map((candidate) =>
                decisionRecord(game, player, { kind: candidate.kind, card: candidate.card })
            );
            const index = chooseDecision(policy, records, this.temperature, this.rng);

            return candidates[Math.max(0, index)];
        }

        // No model: the plain player's order, from the shared move module -
        // the same order the practice bots fall back on, so an untrained lab
        // trains on the play a lobby opponent actually makes. Random within
        // the leading rank, which is where self-play gets its variety.
        const pool = bestCandidates(player, candidates);

        return pool[Math.floor(this.rng() * pool.length)];
    }

    /** The house call: planner, learned policy, or count what the hand can use. */
    async chooseHouse(game, player, buttons) {
        let index;

        if (this.analyzer && buttons.length > 1) {
            const analyzed = await this.analyzer({
                sim: this,
                game,
                player,
                kind: 'house',
                candidates: buttons.map((button) => ({
                    kind: 'houseCall',
                    house: textOf(button.text)
                }))
            });

            if (analyzed !== null && analyzed !== undefined && buttons[analyzed]) {
                index = analyzed;
            }
        }

        const policy = this.policyFor(player);

        if (index === undefined && policy) {
            const records = buttons.map((button) =>
                decisionRecord(game, player, {
                    kind: 'houseCall',
                    house: textOf(button.text),
                    player
                })
            );

            index = Math.max(0, chooseDecision(policy, records, this.temperature, this.rng));
        } else if (index === undefined) {
            let bestScore = -1;

            index = 0;

            for (let i = 0; i < buttons.length; i++) {
                // Shared with the practice bots: what the house can do this
                // turn, plus what it can take off an opponent about to forge.
                const score = houseScore(player, textOf(buttons[i].text)) + this.rng() * 0.75;

                if (score > bestScore) {
                    bestScore = score;
                    index = i;
                }
            }
        }

        const house = textOf(buttons[index].text);

        this.houseCalls[player.name][house] = (this.houseCalls[player.name][house] || 0) + 1;

        if (!this.firstHouse[player.name]) {
            this.firstHouse[player.name] = house;
        }

        if (this.recordDecisions) {
            this.decisions.push(decisionRecord(game, player, { kind: 'houseCall', house, player }));
        }

        return this.pressButtonAt(game, player, buttons, index);
    }

    /** Press the first offered button whose text is in `wanted`. */
    pressByText(game, player, buttons, wanted) {
        for (const text of wanted) {
            const index = buttons.findIndex((candidate) => textOf(candidate.text) === text);

            if (index !== -1) {
                return this.pressButtonAt(game, player, buttons, index);
            }
        }

        return false;
    }

    /**
     * The two dispatch primitives. Everything the bot does goes through one
     * of them, which is what makes the input log COMPLETE: an entry records
     * the list it chose from and the position it chose, and replaying the
     * log rebuilds the same lists (determinism) and picks the same
     * positions. The stored text/id is a tripwire, not an address - a
     * mismatch means determinism broke, and the fork must abort loudly
     * rather than play a subtly different game.
     */
    pressButtonAt(game, player, buttons, index) {
        const button = buttons[index];

        if (!button) {
            return false;
        }

        if (this.seed !== undefined && this.seed !== null && !this.replaying) {
            this.inputLog.push({ p: player.name, t: 'b', i: index, x: textOf(button.text) });
        }

        game.menuButton(player.name, button.arg, button.uuid, button.method);

        return true;
    }

    clickCardAt(game, player, list, index, listKind) {
        const card = list[index];

        if (!card) {
            return false;
        }

        if (this.seed !== undefined && this.seed !== null && !this.replaying) {
            this.inputLog.push({ p: player.name, t: 'c', l: listKind, i: index, id: card.id });
        }

        game.cardClicked(player.name, card.uuid);

        return true;
    }

    /**
     * A prophecy is the third input the engine takes, and it needs its own
     * log entry for the same reason the other two do: a fork replays by
     * position, and "click the prophecy at index 0" is not something either
     * of the others can express.
     */
    clickProphecyAt(game, player, list, index) {
        const card = list[index];

        if (!card) {
            return false;
        }

        if (this.seed !== undefined && this.seed !== null && !this.replaying) {
            this.inputLog.push({ p: player.name, t: 'p', i: index, id: card.id });
        }

        game.clickProphecy(player.name, card.uuid);

        return true;
    }

    /**
     * A stable summary of the visible game state, for determinism proofs:
     * two runs (or a run and its replay) agree exactly when these agree.
     */
    static fingerprint(game) {
        const side = (player) =>
            [
                player.amber,
                player.getForgedKeys(),
                player.chains || 0,
                player.hand
                    .map((card) => card.id)
                    .sort()
                    .join(','),
                player.cardsInPlay
                    .map(
                        (card) =>
                            `${card.id}#${
                                card.tokens && card.tokens.damage ? card.tokens.damage : 0
                            }`
                    )
                    .sort()
                    .join(','),
                (player.deck || []).length,
                (player.discard || []).length,
                (player.archives || []).length
            ].join('|');

        return `r${game.round}:${game
            .getPlayers()
            .map((player) => side(player))
            .join('::')}`;
    }
}

/**
 * Rebuild a seeded game by replaying its input log, stopping after `upTo`
 * entries. The returned driver holds the LIVE game at that point and can
 * keep playing it - which is exactly what the deep planner's forks do.
 *
 * The whole lifetime (replay AND whatever the caller plays afterwards) runs
 * under one scoped random source: the recorded seed while replaying, then
 * `rolloutSeed` so alternative futures diverge honestly instead of
 * replaying fate.
 *
 * @param {object} deckAlpha
 * @param {object} deckOmega
 * @param {object} params
 * @param {number} params.seed the original game's seed
 * @param {object[]} params.inputLog the original game's log
 * @param {number} [params.upTo] entries to replay (default: all)
 * @param {number} [params.rolloutSeed] randomness after the replay point
 * @param {object} [params.options] SimulatedGame options for the continuation
 * @returns {Promise<{sim: SimulatedGame, game: object}>}
 */
async function replayTo(deckAlpha, deckOmega, { seed, inputLog, upTo, rolloutSeed, options = {} }) {
    const limit = upTo === undefined ? inputLog.length : upTo;
    let generator = seededSource(seed);
    // One mutable delegate for the fork's ENGINE randomness: the recorded
    // stream while replaying, a fresh one for the continuation. The bot's
    // dice stay on their own derived stream, exactly as in a live run.
    const delegate = { next: () => generator.next() };
    const continuationSeed = rolloutSeed === undefined ? seed : rolloutSeed;
    const botDice = seededSource((continuationSeed ^ 0x9e3779b9) >>> 0);

    return withRandomSource(delegate, async () => {
        const sim = new SimulatedGame(deckAlpha, deckOmega, {
            ...options,
            seed,
            rng: () => botDice.next()
        });

        sim.replaying = true;
        sim.game = sim.buildGame();

        for (let i = 0; i < limit && i < inputLog.length; i++) {
            const entry = inputLog[i];
            const player = sim.game.getPlayerByName(entry.p);
            const state = player.promptState;

            if (entry.t === 'b') {
                const buttons = (state.buttons || []).filter((button) => !button.disabled);
                const button = buttons[entry.i];

                if (!button || textOf(button.text) !== entry.x) {
                    throw new Error(
                        `Fork determinism broke at input ${i}: expected button "${entry.x}", ` +
                            `found "${button ? textOf(button.text) : 'nothing'}"`
                    );
                }

                sim.game.menuButton(entry.p, button.arg, button.uuid, button.method);
            } else if (entry.t === 'p') {
                const prophecy = activatableProphecies(player)[entry.i];

                if (!prophecy || prophecy.id !== entry.id) {
                    throw new Error(
                        `Fork determinism broke at input ${i}: expected prophecy "${entry.id}", ` +
                            `found "${prophecy ? prophecy.id : 'nothing'}"`
                    );
                }

                sim.game.clickProphecy(entry.p, prophecy.uuid);
            } else {
                const list = resolveList(sim, player, entry.l);
                const card = list[entry.i];

                if (!card || card.id !== entry.id) {
                    throw new Error(
                        `Fork determinism broke at input ${i}: expected card "${entry.id}", ` +
                            `found "${card ? card.id : 'nothing'}"`
                    );
                }

                sim.game.cardClicked(entry.p, card.uuid);
            }

            sim.interactions++;
            sim.game.continue();
        }

        // From here the fork lives its own life on its own dice.
        if (rolloutSeed !== undefined) {
            generator = seededSource(rolloutSeed);
        }

        sim.replaying = false;

        return { sim, game: sim.game };
    });
}

function resolveList(sim, player, listKind) {
    if (listKind === 'hand') {
        return sim.playableFromHand(player);
    }

    if (listKind === 'play') {
        return sim.usableInPlay(player);
    }

    const state = player.promptState;
    const selected = state.selectedCards || [];

    return (state.selectableCards || []).filter((card) => !selected.includes(card));
}

/**
 * Play one simulated game between two engine-ready decks.
 *
 * @returns {Promise<object>} see {@link SimulatedGame#run}
 */
async function runSimulatedGame(deckAlpha, deckOmega, options) {
    return new SimulatedGame(deckAlpha, deckOmega, options).run();
}

module.exports = { SimulatedGame, runSimulatedGame, replayTo, PLAYER_ONE, PLAYER_TWO };
