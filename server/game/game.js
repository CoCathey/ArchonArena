const EventEmitter = require('events');
const moment = require('moment');

const Constants = require('../constants');
const ChatCommands = require('./chatcommands');
const GameChat = require('./gamechat');
const EffectEngine = require('./effectengine');
const Player = require('./player');
const Spectator = require('./spectator');
const AnonymousSpectator = require('./anonymousspectator');
const GamePipeline = require('./gamepipeline');
const SetupPhase = require('./gamesteps/setup/setupphase');
const KeyPhase = require('./gamesteps/key/KeyPhase');
const HousePhase = require('./gamesteps/house/HousePhase');
const MainPhase = require('./gamesteps/main/MainPhase');
const ReadyPhase = require('./gamesteps/ReadyPhase');
const DrawPhase = require('./gamesteps/draw/drawphase');
const SimpleStep = require('./gamesteps/simplestep');
const MenuPrompt = require('./gamesteps/menuprompt');
const HandlerMenuPrompt = require('./gamesteps/handlermenuprompt');
const SelectCardPrompt = require('./gamesteps/selectcardprompt');
const OptionsMenuPrompt = require('./gamesteps/OptionsMenuPrompt');
const GameWonPrompt = require('./gamesteps/GameWonPrompt');
const FinalTurn = require('./gamesteps/FinalTurn');
const GameActions = require('./GameActions');
const Effects = require('./effects.js');
const Event = require('./Events/Event');
const { EVENTS } = require('./Events/types');
const EventWindow = require('./Events/EventWindow');
const AbilityResolver = require('./gamesteps/abilityresolver');
const SimultaneousEffectWindow = require('./gamesteps/SimultaneousEffectWindow');
const AbilityContext = require('./AbilityContext');
const MenuCommands = require('./MenuCommands');
const TimeLimit = require('./TimeLimit');
const PlainTextGameChatFormatter = require('./PlainTextGameChatFormatter');
const CardVisibility = require('./CardVisibility');

/**
 * @import {EventName} from './Events/types');
 */

class Game extends EventEmitter {
    constructor(details, options = {}) {
        super();

        this.adaptive = { chains: 0, selection: [], biddingWinner: '' };
        this.allowSpectators = details.allowSpectators;
        this.cancelPromptUsed = false;
        // ARCHON: tournament linkage rides along so GAMEWIN can auto-report
        this.tournament = details.tournament;
        // ARCHON (F9): a Helper Bot practice game. Rides into the save state
        // so the lobby's router can keep it out of Games, replays and rating.
        this.botGame = !!details.botGame;
        // ARCHON (N41): which pilot the human chose to face. Rides with the
        // game so the board can name it while it is being played and the save
        // state can record it afterwards - the choice was made on the pending
        // screen and then lost by everything downstream.
        this.botStyle = details.botStyle;
        this.botStyleLabel = details.botStyleLabel;
        // ARCHON: pre-assigned chains (SAS handicap / Chainbound events);
        // applied once at initialise, before the setup phase draws hands.
        this.startingChains = details.startingChains;
        this.chatCommands = new ChatCommands(this);
        this.createdAt = new Date();
        this.currentAbilityWindow = null;
        this.currentActionWindow = null;
        this.currentDestructionWindow = null;
        this.currentEventWindow = null;
        this.currentPhase = '';
        this.effectEngine = new EffectEngine(this);
        this.gameChat = new GameChat(this);
        this.gameFormat = details.gameFormat;
        this.gamePrivate = details.gamePrivate;
        this.gameTimeLimit = details.gameTimeLimit;
        this.hideDeckLists = details.hideDeckLists;
        this.id = details.id;
        this.manualMode = false;
        this.muteSpectators = details.muteSpectators;
        this.name = details.name;
        this.owner = details.owner.username;
        this.password = details.password;
        this.pipeline = new GamePipeline();
        this.playStarted = false;
        this.playersAndSpectators = {};
        this.previousWinner = details.previousWinner;
        this.savedGameId = details.savedGameId;
        this.showHand = details.showHand;
        // ARCHON (N1): seconds to hold the board back from spectators. Set from
        // the site's Watch settings when the game is handed to the node; the
        // game itself only carries the value, the node enforces it.
        this.spectatorDelaySeconds = details.spectatorDelaySeconds || 0;
        this.started = false;
        this.errorHandling = false;
        this.swap = details.swap;
        this.timeLimit = new TimeLimit(this);
        this.useGameTimeLimit = details.useGameTimeLimit;
        this.startingHandsDrawn = false;
        this.continuePlaying = false;

        this.cardNamesPlayedOrUsed = [];
        this.cardsUsed = [];
        this.omegaCard = null;
        this.cardsPlayed = [];
        this.cardsDiscarded = [];
        this.effectsUsed = [];
        this.propheciesActivated = [];
        this.cardsDiscardedThisPhase = [];
        this.cardsUsedThisPhase = [];
        this.cardsPlayedThisPhase = [];
        this.effectsUsedThisPhase = [];
        this.propheciesActivatedThisPhase = [];
        this.gainsTextBoxSourcesThisPhase = [];
        this.activePlayer = null;
        this.firstPlayer = null;
        this.playedRoundsAfterTime = [];
        this.finalTurnCompleted = false;
        this.jsonForUsers = {};
        this.cardData = options.cardData || [];

        this.cardVisibility = new CardVisibility(this);

        for (const player of Object.values(details.players)) {
            this.playersAndSpectators[player.user.username] = new Player(
                player.id,
                player.user,
                this.owner === player.user.username,
                this
            );
        }

        for (const spectator of Object.values(details.spectators || {})) {
            this.playersAndSpectators[spectator.user.username] = new Spectator(
                spectator.id,
                spectator.user
            );
        }

        this.setMaxListeners(0);

        this.router = options.router;
        this.highTide = null;

        this.lastManualMode = null;

        // Server-side inactivity tracking: when the active player hasn't sent
        // any game commands for the threshold, the opponent can force-pass.
        this.inactivityThresholdMs = 5 * 60 * 1000; // 5 minutes
        this.forcePassCount = 0; // how many times force-pass has been used
        this.forcePassAvailable = false; // non-blocking flag exposed in game state

        // ARCHON: how long a player's socket may stay gone before the game is
        // scored against them. See checkAbandonment.
        this.abandonmentTimeoutMs = 2 * 60 * 1000; // 2 minutes
    }

    /*
     * Reports errors from the game engine back to the router
     * @param {type} e
     * @returns {undefined}
     */
    reportError(e) {
        this.router.handleError(this, e);
    }

    /**
     * Adds a message to the in-game chat e.g 'Jadiel draws 1 card'
     * @param {String} message to display (can include {i} references to args)
     * @param {Array} args to match the references in @string
     */
    addMessage() {
        this.gameChat.addMessage(...arguments);
    }

    /**
     * Adds a message to in-game chat with a graphical icon
     * @param {String} one of: 'endofturn', 'success', 'info', 'danger', 'warning'
     * @param {String} message to display (can include {i} references to args)
     * @param {Array} args to match the references in @string
     */
    addAlert() {
        this.gameChat.addAlert(...arguments);
    }

    /**
     * Records that a player has sent a game command. Used to track inactivity.
     * @param {String} playerName
     */
    notePlayerEvent(playerName) {
        const player = this.playersAndSpectators[playerName];
        if (!player || this.isSpectator(player)) {
            return;
        }

        player.lastEventAt = Date.now();

        // If the player was marked inactive and they just acted, clear the flag
        if (player.inactive) {
            player.inactive = false;
            this.forcePassCount = 0;
        }

        // If force-pass is available and the active player acts, cancel it
        if (this.forcePassAvailable && player === this.activePlayer) {
            this.forcePassAvailable = false;
        }
    }

    /**
     * Called periodically by the game server sweep. Checks if the active player
     * has been inactive and, if so, alerts chat and gives the opponent a prompt
     * to force-pass the turn.
     * @returns {Boolean} true if game state changed (caller should push state)
     */
    checkInactivity() {
        if (this.finishedAt || !this.started || !this.activePlayer) {
            return false;
        }

        if (this.forcePassAvailable) {
            return false;
        }

        const activePlayer = this.activePlayer;
        if (activePlayer.left || activePlayer.disconnectedAt) {
            return false;
        }

        const now = Date.now();
        const lastEvent = activePlayer.lastEventAt || 0;

        // On the first detection use 5 min; on subsequent force-passed turns
        // trigger immediately (the client grays out the button for 5s instead).
        const threshold = this.forcePassCount > 0 ? 0 : this.inactivityThresholdMs;

        if (now - lastEvent < threshold) {
            return false;
        }

        // Find the waiting player
        const waitingPlayer = this.getPlayers().find((p) => p !== activePlayer);
        if (!waitingPlayer || waitingPlayer.left) {
            return false;
        }

        this.forcePassAvailable = true;
        activePlayer.inactive = true;

        // Only show the alert on the first detection. On re-detection after a
        // force-pass the opponent already knows; just re-enable the button.
        if (this.forcePassCount === 0) {
            this.addAlert(
                'warning',
                '{0} has been inactive for 5 minutes. {1} may force them to pass their turn, or leave the game without recording a loss.',
                activePlayer,
                waitingPlayer
            );
        }

        return true;
    }

    get messages() {
        return this.gameChat.messages;
    }

    getPlainTextLog() {
        let formatter = new PlainTextGameChatFormatter(this.gameChat);
        return formatter.format();
    }

    /**
     * Checks if a player is a spectator
     * @param {Object} player
     * @returns {Boolean}
     */
    isSpectator(player) {
        return player.constructor === Spectator;
    }

    /**
     * Checks whether a player/spectator is still in the game
     * @param {String} playerName
     * @returns {Boolean}
     */
    hasActivePlayer(playerName) {
        return this.playersAndSpectators[playerName] && !this.playersAndSpectators[playerName].left;
    }

    /**
     * Get all players (not spectators) in the game
     * @returns {Player[]}
     */
    getPlayers() {
        return Object.values(this.playersAndSpectators).filter(
            (player) => !this.isSpectator(player)
        );
    }

    /**
     * Returns the Player object (not spectator) for a name
     * @param {String} playerName
     * @returns {Player}
     */
    getPlayerByName(playerName) {
        let player = this.playersAndSpectators[playerName];
        if (player && !this.isSpectator(player)) {
            return player;
        }
    }

    /**
     * Get all players and spectators in the game
     * @returns {Object} {name1: Player, name2: Player, name3: Spectator}
     */
    getPlayersAndSpectators() {
        return this.playersAndSpectators;
    }

    /**
     * Get all spectators in the game
     * @returns {Spectator[]} {name1: Spectator, name2: Spectator}
     */
    getSpectators() {
        return Object.values(this.playersAndSpectators).filter((player) =>
            this.isSpectator(player)
        );
    }

    /**
     * Gets a player other than the one passed (usually their opponent)
     * @param {Player} player
     * @returns {Player}
     */
    getOtherPlayer(player) {
        let otherPlayer = this.getPlayers().find((p) => {
            return p.name !== player.name;
        });

        return otherPlayer;
    }

    /**
     * Returns the visitbility of the card for a given player.
     * @param {import('./Card')} card
     * @param {Player} player
     */
    isCardVisible(card, player) {
        return this.cardVisibility.isVisible(card, player);
    }

    /**
     * Returns the card (i.e. character) with matching uuid from either players
     * 'in play' area.
     * @param {String} cardId
     * @returns Card
     */
    findAnyCardInPlayByUuid(cardId) {
        return this.getPlayers().reduce((card, player) => {
            if (card) {
                return card;
            }

            return player.cardsInPlay.find((card) => card.uuid === cardId);
        }, null);
    }

    /**
     * Returns the card with matching uuid from anywhere in the game
     * @param {String} cardId
     * @returns Card
     */
    findAnyCardInAnyList(cardId) {
        // Search in regular cards and active prophecies
        let card = this.allCards.concat(this.activeProphecies).find((card) => card.uuid === cardId);

        // If not found, search in all prophecy cards (including inactive ones)
        if (!card && this.manualMode) {
            for (let player of this.getPlayers()) {
                if (player.prophecyCards) {
                    card = player.prophecyCards.find((card) => card.uuid === cardId);
                    if (card) {
                        break;
                    }
                }
            }
        }

        return card;
    }

    /**
     * Returns all cards (i.e. characters) which matching the passed predicated
     * function from either players 'in play' area.
     * @param {Function} predicate - card => Boolean
     * @returns {Array} Array of DrawCard objects
     */
    findAnyCardsInPlay(predicate) {
        let foundCards = [];

        for (const player of this.getPlayers()) {
            foundCards = foundCards.concat(player.cardsInPlay.filter(predicate));
        }

        return foundCards;
    }

    get actions() {
        return GameActions;
    }

    get effects() {
        return Effects;
    }

    stopClocks() {
        for (const player of this.getPlayers()) {
            player.stopClock();
        }
    }

    /**
     * This function is called from the client whenever a card is clicked
     * @param {String} sourcePlayer - name of the clicking player
     * @param {String} cardId - uuid of the card clicked
     */
    cardClicked(sourcePlayer, cardId) {
        let player = this.getPlayerByName(sourcePlayer);

        if (!player) {
            return;
        }

        let card = this.findAnyCardInAnyList(cardId);

        if (!card) {
            return;
        }

        const currentPrompt = player.currentPrompt();
        const menuTitleText =
            typeof currentPrompt?.menuTitle === 'string'
                ? currentPrompt.menuTitle
                : currentPrompt?.menuTitle?.text;
        const canReselectHandCard =
            card.location === 'hand' &&
            currentPrompt &&
            typeof menuTitleText === 'string' &&
            menuTitleText.startsWith('Play ') &&
            Array.isArray(currentPrompt.buttons) &&
            currentPrompt.buttons.some((button) => button.text === 'Cancel') &&
            currentPrompt.promptTitle &&
            currentPrompt.promptTitle !== card.name;

        if (canReselectHandCard) {
            // If a "Play/Discard/Cancel" style hand prompt is open, allow direct
            // reselection by dismissing it and handling the newly clicked card.
            this.pipeline.cancelStep();
            this.pipeline.continue();
            this.pipeline.handleCardClicked(player, card);
            return;
        }

        // Check to see if the current step in the pipeline is waiting for input
        this.pipeline.handleCardClicked(player, card);
    }

    facedownCardClicked(playerName, location, controllerName, isProvince = false) {
        let player = this.getPlayerByName(playerName);
        let controller = this.getPlayerByName(controllerName);
        if (!player || !controller) {
            return;
        }

        let list = controller.getSourceList(location);
        if (!list) {
            return;
        }

        let card = list.find((card) => !isProvince === !card.isProvince);
        if (card) {
            return this.pipeline.handleCardClicked(player, card);
        }
    }

    /**
     * This function is called by the client when a card menu item is clicked
     * @param {String} sourcePlayer - name of clicking player
     * @param {String} cardId - uuid of card whose menu was clicked
     * @param {Object} menuItem - { command: String, text: String, arg: String, method: String }
     */
    menuItemClick(sourcePlayer, cardId, menuItem) {
        let player = this.getPlayerByName(sourcePlayer);
        let card = this.findAnyCardInAnyList(cardId);
        if (!player || !card) {
            return;
        }

        if (menuItem.command === 'click') {
            this.cardClicked(sourcePlayer, cardId);
            return;
        }

        MenuCommands.cardMenuClick(menuItem, this, player, card);
        this.checkGameState(true, player);
    }

    /**
     * Sets a Player flag and displays a chat message to show that a popup with a
     * player's deck is open
     * @param {String} playerName
     */
    showDeck(playerName) {
        let player = this.getPlayerByName(playerName);

        if (!player) {
            return;
        }

        if (!player.showDeck) {
            player.showDeck = true;

            this.addMessage('{0} is looking at their deck', player);
        } else {
            player.showDeck = false;

            this.addMessage('{0} stops looking at their deck', player);
        }
    }

    /**
     * This function is called from the client whenever a card is dragged from
     * one place to another
     * @param {String} playerName
     * @param {String} cardId - uuid of card
     * @param {String} source - area where the card was dragged from
     * @param {String} target - area where the card was dropped
     */
    drop(playerName, cardId, source, target) {
        let player = this.getPlayerByName(playerName);

        if (!player) {
            return;
        }

        player.drop(cardId, source, target);
    }

    /**
     * Tiebreakers after time is called:
     * 1. Each player with 6+ amber forges a key
     * 2. Most keys wins
     * 3. Most amber wins
     * 4. Lowest chains wins
     * 5. Most creatures wins
     * 6. First player wins
     */
    checkTimeWinCondition() {
        // Step 1: Each player who has 6 or more amber forges a key
        for (const player of this.getPlayers()) {
            if (player.amber >= 6) {
                this.addAlert('success', '{0} forges a key after time', player);
                player.amber -= 6;
                player.keys[Object.keys(player.keys).find((key) => !player.keys[key])] = true;
            }
        }

        // Step 2: The player with the most keys forged is the winner
        let potentialWinners = this.getPlayers();
        let maxKeys = Math.max(...potentialWinners.map((p) => p.getForgedKeys()));
        potentialWinners = potentialWinners.filter((p) => p.getForgedKeys() === maxKeys);

        if (potentialWinners.length === 1) {
            this.addMessage('Tiebreaker: {0} wins with the most keys', potentialWinners[0]);
            this.recordWinner(potentialWinners[0], 'keys after time');
            return;
        }

        // Step 3: The player with the most remaining amber wins
        let maxAmber = Math.max(...potentialWinners.map((p) => p.amber));
        potentialWinners = potentialWinners.filter((p) => p.amber === maxAmber);

        if (potentialWinners.length === 1) {
            this.addMessage('Tiebreaker: {0} wins with the most amber', potentialWinners[0]);
            this.recordWinner(potentialWinners[0], 'amber after time');
            return;
        }

        // Step 4: The player with the fewest chains wins
        let minChains = Math.min(...potentialWinners.map((p) => p.chains));
        potentialWinners = potentialWinners.filter((p) => p.chains === minChains);

        if (potentialWinners.length === 1) {
            this.addMessage('Tiebreaker: {0} wins with the fewest chains', potentialWinners[0]);
            this.recordWinner(potentialWinners[0], 'chains after time');
            return;
        }

        // Step 5: The player with the most creatures in play wins
        let maxCreatures = Math.max(...potentialWinners.map((p) => p.creaturesInPlay.length));
        potentialWinners = potentialWinners.filter(
            (p) => p.creaturesInPlay.length === maxCreatures
        );

        if (potentialWinners.length === 1) {
            this.addMessage(
                'Tiebreaker: {0} wins with the most friendly creatures',
                potentialWinners[0]
            );
            this.recordWinner(potentialWinners[0], 'creatures after time');
            return;
        }

        // Step 6: First player wins
        this.addMessage('Tiebreaker: {0} wins as the first player', this.firstPlayer);
        this.recordWinner(this.firstPlayer, 'first player after time');
    }

    /**
     * Check to see if either player has won/lost the game due to keys or time
     */
    checkWinCondition() {
        // Once a winner has been recorded, don't re-fire passive win checks.
        // An explicit concede goes through recordWinner directly and will
        // re-open the post-game menu if the players are continuing past the
        // original win.
        if (this.winner) {
            return;
        }

        for (const player of this.getPlayers()) {
            if (Object.values(player.keys).every((key) => key)) {
                this.recordWinner(player, 'keys');
            }

            if (
                this.useGameTimeLimit &&
                this.timeLimit.isTimeLimitReached &&
                this.finalTurnCompleted &&
                !this.finishedAt
            ) {
                this.checkTimeWinCondition();
            }
        }
    }

    /**
     * Display message declaring victory for one player, and record stats for
     * the game
     * @param {Player} winner
     * @param {String} reason
     */
    recordWinner(winner, reason) {
        if (this.winner) {
            // Game was already won but the players chose to continue. Re-open
            // the post-game menu (without re-recording stats) so they can
            // pick rematch/continue again. The displayed winner reflects the
            // most recent concession even though the recorded winner stays
            // as the original.
            if (this.continuePlaying) {
                this.continuePlaying = false;
                this.queueStep(new GameWonPrompt(this, winner));
            }
            return;
        }

        this.addAlert('success', '{0} has won the game', winner);
        this.setWins(winner.name, winner.wins ? winner.wins + 1 : 1);
        this.winner = winner;
        this.finishedAt = new Date();
        this.winReason = reason;

        // ARCHON: the winning position, captured before the recording is handed
        // over. Every other snapshot is taken while the game is still running,
        // so without this one a replay ends on the board as it stood before the
        // deciding key was forged - the last frame never showed the win, and
        // the forge markers were always one short of the three keys.
        this.recordBoardSnapshot({ final: true });

        this.router.gameWon(this, reason, winner);

        this.queueStep(new GameWonPrompt(this, winner));
    }

    /**
     * Changes a Player variable and displays a message in chat
     * @param {String} playerName
     * @param {String} stat
     * @param {Number} value
     */
    changeStat(playerName, stat, value, info) {
        let player = this.getPlayerByName(playerName);
        if (!player) {
            return;
        }

        let target = player;

        target[stat] += value;

        if (target[stat] < 0) {
            target[stat] = 0;
        } else {
            this.addAlert(
                info ? 'info' : 'danger',
                '{0} sets {1} to {2} ({3})',
                player,
                stat,
                target[stat],
                (value > 0 ? '+' : '') + value
            );
        }
    }

    changeActiveHouse(playerName, house) {
        let player = this.getPlayerByName(playerName);
        if (!player) {
            return;
        }

        this.chatCommands.activeHouse(player, ['active-house', house]);
    }

    clickTide(playerName) {
        let player = this.getPlayerByName(playerName);
        if (!player) {
            return;
        }

        this.pipeline.handleTideClicked(player);
    }

    changeTide(player, level, showMessage = false) {
        switch (level) {
            case Constants.Tide.HIGH: {
                this.highTide = player;
                break;
            }
            case Constants.Tide.LOW: {
                this.highTide = player.opponent;
                break;
            }
            default: {
                this.highTide = null;
            }
        }

        if (showMessage) {
            this.addMessage('{0} changed tide to {1}', player, Constants.Tide.toString(level));
        }
    }

    clickProphecy(playerName, prophecyCardId) {
        let player = this.getPlayerByName(playerName);
        let prophecyCard = player.prophecyCards.find((card) => card.uuid === prophecyCardId);
        if (!player || !prophecyCard) {
            return;
        }

        this.pipeline.handleProphecyClicked(player, prophecyCard);
    }

    modifyKey(playerName, color, forged) {
        let player = this.getPlayerByName(playerName);
        if (!player) {
            return;
        }

        if (forged) {
            this.chatCommands.unforge(player, ['modify-key', color]);
        } else {
            this.chatCommands.forge(player, ['modify-key', color]);
        }
    }

    /**
     * This function is called by the client every time a player enters a chat message
     * @param {String} playerName
     * @param {String} message
     */
    chat(playerName, message) {
        let player = this.playersAndSpectators[playerName];
        let args = message.split(' ');

        if (!player) {
            return;
        }

        if (!this.isSpectator(player) && this.manualMode) {
            if (this.chatCommands.executeCommand(player, args[0], args)) {
                this.checkGameState(true, player);
                return;
            }
        }

        if (!this.isSpectator(player) || !this.muteSpectators) {
            this.gameChat.addChatMessage('{0} {1}', player, message);
        }
    }

    /**
     * This is called by the client when a player clicks 'Concede'
     * @param {String} playerName
     */
    concede(playerName) {
        let player = this.getPlayerByName(playerName);

        if (!player) {
            return;
        }

        this.addAlert('info', '{0} concedes', player);

        let otherPlayer = this.getOtherPlayer(player);

        if (otherPlayer) {
            this.recordWinner(otherPlayer, 'concede');
        }
    }

    selectDeck(playerName, deck) {
        let player = this.getPlayerByName(playerName);
        if (player) {
            player.selectDeck(deck);
        }
    }

    setWins(playerName, wins) {
        let player = this.getPlayerByName(playerName);
        if (player) {
            player.setWins(wins);
        }
    }

    /**
     * Called when a player clicks Shuffle Deck on the conflict deck menu in
     * the client
     * @param {String} playerName
     */
    shuffleDeck(playerName) {
        let player = this.getPlayerByName(playerName);
        if (player) {
            player.shuffleDeck();
        }
    }

    /**
     * Prompts a player with a multiple choice menu
     * @param {Player} player
     * @param {Object} contextObj - the object which contains the methods that are referenced by the menubuttons
     * @param {Object} properties - see menuprompt
     */
    promptWithMenu(player, contextObj, properties) {
        this.queueStep(new MenuPrompt(this, player, contextObj, properties));
    }

    /**
     * Prompts a player with a multiple choice menu
     * @param {Player} player
     * @param {Object} properties - see handlermenuprompt
     * @param {Object} forcedPlayer - TODO remove this hack when player properly defines the player (active player, instead of context.player)
     *                                all callers need to be reviewed
     */
    promptWithHandlerMenu(player, properties, forcedPlayer) {
        this.queueStep(
            new HandlerMenuPrompt(this, forcedPlayer || this.activePlayer || player, properties)
        );
    }

    /**
     * Prompts a player with a dropdown options menu
     * @param {Player} player
     * @param {Object} properties - see handlermenuprompt
     */
    promptWithOptionsMenu(player, properties) {
        this.queueStep(new OptionsMenuPrompt(this, player, properties));
    }

    /**
     * Prompts a player to click a card
     * @param {Player} player
     * @param {Object} properties - see selectcardprompt
     */
    promptForSelect(player, properties) {
        this.queueStep(new SelectCardPrompt(this, player, properties));
    }

    /**
     * This function is called by the client whenever a player clicks a button
     * in a prompt
     * @param {String} playerName
     * @param {String} arg - arg property of the button clicked
     * @param {String} uuid - unique identifier of the prompt clicked
     * @param {String} method - method property of the button clicked
     * @returns {Boolean} this indicates to the server whether the received input is legal or not
     */
    menuButton(playerName, arg, uuid, method) {
        let player = this.getPlayerByName(playerName);
        if (!player) {
            return false;
        }

        // check to see if the current step in the pipeline is waiting for input
        return this.pipeline.handleMenuCommand(player, arg, uuid, method);
    }

    /*
     * This function is called by the client when a player clicks an option setting
     * toggle in the settings menu
     * @param {String} playerName
     * @param {String} settingName - the name of the setting being toggled
     * @param {Boolean} toggle - the new setting of the toggle
     * @returns {undefined}
     */
    toggleOptionSetting(playerName, settingName, toggle) {
        let player = this.getPlayerByName(playerName);
        if (!player) {
            return;
        }

        player.optionSettings[settingName] = toggle;
    }

    toggleManualMode(playerName) {
        let player = this.getPlayerByName(playerName);
        if (!player) {
            return;
        }

        this.chatCommands.manual(player);
    }

    toggleMuteSpectators(playerName) {
        let player = this.getPlayerByName(playerName);
        if (!player) {
            return;
        }

        this.chatCommands.muteSpectators(player);
    }

    /*
     * Sets up Player objects, creates allCards, checks each player has a stronghold
     * and starts the game pipeline
     * @returns {undefined}
     */
    initialise() {
        let players = {};

        for (const player of Object.values(this.playersAndSpectators)) {
            if (!player.left) {
                players[player.name] = player;
            }
        }

        this.playersAndSpectators = players;

        if (this.useGameTimeLimit) {
            let timeLimitStartType = 'whenSetupFinished';
            let timeLimitInMinutes = this.gameTimeLimit;
            this.timeLimit.initialiseTimeLimit(timeLimitStartType, timeLimitInMinutes);
        }

        for (let player of this.getPlayers()) {
            player.initialise();

            // ARCHON: tournament chain handicaps behave exactly like
            // adaptive bid chains - set before setup so the starting
            // hand is drawn short and the chains shed as usual.
            const chains = this.startingChains && this.startingChains[player.name];
            if (Number.isInteger(chains) && chains > 0) {
                player.chains = chains;
            }
        }

        this.allCards = this.getPlayers().reduce((cards, player) => {
            return cards.concat(player.deck);
        }, []);

        this.pipeline.initialise([
            new SetupPhase(this),
            new SimpleStep(this, () => this.beginRound())
        ]);

        this.playStarted = true;
        this.startedAt = new Date();
        this.round = 1;

        this.continue();
    }

    reInitialisePlayers(swap) {
        let players = this.getPlayers();

        //adaptive swap
        if (swap) {
            const [player1, player2] = Object.keys(players);
            if (player2) {
                const deckData = players[player1].deckData;
                const houses = players[player1].houses;
                players[player1].deckData = players[player2].deckData;
                players[player1].houses = players[player2].houses;
                players[player2].houses = houses;
                players[player2].deckData = deckData;
            }
        }

        this.players = players;

        for (let player of this.getPlayers()) {
            player.initialise();
        }

        this.allCards = this.getPlayers().reduce((cards, player) => {
            return cards.concat(player.deck);
        }, []);
    }

    checkForTimeExpired() {
        if (this.timeLimit.isTimeLimitReached && !this.finishedAt) {
            this.playedRoundsAfterTime.push(this.activePlayer);
        }
    }

    /*
     * Adds each of the game's main phases to the pipeline
     * @returns {undefined}
     */
    beginRound() {
        // Check if we should start the final turn instead of a normal round
        if (this.timeIsCalled()) {
            this.queueStep(new FinalTurn(this));
            return;
        }

        // Reset inactivity tracking for the new turn
        this.forcePassAvailable = false;

        // Give the active player a fresh timestamp so they aren't immediately
        // flagged — unless they were already force-passed (inactive), in which
        // case keep their old timestamp to enable immediate re-detection.
        if (!this.activePlayer.inactive) {
            this.activePlayer.lastEventAt = Date.now();
        }

        // If the active player was previously force-passed, check immediately
        // so the opponent gets the button without waiting for the next sweep.
        if (this.forcePassCount > 0 && this.activePlayer.inactive) {
            this.checkInactivity();
        }

        this.raiseEvent(EVENTS.onTurnStart, { player: this.activePlayer });
        this.activePlayer.beginRound();
        this.queueStep(new SimpleStep(this, () => this.finalizeBeginRound(0)));
        this.queueStep(new KeyPhase(this));
        this.queueStep(new HousePhase(this));
        this.queueStep(new MainPhase(this));
        this.queueStep(new ReadyPhase(this));
        this.queueStep(new DrawPhase(this));
        this.queueStep(new SimpleStep(this, () => this.raiseEndRoundEvent()));
        this.queueStep(new SimpleStep(this, () => this.beginRound()));
    }

    /**
     * Check if the final turn (partial turn for first player after time) should start.
     * This happens after both players have completed their post-time turns.
     */
    timeIsCalled() {
        return (
            this.useGameTimeLimit &&
            this.timeLimit.isTimeLimitReached &&
            this.playedRoundsAfterTime.length >= this.getPlayers().length &&
            !this.finalTurnCompleted &&
            !this.finishedAt
        );
    }

    /*
     * Raises `onFinalizeBeginRound` events in a loop until the finalization
     * phase coalesces (i.e., nothing changes after the event is raised).
     * This allows effects that can loop arbitrarily during the beginning of
     * a round.
     */
    finalizeBeginRound(count) {
        if (count >= 100) {
            // Infinite loop protection.
            return;
        }
        this.raiseEvent(
            EVENTS.onFinalizeBeginRound,
            { player: this.activePlayer, somethingChanged: false },
            (event) => {
                if (event.somethingChanged) {
                    this.queueStep(new SimpleStep(this, () => this.finalizeBeginRound(count + 1)));
                }
            }
        );
    }

    /*
     * Adds a step to the pipeline queue
     * @param {BaseStep} step
     * @returns {undefined}
     */
    queueStep(step) {
        this.pipeline.queueStep(step);
        return step;
    }

    /*
     * Creates a step which calls a handler function
     * @param {Function} handler - () => undefined
     * @returns {undefined}
     */
    queueSimpleStep(handler) {
        this.pipeline.queueStep(new SimpleStep(this, handler));
    }

    /*
     * Resolves a card ability or ring effect
     * @param {AbilityContext} context - see AbilityContext
     * @returns {undefined}
     */
    resolveAbility(context) {
        this.raiseEvent(EVENTS.onResolveAbility, { context }, () => {
            this.queueStep(new AbilityResolver(this, context));
        });
    }

    openSimultaneousEffectWindow(choices) {
        let window = new SimultaneousEffectWindow(this);
        for (const choice of choices) {
            window.addChoice(choice);
        }
        this.queueStep(window);
    }

    /**
     * Returns a new {@link Event} that’s not explicitly tied to an action.
     *
     * @param {EventName} eventName
     */
    getEvent(eventName, params, handler) {
        return new Event(eventName, params, handler);
    }

    /**
     * Creates a game Event, and opens a window for it.
     * @param {EventName} eventName
     * @param {Object} params - parameters for this event
     * @param {Function} handler - (Event + params) => undefined
     * @returns {Event} - this allows the caller to track Event.resolved and
     * tell whether or not the handler resolved successfully
     */
    raiseEvent(eventName, params = {}, handler = () => true) {
        let event = this.getEvent(eventName, params, handler);
        this.openEventWindow([event]);
        return event;
    }

    /**
     * Creates a game Event and `emit`s it to all our event listeners.
     *
     * @param {EventName} eventName
     * @param {Object} params - parameters for this event
     */
    emitEvent(eventName, params = {}) {
        let event = this.getEvent(eventName, params);
        this.emit(event.name, event);
    }

    /**
     * Creates an EventWindow which will open windows for each kind of triggered
     * ability which can respond any passed events, and execute their handlers.
     * @param event
     * @returns {EventWindow}
     */
    openEventWindow(event) {
        if (Array.isArray(event)) {
            if (event.length === 0) {
                return;
            } else if (event.length > 1) {
                for (let e of event.slice(1)) {
                    event[0].addChildEvent(e);
                }
            }

            return this.queueStep(new EventWindow(this, event[0]));
        }

        return this.queueStep(new EventWindow(this, event));
    }

    /**
     * Checks whether a game action can be performed on a card or an array of
     * cards, and performs it on all legal targets.
     * @param {AbilityContext} context
     * @param {Object} actions - Object with { actionName: targets }
     * @returns {Event[]} - TODO: Change this?
     */
    applyGameAction(context, actions) {
        if (!context) {
            context = this.getFrameworkContext();
        }

        let actionPairs = Object.entries(actions);
        let events = actionPairs.reduce((array, [action, cards]) => {
            let gameAction = GameActions[action]();
            gameAction.setTarget(cards);
            return array.concat(gameAction.getEventArray(context));
        }, []);
        if (events.length > 0) {
            this.openEventWindow(events);
        }

        return events;
    }

    getFrameworkContext(player = null) {
        return new AbilityContext({ game: this, player: player });
    }

    /**
     * Changes the controller of a card in play to the passed player, and cleans
     * all the related stuff up
     * @param {Player} player
     * @param card
     */
    takeControl(player, card, modifiedByPlayer) {
        if (card.controller === player || !card.allowGameAction('takeControl')) {
            return;
        }

        card.controller.removeCardFromPile(card);
        card.controller = player;

        if (card.anyEffect('takeControlOn')) {
            this.finalizeTakeControl(
                player,
                card,
                undefined,
                card.mostRecentEffect('takeControlOn')
            );
        } else if (card.anyEffect('takeControlOnLeft')) {
            this.finalizeTakeControl(player, card, true);
        } else if (card.anyEffect('takeControlOnRight')) {
            this.finalizeTakeControl(player, card);
        } else if (card.type === 'creature' && player.creaturesInPlay.length > 0) {
            let handlers = [
                () => this.finalizeTakeControl(player, card, true), // left
                () => this.finalizeTakeControl(player, card) // right
            ];
            this.promptWithHandlerMenu(
                modifiedByPlayer || this.activePlayer,
                {
                    activePromptTitle: {
                        text: 'Choose which flank {{card}} should be placed on',
                        values: { card: card.name }
                    },
                    source: card,
                    choices: ['Left', 'Right'],
                    handlers: handlers
                },
                modifiedByPlayer
            );
        } else {
            this.finalizeTakeControl(player, card);
        }
    }

    finalizeTakeControl(player, card, left = false, position = -1) {
        if (position >= 0) {
            if (player.cardsInPlay.length >= position) {
                player.cardsInPlay.splice(position, 0, card);
            }
        } else if (left) {
            player.cardsInPlay.unshift(card);
        } else {
            player.cardsInPlay.push(card);
        }
        card.updateEffectContexts();
        this.raiseEvent(EVENTS.onTakeControl, { player, card });
    }

    watch(socketId, user) {
        if (!this.allowSpectators && !user.permissions.canManageGames) {
            return false;
        }

        this.playersAndSpectators[user.username] = new Spectator(socketId, user);
        this.addAlert(
            'info',
            '{0} has joined the game as a spectator',
            this.playersAndSpectators[user.username]
        );

        return true;
    }

    join(socketId, user) {
        if (this.started || this.getPlayers().length === 2) {
            return false;
        }

        this.playersAndSpectators[user.username] = new Player(
            socketId,
            user,
            this.owner === user.username,
            this
        );

        return true;
    }

    isEmpty() {
        return Object.values(this.playersAndSpectators).every((player) => {
            if (player.left || player.id === 'TBA') {
                return true;
            }

            if (!player.disconnectedAt) {
                return false;
            }

            let difference = moment().diff(moment(player.disconnectedAt), 'seconds');

            return difference > 30;
        });
    }

    leave(playerName) {
        let player = this.playersAndSpectators[playerName];

        if (!player) {
            return;
        }

        this.addAlert('info', '{0} has left the game', player);

        this.jsonForUsers[player.name] = undefined;

        if (this.isSpectator(player) || !this.started) {
            delete this.playersAndSpectators[playerName];
        } else {
            player.left = true;

            if (!this.finishedAt) {
                this.finishedAt = new Date();
            }

            this.recordAbandonmentResultOnLeave(player);
        }
    }

    /**
     * ARCHON: award a started, unfinished game to the leaving player when
     * their opponent has ALREADY abandoned it (left or disconnected). Without
     * this, a player could dodge a rated loss by quitting first (disconnect or
     * leave) and forcing the opponent to leave an unfinished game that then
     * evaporates with no winner and is never rated.
     *
     * The ordinary "leave = concede to a still-present opponent" case is
     * intentionally NOT handled here: the client sends an explicit concede
     * whenever the opponent is still active, and we must not forfeit a player
     * who leaves an opponent that is merely idle/inactive (not abandoned).
     */
    recordAbandonmentResultOnLeave(leaver) {
        if (this.winner) {
            return;
        }

        const opponents = Object.values(this.playersAndSpectators).filter(
            (player) => player !== leaver && !this.isSpectator(player) && player.id !== 'TBA'
        );

        if (opponents.length !== 1) {
            return;
        }

        const opponent = opponents[0];

        if (opponent.left || opponent.disconnectedAt) {
            this.recordWinner(leaver, 'abandoned');
        }
    }

    /**
     * ARCHON: score a game whose loser walked away and never came back.
     *
     * Quitting by closing the tab used to cost nothing. `disconnect()` only
     * marks the player away and waits - nothing here ever decided the game on
     * its own, so the result depended entirely on the OPPONENT going back into
     * the game and pressing Leave. If they instead closed their own tab
     * (reasonable: their opponent had vanished), or wandered off, or simply
     * assumed the win was already theirs, the game sat until `isEmpty()` swept
     * it up 30 seconds later and `closeGame` fired GAMECLOSED - which, unlike
     * GAMEWIN and PLAYERLEFT, never calls `gameService.update`. No winner, no
     * FinishedAt, no rating, and since the record counts only rows with both
     * ("WHERE g.FinishedAt IS NOT NULL AND g.WinnerId IS NOT NULL"), the game
     * had never happened. Rage-quitting was strictly better than conceding.
     *
     * So the decision moves here, where nobody has to be watching for it. Two
     * shapes, and both are about a socket that closed rather than a button that
     * was pressed:
     *
     *  - **One player gone, past the timeout.** They abandoned it; the player
     *    still sitting at the board wins.
     *  - **Both gone, and the game is being destroyed** (`closing`). Last
     *    chance to record anything, so the one who went FIRST loses - the same
     *    rule `recordAbandonmentResultOnLeave` already applies to leaving.
     *
     * ## What this deliberately does not touch
     *
     * Only `disconnectedAt` counts as abandonment. An explicit Leave does not,
     * because two paths already cover it honestly and a third would contradict
     * them: the client sends `concede` before `leavegame` whenever the opponent
     * is live, and `recordAbandonmentResultOnLeave` awards the game to somebody
     * leaving an opponent who is already gone. More to the point,
     * `checkInactivity` promises in chat that a player facing a 5-minute-idle
     * opponent "may ... leave the game without recording a loss" - forfeiting
     * them here on a timer would break that promise silently.
     *
     * The timeout is generous on purpose. A dropped connection and a quit look
     * identical from here, so it has to be long enough to lose a browser and
     * come back: the opponent may still take the win by hand at any point, and
     * this only decides the games where nobody does.
     *
     * @param {object} [options]
     * @param {Date} [options.now]
     * @param {boolean} [options.closing] the game is about to be destroyed
     * @returns {boolean} whether a result was recorded
     */
    checkAbandonment({ now = new Date(), closing = false } = {}) {
        if (this.winner || !this.started) {
            return false;
        }

        const players = this.getPlayers().filter((player) => player.id !== 'TBA');

        if (players.length !== 2) {
            return false;
        }

        const away = players
            .filter((player) => player.disconnectedAt && !player.left && !player.connectFailed)
            .sort((first, second) => first.disconnectedAt - second.disconnectedAt);

        if (away.length === 1) {
            const [quitter] = away;
            const opponent = players.find((player) => player !== quitter);

            // Somebody who left of their own accord is not owed the game.
            if (opponent.left) {
                return false;
            }

            if (!closing && now - quitter.disconnectedAt < this.abandonmentTimeoutMs) {
                return false;
            }

            this.addAlert('info', '{0} abandoned the game.', quitter);
            this.recordWinner(opponent, 'abandoned');

            return true;
        }

        if (away.length !== 2 || !closing) {
            return false;
        }

        const [quitter, opponent] = away;

        // Both sockets closing within moments of each other is far more likely
        // to be the network than two independent decisions to quit, and there
        // is no honest way to say who abandoned whom. Record nothing.
        if (opponent.disconnectedAt - quitter.disconnectedAt < 10 * 1000) {
            return false;
        }

        this.addAlert('info', '{0} abandoned the game.', quitter);
        this.recordWinner(opponent, 'abandoned');

        return true;
    }

    disconnect(playerName) {
        let player = this.playersAndSpectators[playerName];

        if (!player) {
            return;
        }

        this.jsonForUsers[player.name] = undefined;

        if (this.isSpectator(player)) {
            this.addAlert('info', '{0} has disconnected.', player);

            delete this.playersAndSpectators[playerName];
        } else {
            const opponent = this.getPlayers().find((p) => p !== player);

            // ARCHON: the old wording ("after 30 seconds may leave without
            // recording a loss") was wrong twice over. Leaving an opponent who
            // has already gone does not merely avoid a loss, it wins the game -
            // recordAbandonmentResultOnLeave does that, and immediately, with
            // no 30-second wait anywhere in it. And it said nothing about the
            // case that actually matters: that waiting is now safe, because
            // checkAbandonment awards the game whether or not anybody acts.
            this.addAlert(
                'info',
                '{0} has disconnected. {1} may leave now to take the win, or wait - if {0} has not come back in {2} minutes the game is awarded to {1}.',
                player,
                opponent,
                Math.round(this.abandonmentTimeoutMs / 60000)
            );

            player.disconnectedAt = new Date();
        }

        player.socket = undefined;
    }

    /**
     * @param {'same'|'swap'|'change'} mode 'same' replays with the same decks
     * on the same sides; 'swap' replays with the decks swapped between
     * players; 'change' lets each player pick a different deck.
     */
    rematch(mode = 'same') {
        if (!this.finishedAt) {
            this.finishedAt = new Date();
            this.winReason = 'rematch';
        }

        if (mode === 'change') {
            this.swap = false;
            this.router.rematchWithNewDecks(this);
            return;
        }

        if (mode === 'swap') {
            this.swap = !this.swap;
        }

        this.router.rematch(this);
    }

    /**
     * ARCHON: continue this match at this table.
     *
     * Deliberately NOT a rematch. A rematch builds a fresh pending game
     * carrying none of the event with it - no match id, so the result could
     * never be reported, and no deck pin, so both players would get a free
     * choice in an event that had locked them. This hands the table back to the
     * lobby, which knows the match and seats both players at whichever table
     * the event has opened for the next game.
     *
     * The result of the game just played is already recorded: GAMEWIN fired
     * when it ended, long before anybody pressed this.
     */
    nextTournamentGame() {
        if (!this.tournament) {
            return;
        }

        if (!this.finishedAt) {
            this.finishedAt = new Date();
        }

        this.router.tournamentNextGame(this);
    }

    timeExpired() {
        this.emit('onTimeExpired');
    }

    failedConnect(playerName) {
        let player = this.playersAndSpectators[playerName];

        if (!player) {
            return;
        }

        if (this.isSpectator(player) || !this.started) {
            delete this.playersAndSpectators[playerName];
        } else {
            this.addAlert('warning', '{0} has failed to connect to the game', player);

            player.disconnectedAt = new Date();

            // ARCHON: this is not somebody walking out - the client reports
            // `connectfailed` only when it NEVER reached the game node, so they
            // have not seen the board at all. It writes the same
            // `disconnectedAt` a quitter does, so checkAbandonment needs the
            // distinction to avoid charging a loss to a player whose network
            // could not get here in the first place. There is nothing to abuse:
            // reaching this state means never connecting, and you cannot quit a
            // game you were never in.
            player.connectFailed = true;

            if (!this.finishedAt) {
                this.finishedAt = new Date();
            }
        }
    }

    reconnect(socket, playerName) {
        let player = this.getPlayerByName(playerName);
        if (!player) {
            return;
        }

        player.id = socket.id;
        player.socket = socket;
        player.disconnectedAt = undefined;
        player.connectFailed = false;

        this.jsonForUsers[player.name] = undefined;

        this.addAlert('info', '{0} has reconnected', player);
    }

    checkGameState(hasChanged = false, modifiedByPlayer) {
        // check for a game state change (recalculating conflict skill if necessary)
        if (this.effectEngine.checkEffects(hasChanged) || hasChanged) {
            this.checkWinCondition();
            // if the state has changed, check for:
            let modifiedControl = false;
            const allPlayers = this.getPlayers();
            for (const player of allPlayers) {
                for (const card of [...player.cardsInPlay]) {
                    const newController = card.getModifiedController();
                    if (newController !== player && allPlayers.includes(newController)) {
                        this.takeControl(newController, card, modifiedByPlayer);
                        modifiedControl = true;
                    }
                }
            }

            if (modifiedControl) {
                return;
            }

            // destroy any creatures who have damage greater than equal to their power
            let creaturesToDestroy = this.creaturesInPlay.filter(
                (card) =>
                    card.type === 'creature' &&
                    (card.power <= 0 || card.damage >= card.power) &&
                    !card.moribund
            );
            if (creaturesToDestroy.length > 0) {
                this.actions.destroy().resolve(creaturesToDestroy, this.getFrameworkContext());
            }

            for (let card of this.creaturesInPlay) {
                card.removeToken('armor');
                if (card.armorTotal - card.armorUsed > 0) {
                    card.addToken('armor', card.armorTotal - card.armorUsed);
                }
            }

            // any terminal conditions which have met their condition
            this.effectEngine.checkTerminalConditions();
        }
    }

    getEffectSource(context) {
        if (!context || !context.source) {
            return null;
        }
        let generatingEffect = this.effectEngine.effects.find(
            (effect) => effect.effect.getValue(context.source) === context.ability
        );
        return generatingEffect ? generatingEffect.source : null;
    }

    checkDelayedEffects(events) {
        if (events.length > 0) {
            // check for any delayed effects which need to fire
            this.effectEngine.checkDelayedEffects(events);
        }
    }

    raiseEndRoundEvent() {
        this.raiseEvent(EVENTS.onTurnEnd, { player: this.activePlayer }, () => {
            this.endRound();
        });
    }

    /**
     * Game command: the waiting player forces the idle player's turn to end.
     */
    forcePass(playerName) {
        if (!this.forcePassAvailable) {
            return;
        }

        const player = this.getPlayerByName(playerName);
        if (!player || player === this.activePlayer) {
            return;
        }

        // Re-verify the active player is actually inactive right now
        const now = Date.now();
        const lastEvent = this.activePlayer.lastEventAt || 0;
        const threshold = this.forcePassCount > 0 ? 0 : this.inactivityThresholdMs;
        if (now - lastEvent < threshold) {
            this.forcePassAvailable = false;
            this.activePlayer.inactive = false;
            return;
        }

        this.addAlert(
            'warning',
            '{0} forces {1} to pass their turn due to inactivity.',
            player,
            this.activePlayer
        );

        this.forcePassCount++;
        this.forcePassAvailable = false;

        // Clear all remaining steps in the pipeline (cancels prompts a la manual mode)
        this.pipeline.pipeline = [];
        this.pipeline.queue = [];

        // Set pipeline directly to avoid ordering issues with queueStep
        this.pipeline.initialise([
            new SimpleStep(this, () => this.raiseEndRoundEvent()),
            new SimpleStep(this, () => this.beginRound())
        ]);
    }

    endRound() {
        if (this.activePlayer.canForgeKey()) {
            this.addAlert('success', '{0} declares Check!', this.activePlayer);
        }

        this.activePlayer.endRound();
        this.cardNamesPlayedOrUsed = [];
        this.cardsUsed = [];
        this.omegaCard = null;
        this.cardsPlayed = [];
        this.cardsDiscarded = [];
        this.effectsUsed = [];
        this.resetThingsThisPhase();

        for (let card of this.cardsInPlay) {
            card.endRound();
        }

        this.activePlayer.activeHouse = null;

        if (this.activePlayer.opponent && !this.activePlayer.anyEffect('anotherTurn')) {
            this.activePlayer = this.activePlayer.opponent;
        }

        let playerResources = this.getPlayers()
            .map((player) => `${player.name}: ${player.amber} amber (${this.playerKeys(player)})`)
            .join(' ');

        this.addAlert('endofturn', `End of turn ${this.round}`);

        if (
            !this.activePlayer.opponent ||
            this.activePlayer.turn === this.activePlayer.opponent.turn
        ) {
            this.round++;
        }

        this.addMessage(playerResources);
        this.addAlert('startofturn', `Turn ${this.round} - {0}`, this.activePlayer);
        this.checkForTimeExpired();
    }

    playerKeys(player) {
        const length = Object.values(player.keys).filter((forged) => forged).length;
        return length === 1 ? '1 key' : `${length} keys`;
    }

    isKeyForged(color) {
        return this.getPlayers().some((player) => player.keys[color]);
    }

    get cardsInPlay() {
        return this.getPlayers().reduce((array, player) => array.concat(player.cardsInPlay), []);
    }

    get activeProphecies() {
        return this.getPlayers().reduce(
            (array, player) => array.concat(player.activeProphecies),
            []
        );
    }

    get creaturesInPlay() {
        return this.cardsInPlay.filter((card) => card.type === 'creature');
    }

    /**
     * Return all houses in play.
     *
     * @param {Array} cards - which cards to consider. Default are all cards.
     * @param {boolean} upgrade - if upgrades should be counted. Default is false.
     * @param {function} filter - an extra filter to apply to the card.
     */
    getHousesInPlay(cards = this.cardsInPlay, upgrade = false, filter = null) {
        return Constants.Houses.filter((house) =>
            cards.some(
                (card) =>
                    ((!filter || filter(card)) && card.hasHouse(house)) ||
                    (upgrade &&
                        card.upgrades &&
                        card.upgrades.some(
                            (upgrade) => (!filter || filter(upgrade)) && upgrade.hasHouse(house)
                        ))
            )
        );
    }

    firstThingThisPhase() {
        return (
            this.cardsDiscardedThisPhase.length === 0 &&
            this.cardsUsedThisPhase.length === 0 &&
            this.cardsPlayedThisPhase.length === 0 &&
            this.effectsUsedThisPhase.length === 0
        );
    }

    resetThingsThisPhase() {
        this.effectsUsedThisPhase = [];
        this.cardsDiscardedThisPhase = [];
        this.cardsPlayedThisPhase = [];
        this.cardsUsedThisPhase = [];
        this.propheciesActivatedThisPhase = [];
        this.gainsTextBoxSourcesThisPhase = [];
    }

    effectUsed(card) {
        this.effectsUsed.push(card);
        this.effectsUsedThisPhase.push(card);
    }

    cardDiscarded(card) {
        this.cardsDiscarded.push(card);
        this.cardsDiscardedThisPhase.push(card);
    }

    cardPlayed(card) {
        this.cardsPlayed.push(card);
        // Some cards depend on the type of the player card, which may have changed after it was played.
        this.cardsPlayedThisPhase.push(card.createSnapshot());
        this.cardNamesPlayedOrUsed.push(card.name);
    }

    cardUsed(card) {
        this.cardsUsed.push(card);
        this.cardsUsedThisPhase.push(card);
        this.cardNamesPlayedOrUsed.push(card.name);
    }

    prophecyActivated(prophecyCard) {
        this.propheciesActivated.push(prophecyCard);
        this.propheciesActivatedThisPhase.push(prophecyCard);
    }

    continue() {
        this.pipeline.continue();

        // ARCHON: record the board here, where the engine itself settles,
        // rather than only from the game node's broadcast.
        //
        // Capture used to hang entirely off `GameServer.sendGameState`, which
        // made the recording a property of socket traffic: anything that
        // advanced the game without a broadcast left a hole, and nothing that
        // drives the engine directly - the scenario runner, the test harness -
        // recorded at all, so no test could ever prove a real game produces a
        // usable replay. The node still calls it too; the call self-throttles
        // to log advances, so recording from both is one snapshot, not two.
        this.recordBoardSnapshot();
    }

    /*
     * This information is all logged when a game is won
     */
    getSaveState() {
        let players = this.getPlayers().map((player) => {
            return {
                deck: player.deckData.identity,
                houses: player.houses,
                keys: player.keys,
                name: player.name,
                turn: player.turn,
                wins: player.wins,
                // ARCHON (N12): who took the first turn. The engine has always
                // known this (FirstPlayerSelection sets game.firstPlayer) but
                // never persisted it, so "do I win more going first?" could not
                // be answered for any game ever played. Recorded from here on;
                // historic games stay null and are excluded from that split
                // rather than guessed at.
                //
                // Undefined rather than false when the game ended before first
                // player was chosen, so "not recorded" stays distinguishable
                // from "went second".
                wentFirst: this.firstPlayer ? this.firstPlayer === player : undefined
            };
        });

        let spectators = this.getSpectators().map((spectator) => {
            return {
                id: spectator.id,
                lobbyId: spectator.lobbyId,
                name: spectator.name
            };
        });

        return {
            adaptive: this.adaptive,
            // ARCHON (F9): flagged so every persistence path (GAMEWIN,
            // REMATCH, PLAYERLEFT) can keep practice games out of the record.
            // Undefined rather than false keeps ordinary saves unchanged.
            botGame: this.botGame || undefined,
            botStyle: this.botStyle || undefined,
            finishedAt: this.finishedAt,
            gameFormat: this.gameFormat,
            gameId: this.id,
            gamePrivate: this.gamePrivate,
            id: this.savedGameId,
            players: players,
            previousWinner: this.previousWinner,
            startedAt: this.startedAt,
            swap: this.swap,
            tournament: this.tournament,
            winReason: this.winReason,
            winner: this.winner ? this.winner.name : undefined,
            spectators: spectators
        };
    }

    /**
     * ARCHON: the drawable identity of a card - the part that does not change
     * while the game runs, and the only part the replay viewer needs to put a
     * picture on the board.
     *
     * Everything the live client uses to make a card interactive (its menu,
     * whether it can be played, selection state, the ten-language locale block)
     * is dropped. A recording is read, not played.
     *
     * @param {object} summary a card summary from `Card.getSummary`
     */
    static replayCardIdentity(summary) {
        const identity = {
            id: summary.id,
            name: summary.name,
            image: summary.image,
            number: summary.number,
            house: summary.printedHouse,
            type: summary.type
        };

        // The printed numbers the card renderer draws on the card face. Printed
        // values do not change, so they belong here rather than in every frame;
        // power under an effect is recorded per frame instead.
        if (summary.powerPrinted) {
            identity.power = summary.powerPrinted;
        }

        if (summary.armorPrinted) {
            identity.armor = summary.armorPrinted;
        }

        if (summary.cardPrintedAmber) {
            identity.amber = summary.cardPrintedAmber;
        }

        // Only when true/present: an absent key costs nothing, a `false` costs
        // its name in every snapshot that mentions the card.
        if (summary.facedown) {
            identity.facedown = true;
            identity.cardback = summary.cardback;
        }

        if (summary.maverick) {
            identity.maverick = summary.maverick;
        }

        if (summary.anomaly) {
            identity.anomaly = summary.anomaly;
        }

        if (Array.isArray(summary.enhancements) && summary.enhancements.length > 0) {
            identity.enhancements = summary.enhancements;
        }

        return identity;
    }

    /**
     * The index of a card identity in one of the recording's card tables,
     * adding it if this is the first time it has been seen.
     *
     * Keyed by the identity itself rather than by the card's uuid, so a card
     * whose identity changes mid-game (a token creature, anything under
     * `copyCard`) gets a second entry and the snapshots either side of the
     * change each point at the right one.
     */
    indexReplayCardIn(table, keys, summary) {
        const identity = Game.replayCardIdentity(summary);
        const key = JSON.stringify(identity);
        const existing = keys.get(key);

        if (existing !== undefined) {
            return existing;
        }

        const index = table.length;

        table.push(identity);
        keys.set(key, index);

        return index;
    }

    /** The index of a card identity in the recording's public card table. */
    indexReplayCard(summary) {
        if (!this.replayCards) {
            this.replayCards = [];
            this.replayCardKeys = new Map();
        }

        return this.indexReplayCardIn(this.replayCards, this.replayCardKeys, summary);
    }

    /**
     * ARCHON (F3): the index of a card identity in the recording's SEPARATE
     * hand-card table.
     *
     * Hands are hidden information, and the public card table must stay free
     * of them: an identity is only added to `cards` when a card shows up in an
     * open zone, so even the set of entries in that table reveals nothing a
     * live spectator would not have seen. Cards recorded in hands index into
     * `handCards` instead, and the two are stripped together
     * (`stripReplayHands`) whenever a reader may not see them.
     */
    indexReplayHandCard(summary) {
        if (!this.replayHandCards) {
            this.replayHandCards = [];
            this.replayHandCardKeys = new Map();
        }

        return this.indexReplayCardIn(this.replayHandCards, this.replayHandCardKeys, summary);
    }

    /**
     * A card in play, as a snapshot records it: a reference into the card table
     * plus only the state that actually changes.
     */
    replayCardInPlay(summary) {
        const card = { card: this.indexReplayCard(summary), uuid: summary.uuid };

        if (summary.exhausted) {
            card.exhausted = true;
        }

        if (summary.stunned) {
            card.stunned = true;
        }

        if (summary.taunt) {
            card.taunt = true;
        }

        // Power under effects, and only when it differs from the printed value
        // the card table already carries.
        if (summary.modifiedPower != null && summary.modifiedPower !== summary.powerPrinted) {
            card.power = summary.modifiedPower;
        }

        if (summary.tokens && Object.keys(summary.tokens).length > 0) {
            card.tokens = summary.tokens;
        }

        if (Array.isArray(summary.childCards) && summary.childCards.length > 0) {
            card.upgrades = summary.childCards.map((child) => this.replayCardInPlay(child));
        }

        return card;
    }

    /**
     * ARCHON: a compact, spectator-safe picture of the board right now, for the
     * replay viewer.
     *
     * Deliberately not `getState()`: that carries the whole chat log, prompt
     * state and per-player settings, none of which a replay needs and all of
     * which would be duplicated into every snapshot. This is only what is
     * required to draw the board.
     *
     * ## Why the piles are references rather than card summaries
     *
     * They used to be full `getSummary` output, which is what the live client
     * receives - around 1.1 KB per card, most of it a ten-language locale block
     * and interaction state a recording can never use. A mid-game snapshot came
     * to 27 KB, and a game that hit the snapshot cap produced a 16 MB
     * recording: eight times the 2 MB store limit, so `saveReplay` skipped it.
     * Every replay of a normal-length game was being thrown away at the point
     * of storage, which is why "replays don't work" - the capture worked, the
     * store refused it, and the only trace was one warn line in the node's log.
     *
     * Static piles are therefore arrays of indices into the recording's card
     * table, and cards in play carry a reference plus only their live state.
     * The same board draws from roughly a tenth of the bytes.
     *
     * Every card list is still rendered from an AnonymousSpectator's
     * perspective, so hidden information (hands, deck order, archived cards) is
     * redacted by the same code path that protects live spectators - a replay
     * can never reveal more than watching the game would have.
     */
    getBoardSnapshot() {
        const spectator = new AnonymousSpectator();

        return {
            round: this.round,
            phase: this.currentPhase,
            activePlayer: this.activePlayer ? this.activePlayer.name : undefined,
            players: this.getPlayers().map((player) => {
                const pile = (cards) =>
                    player
                        .getSummaryForCardList(cards, spectator)
                        .map((card) => this.indexReplayCard(card));

                return {
                    name: player.name,
                    activeHouse: player.activeHouse,
                    houses: player.houses,
                    // ARCHON (F3): which houses the active player could
                    // legally call, so the misplay review never second-guesses
                    // a forced or restricted choice (Control the Weak and
                    // friends). Clipped to the deck's own public houses:
                    // getAvailableHouses also reads the hand, and an exotic
                    // foreign-house card there must not leak through a list.
                    // Restriction effects themselves are played openly, so
                    // what remains is spectator-safe.
                    ...(player === this.activePlayer
                        ? {
                              callableHouses: player
                                  .getAvailableHouses()
                                  .filter((house) => (player.houses || []).includes(house))
                          }
                        : {}),
                    stats: player.getStats(),
                    // ARCHON: the player's own turn counter, so analysis can
                    // talk about "your fourth turn" rather than about the
                    // shared round number, which advances once for both.
                    turn: player.turn,
                    numDeckCards: player.deck.length,
                    numHandCards: player.hand.length,
                    cardPiles: {
                        cardsInPlay: player
                            .getSummaryForCardList(player.cardsInPlay, spectator)
                            .map((card) => this.replayCardInPlay(card)),
                        discard: pile(player.discard),
                        purged: pile(player.purged),
                        archives: pile(player.archives)
                    }
                };
            })
        };
    }

    /**
     * ARCHON (F3): each player's hand at this moment, for the misplay review.
     *
     * NOT part of the board snapshot, on purpose. The board is rendered through
     * an AnonymousSpectator so a recording can never show more than watching
     * would have - and there is a test holding that door shut. Hands are the
     * one thing a review of your own play cannot do without ("what could I
     * have called instead?"), so they are captured alongside each frame from
     * each player's OWN perspective, as references into a separate
     * `handCards` table, and both travel under keys of their own that the
     * serving layer strips for anyone who may not read them: share links
     * always, and any account below the Archon tier.
     *
     * A card hidden even from its holder (facedown in hand) records as its
     * facedown identity, exactly as the holder saw it.
     */
    getHandsSnapshot() {
        const hands = {};

        for (const player of this.getPlayers()) {
            hands[player.name] = player
                .getSummaryForCardList(player.hand, player, true)
                .map((card) => this.indexReplayHandCard(card));
        }

        return hands;
    }

    /**
     * ARCHON (F3): each player's archives at this moment, from the owner's
     * perspective, for the misplay review and the replay viewer.
     *
     * The board snapshot records archives as a facedown count - that is what
     * a spectator sees, and it stays that way. This is the owner's view of
     * the same pile: the archives feed every house call (they come to hand on
     * calling ANY house), so a review that cannot see them cannot read house
     * calls honestly. Same table, same side channel and same stripping rules
     * as the hands: share links never, your own only, admins both. A card
     * hidden even from its owner records as its facedown identity.
     */
    getArchivesSnapshot() {
        const archives = {};

        for (const player of this.getPlayers()) {
            archives[player.name] = player
                .getSummaryForCardList(player.archives, player)
                .map((card) => this.indexReplayHandCard(card));
        }

        return archives;
    }

    /**
     * ARCHON: append a board snapshot to the in-memory recording, keyed to how
     * far the message log had got, so the viewer can show the board as it stood
     * at any point in the play-by-play.
     *
     * Only records when the log has actually advanced - the game state is
     * broadcast far more often than anything visible changes.
     *
     * At the cap the recording is HALVED rather than cut off. Stopping dead
     * meant a long game had a board for its opening and nothing at all for the
     * half that decided it, which is the half anyone opens a replay to see.
     * Dropping every other frame instead costs resolution evenly across the
     * whole game and keeps recording to the end; `thinned` says it happened.
     *
     * `final` is for the one snapshot that has to be taken after the game is
     * over: the winning position. Without it a recording stops at the board as
     * it stood BEFORE the last key was forged, so the viewer's last frame never
     * shows the win and the forge markers are always one short. It bypasses the
     * finished guard for that single frame.
     *
     * @param {{final?: boolean}} [options]
     */
    recordBoardSnapshot({ final = false } = {}) {
        if (!this.started || (this.finishedAt && !final)) {
            return;
        }

        if (!this.replaySnapshots) {
            this.replaySnapshots = [];
            this.replayTruncated = false;
            this.replayThinned = false;
        }

        const messageIndex = this.gameChat ? this.gameChat.messages.length : 0;
        const last = this.replaySnapshots[this.replaySnapshots.length - 1];

        if (last && last.messageIndex === messageIndex) {
            return;
        }

        if (this.replaySnapshots.length >= Game.MAX_REPLAY_SNAPSHOTS) {
            // Keep the even-indexed frames, which keeps the first; the newest
            // is about to be pushed on the end.
            this.replaySnapshots = this.replaySnapshots.filter(
                (snapshot, index) => index % 2 === 0
            );
            this.replayThinned = true;
        }

        try {
            // The board first: it is the half that must never fail, and its
            // capture populates the public card table before the hidden zones
            // touch their own. `hands` and `archives` are siblings of `board`
            // rather than part of it, so thinning keeps them aligned and
            // stripping hidden information is the removal of known keys.
            this.replaySnapshots.push({
                messageIndex,
                board: this.getBoardSnapshot(),
                hands: this.getHandsSnapshot(),
                archives: this.getArchivesSnapshot()
            });
        } catch {
            // A replay is never worth risking a live game over. The flag is
            // returned with the recording and surfaced in the viewer, so a
            // failed capture is visible rather than silently missing.
            this.replayTruncated = true;
        }
    }

    /**
     * ARCHON: a self-contained recording of the finished game for the replay
     * viewer - the structured play-by-play log, the board as it stood at each
     * step, plus enough header to render it standalone. Read-only; the capture
     * itself never influences gameplay.
     */
    getReplay() {
        return {
            // v3 added the final winning snapshot, each player's deck name,
            // houses and end state, and who went first. v4 added each player's
            // hand beside every frame (`snapshots[].hands`, indexing into
            // `handCards`) for the misplay review. v5 added the active
            // player's legally callable houses per frame, so the review can
            // tell a forced call from a chosen one. v6 adds each player's own
            // view of their archives beside the hands, in the same table and
            // under the same stripping rules. Earlier recordings are still
            // readable - the viewer and the analysis both treat everything
            // added since as optional.
            version: 6,
            gameId: this.id,
            gameFormat: this.gameFormat,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            winner: this.winner ? this.winner.name : undefined,
            winReason: this.winReason,
            // ARCHON: who took the first turn. Turn order decides a great deal
            // in KeyForge and it is the first thing anyone asks of a finished
            // game, so it travels with the recording rather than having to be
            // joined back to GamePlayers.
            firstPlayer: this.firstPlayer ? this.firstPlayer.name : undefined,
            rounds: this.round,
            players: this.getPlayers().map((player) => ({
                name: player.name,
                deck: player.deckData ? player.deckData.identity : undefined,
                // The name is what a reader recognises; the identity is what
                // joins back to a Decks row. Both, because a shared replay is
                // rendered standalone with no database behind it.
                deckName: player.deckData ? player.deckData.name : undefined,
                expansion: player.deckData ? player.deckData.expansion : undefined,
                houses: player.houses,
                keys: player.keys,
                amber: player.amber,
                chains: player.chains,
                turns: player.turn
            })),
            messages: this.gameChat ? this.gameChat.messages : [],
            // The card table the snapshots' piles index into. Written once for
            // the whole recording rather than repeated in every frame.
            cards: this.replayCards || [],
            // The table the recorded hidden zones (hands and archives) index
            // into - separate from `cards` so hidden information never seeps
            // into the public table, and so stripping them (share links,
            // accounts below Archon) removes every trace at once.
            handCards: this.replayHandCards || [],
            snapshots: this.replaySnapshots || [],
            truncated: !!this.replayTruncated,
            // The game outran the snapshot budget and the board is recorded at
            // half resolution (or a quarter, and so on). The log is complete
            // either way; only the board frames between entries are missing.
            thinned: !!this.replayThinned
        };
    }

    /*
     * This information is sent to the client
     */
    getState(activePlayerName) {
        let activePlayer = this.playersAndSpectators[activePlayerName] || new AnonymousSpectator();
        let playerState = {};

        if (this.started) {
            for (const player of this.getPlayers()) {
                playerState[player.name] = player.getState(activePlayer);
            }

            this.timeLimit.checkForTimeLimitReached();

            return {
                adaptive: this.adaptive,
                // ARCHON (N41): the pilot the human chose to face, named on the
                // board rather than only on the pending screen. A style picked
                // and then never mentioned again is a setting, not an opponent
                // - and "which one keeps beating me" was a question the player
                // had no way to ask.
                botStyleLabel: this.botStyleLabel || undefined,
                cancelPromptUsed: this.cancelPromptUsed,
                // ARCHON: player-level lasting effects (Befuddle and friends),
                // which otherwise leave no trace on the board.
                effects: this.effectEngine.getPlayerEffectSummary(),
                forcePassAvailable: this.forcePassAvailable,
                gameFormat: this.gameFormat,
                gamePrivate: this.gamePrivate,
                gameTimeLimitStarted: this.timeLimit.timeLimitStarted,
                gameTimeLimitStartedAt: this.timeLimit.timeLimitStartedAt,
                gameTimeLimitTime: this.timeLimit.timeLimitInMinutes,
                hideDeckLists: this.hideDeckLists,
                id: this.id,
                manualMode: this.manualMode,
                messages: this.gameChat.messages,
                muteSpectators: this.muteSpectators,
                name: this.name,
                owner: this.owner,
                players: playerState,
                previousWinner: this.previousWinner,
                scenario: this.scenario,
                showHand: this.showHand,
                spectators: this.getSpectators().map((spectator) => {
                    return {
                        id: spectator.id,
                        name: spectator.name
                    };
                }),
                started: this.started,
                swap: this.swap,
                useGameTimeLimit: this.useGameTimeLimit,
                winner: this.winner ? this.winner.name : undefined
            };
        }

        return this.getSummary(activePlayerName);
    }

    getSummary(activePlayerName, options = {}) {
        let playerSummaries = {};

        for (const player of this.getPlayers()) {
            let deck = undefined;
            if (player.left) {
                continue;
            }

            if (activePlayerName === player.name && player.deck) {
                deck = { name: player.deck.name, selected: player.deck.selected };
            } else if (player.deck) {
                deck = { selected: player.deck.selected };
            } else {
                deck = {};
            }

            playerSummaries[player.name] = {
                deck: deck,
                emailHash: player.emailHash,
                faction: '',
                id: player.id,
                left: player.left,
                lobbyId: player.lobbyId,
                name: player.name,
                owner: player.owner,
                user: options.fullData && player.user,
                wins: player.wins
            };
        }

        return {
            adaptive: this.adaptive,
            allowSpectators: this.allowSpectators,
            // ARCHON (F9): rides the node sync so a restarted lobby still
            // counts a running practice game against the Helper Bot's cap.
            botGame: this.botGame || undefined,
            createdAt: this.createdAt,
            gameFormat: this.gameFormat,
            gamePrivate: this.gamePrivate,
            id: this.id,
            manualMode: this.manualMode,
            messages: this.gameChat.messages,
            muteSpectators: this.muteSpectators,
            name: this.name,
            owner: this.owner,
            players: playerSummaries,
            scenario: this.scenario,
            showHand: this.showHand,
            spectators: this.getSpectators().map((spectator) => {
                return {
                    id: spectator.id,
                    lobbyId: spectator.lobbyId,
                    name: spectator.name
                };
            }),
            started: this.started,
            startedAt: this.startedAt,
            swap: this.swap,
            winner: this.winner ? this.winner.name : undefined
        };
    }
}

// ARCHON: hard cap on recorded board snapshots. A KeyForge game produces a few
// hundred log entries; this is generous for a normal game and bounds the stored
// size of a pathological one. Hitting it sets `truncated` on the recording.
Game.MAX_REPLAY_SNAPSHOTS = 600;

module.exports = Game;
