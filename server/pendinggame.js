const { filterText } = require('./services/moderation/contentFilter');
const { randomUUID } = require('node:crypto');
const _ = require('underscore');
const crypto = require('crypto');

const GameChat = require('./game/gamechat.js');
const logger = require('./log');
// ARCHON: site-wide Watch settings (spectator broadcast delay). Read from the
// in-memory snapshot, so handing a game to a node never waits on the database.
const settings = require('./services/settings');
// ARCHON (N12): profile cosmetics, so a lobby seat can show an avatar frame.
const { isDefaultCosmetics } = require('./services/membership/cosmetics');

class PendingGame {
    constructor(owner, details) {
        this.adaptive = details.adaptive;
        this.allowSpectators = details.allowSpectators;
        this.createdAt = new Date();
        this.expansions = details.expansions;
        this.gameChat = new GameChat(this);
        this.gameFormat = details.gameFormat;
        this.gamePrivate = !!details.gamePrivate;
        this.gameTimeLimit = details.gameTimeLimit;
        this.hideDeckLists = details.hideDeckLists;
        this.id = randomUUID();
        this.muteSpectators = details.muteSpectators;
        this.name = details.name;
        this.node = {};
        this.owner = owner;
        this.players = {};
        this.previousWinner = details.previousWinner;
        // Set by the matchmaker (never by a player creating a game), so the
        // client can tell "your opponent arrived" from "we found you one".
        this.quickMatch = !!details.quickMatch;
        this.showHand = details.showHand;
        this.spectators = {};
        this.started = false;
        this.swap = !!details.swap;
        this.useGameTimeLimit = details.useGameTimeLimit;
        this.rematch = false;
        this.tournament = details.tournament;
        // ARCHON: neither deck rule applies where players do not choose their
        // own deck - sealed deals one, tournaments auto-select the registered
        // one - so both are forced off there rather than left to fight those
        // flows.
        const choosesOwnDeck = details.gameFormat !== 'sealed' && !details.tournament;
        this.luckyDice = !!details.luckyDice && choosesOwnDeck;
        this.sasBound = choosesOwnDeck
            ? PendingGame.normalizeSasBound(details.sasBound)
            : undefined;
    }

    /**
     * ARCHON: the SAS range a game may be bound to, cleaned of everything a
     * client could put in it. Details come off the wire, so the range is
     * rebuilt from scratch: integers only, clamped into 1..500 (real SAS runs
     * ~40-120; the cap just bounds nonsense), swapped if backwards. Anything
     * unusable means the game simply is not SAS bound.
     */
    static normalizeSasBound(sasBound) {
        if (!sasBound || typeof sasBound !== 'object') {
            return undefined;
        }

        const clamp = (value) => Math.max(1, Math.min(500, Math.floor(value)));
        const min = Number(sasBound.min);
        const max = Number(sasBound.max);

        if (!Number.isFinite(min) || !Number.isFinite(max)) {
            return undefined;
        }

        return {
            min: clamp(Math.min(min, max)),
            max: clamp(Math.max(min, max))
        };
    }

    // Getters
    getPlayersAndSpectators() {
        return Object.assign({}, this.players, this.spectators);
    }

    getPlayers() {
        return this.players;
    }

    getSpectators() {
        return Object.values(this.spectators);
    }

    getPlayerOrSpectator(playerName) {
        return this.getPlayersAndSpectators()[playerName];
    }

    getPlayerByName(playerName) {
        return this.players[playerName];
    }

    getSaveState() {
        let players = _.map(this.getPlayers(), (player) => {
            return {
                houses: player.houses,
                name: player.name,
                wins: player.wins
            };
        });

        return {
            id: this.id,
            adaptive: this.adaptive,
            // ARCHON (F9): practice games against the Helper Bot are never
            // persisted or rated; the flag travels with every save state.
            botGame: this.botGame || undefined,
            expansions: this.expansions,
            gameFormat: this.gameFormat,
            gamePrivate: this.gamePrivate,
            gameId: this.id,
            players: players,
            previousWinner: this.previousWinner,
            startedAt: this.createdAt,
            swap: this.swap,
            tournament: this.tournament
        };
    }

    // Actions
    addMessage() {
        this.gameChat.addMessage(...arguments);
    }

    addPlayer(id, user) {
        if (!user) {
            logger.error('Tried to add a player to a game that did not have a user object');
            return;
        }

        this.players[user.username] = {
            id: id,
            name: user.username,
            owner: this.owner.username === user.username,
            user: user,
            wins: 0
        };
    }

    addSpectator(id, user) {
        this.spectators[user.username] = {
            emailHash: user.emailHash,
            id: id,
            name: user.username,
            user: user
        };
    }

    newGame(id, user, password, join) {
        if (password) {
            this.password = crypto.createHash('md5').update(password).digest('hex');
        }

        if (join) {
            this.addPlayer(id, user);
        }
    }

    isUserBlocked(user) {
        return _.contains(this.owner.blockList, user.username.toLowerCase());
    }

    join(id, user, password) {
        if (_.size(this.players) === 2 || this.started) {
            return 'Game full';
        }

        // ARCHON: tournament tables are reserved for their paired players
        if (
            this.tournament &&
            Array.isArray(this.tournament.players) &&
            !this.tournament.players.includes(user.username)
        ) {
            return 'This table is reserved for its tournament pairing';
        }

        if (this.isUserBlocked(user)) {
            return 'Cannot join game';
        }

        if (this.password) {
            if (crypto.createHash('md5').update(password).digest('hex') !== this.password) {
                return 'Incorrect game password';
            }
        }

        this.addMessage('{0} has joined the game', user.username);
        this.addPlayer(id, user);

        if (!this.isOwner(this.owner.username)) {
            let otherPlayer = Object.values(this.players).find(
                (player) => player.name !== this.owner.username
            );

            if (otherPlayer) {
                this.owner = otherPlayer.user;
                otherPlayer.owner = true;
            }
        }

        return undefined;
    }

    watch(id, user, password) {
        if (user && user.permissions && user.permissions.canManageGames) {
            this.addSpectator(id, user);
            this.addMessage('{0} has joined the game as a spectator', user.username);

            return;
        }

        if (!this.allowSpectators) {
            return 'Join not permitted';
        }

        if (this.isUserBlocked(user)) {
            return 'Cannot join game';
        }

        if (this.password) {
            if (crypto.createHash('md5').update(password).digest('hex') !== this.password) {
                return 'Incorrect game password';
            }
        }

        this.addSpectator(id, user);
        this.addMessage('{0} has joined the game as a spectator', user.username);
    }

    leave(playerName) {
        let player = this.getPlayerOrSpectator(playerName);
        if (!player) {
            return;
        }

        if (!this.started) {
            this.addMessage('{0} has left the game', playerName);
        }

        if (this.players[playerName]) {
            this.removeAndResetOwner(playerName);

            if (this.started) {
                this.players[playerName].left = true;
            } else {
                delete this.players[playerName];
            }
        }

        if (this.spectators[playerName]) {
            delete this.spectators[playerName];
        }
    }

    disconnect(playerName) {
        let player = this.getPlayerOrSpectator(playerName);
        if (!player) {
            return;
        }

        if (!this.started) {
            this.addMessage('{0} has disconnected', playerName);
        }

        if (this.players[playerName]) {
            if (!this.started) {
                this.removeAndResetOwner(playerName);

                delete this.players[playerName];
            }
        } else {
            delete this.spectators[playerName];
        }
    }

    chat(playerName, message) {
        let player = this.getPlayerOrSpectator(playerName);
        if (!player) {
            return;
        }

        // ARCHON: "Mute spectators" was honoured in the GAME (game.js chat)
        // and not at the table, so the toggle the owner set when creating the
        // game silently did nothing until the first card was dealt - which is
        // exactly the window where somebody waiting for an opponent is most
        // exposed to a stranger who wandered in to watch.
        if (this.muteSpectators && !this.players[playerName]) {
            return;
        }

        player.argType = 'player';

        // Guideline 1.2: filtered where it is posted, like every other chat
        // surface. See services/moderation/contentFilter.
        this.addMessage('{0} {1}', player, filterText(message));
    }

    selectDeck(playerName, deck) {
        var player = this.getPlayerByName(playerName);
        if (!player) {
            return;
        }

        if (player.deck) {
            player.deck.selected = false;
        }

        player.deck = deck;
        player.deck.selected = true;
    }

    // interrogators
    isEmpty() {
        return !_.any(this.getPlayersAndSpectators(), (player) =>
            this.hasActivePlayer(player.name)
        );
    }

    isOwner(playerName) {
        let player = this.players[playerName];

        if (!player || !player.owner) {
            return false;
        }

        return true;
    }

    removeAndResetOwner(playerName) {
        if (this.isOwner(playerName)) {
            let otherPlayer = _.find(this.players, (player) => player.name !== playerName);

            if (otherPlayer) {
                this.owner = otherPlayer.user;
                otherPlayer.owner = true;
            }
        }
    }

    hasActivePlayer(playerName) {
        return (
            (this.players[playerName] &&
                !this.players[playerName].left &&
                !this.players[playerName].disconnected) ||
            this.spectators[playerName]
        );
    }

    isVisibleFor(user) {
        if (!user) {
            return true;
        }

        if (user.permissions && user.permissions.canManageGames) {
            return true;
        }

        let players = Object.values(this.players);
        return (
            !this.owner.hasUserBlocked(user) &&
            !user.hasUserBlocked(this.owner) &&
            players.every((player) => !player.user.hasUserBlocked(user))
        );
    }

    // Summary
    getSummary(activePlayer) {
        let playerSummaries = {};
        let playersInGame = _.filter(this.players, (player) => !player.left);

        _.each(playersInGame, (player) => {
            let deck;

            // ARCHON: deck POWER (SAS) is not deck contents. Both players
            // seeing it before they commit is the point - it is the same number
            // the rating engine already handicaps with, and tournaments already
            // gate entry on it. Suppressed when the game hides decklists, so the
            // existing privacy control still governs.
            const sasRating =
                this.hideDeckLists && activePlayer !== player.name
                    ? undefined
                    : player.deck && player.deck.sasRating != null
                    ? player.deck.sasRating
                    : undefined;

            if (activePlayer === player.name && player.deck && this.gameFormat !== 'sealed') {
                deck = {
                    name: player.deck.name,
                    selected: player.deck.selected,
                    status: player.deck.status,
                    sasRating
                };
            } else if (player.deck) {
                deck = { selected: player.deck.selected, status: player.deck.status, sasRating };
            } else {
                deck = {};
            }

            // ARCHON (N12): the seat shows the member's avatar frame. Omitted
            // when nothing is set, which is most players - this summary is
            // broadcast to the whole lobby whenever a game changes.
            const cosmetics = player.user.cosmetics;

            playerSummaries[player.name] = {
                avatar: player.user.avatar,
                ...(isDefaultCosmetics(cosmetics) ? {} : { cosmetics }),
                deck: activePlayer ? deck : {},
                houses: this.started && player.deck ? player.deck.houses : [],
                id: player.id,
                left: player.left,
                name: player.name,
                owner: player.owner,
                role: player.user.role,
                wins: player.wins
            };
        });

        return {
            adaptive: this.adaptive,
            allowSpectators: this.allowSpectators,
            // ARCHON (F9): lets the game list say this table is the Helper
            // Bot's practice table rather than an ordinary player's game.
            botGame: this.botGame || undefined,
            createdAt: this.createdAt,
            gameFormat: this.gameFormat,
            gamePrivate: this.gamePrivate,
            id: this.id,
            luckyDice: this.luckyDice,
            messages: activePlayer ? this.gameChat.messages : undefined,
            muteSpectators: this.muteSpectators,
            name: this.name,
            needsPassword: !!this.password,
            node: this.node ? this.node.identity : undefined,
            owner: this.owner.username,
            players: playerSummaries,
            previousWinner: this.previousWinner,
            quickMatch: this.quickMatch,
            sasBound: this.sasBound,
            // ARCHON (F9): lets the game list tell a showcase match apart
            // from an ordinary practice table - both are botGame.
            showcaseGame: this.showcaseGame || undefined,
            showHand: this.showHand,
            started: this.started,
            swap: this.swap,
            spectators: Object.values(this.spectators).map((spectator) => {
                return {
                    id: spectator.id,
                    name: spectator.name,
                    avatar: spectator.user.avatar
                };
            }),
            tournament: this.tournament
                ? {
                      tournamentId: this.tournament.tournamentId,
                      matchId: this.tournament.matchId,
                      gameNumber: this.tournament.gameNumber,
                      round: this.tournament.round,
                      table: this.tournament.table,
                      players: this.tournament.players,
                      // ARCHON: the deck lock, as far as this viewer needs to
                      // know it. Whether THEIR seat is pinned and under which
                      // policy - never which deck anyone else is pinned to,
                      // which is decklist information and stays server side.
                      deckSwapPolicy: this.tournament.deckSwapPolicy || 'locked',
                      deckLocked: !!(
                          activePlayer &&
                          this.tournament.decks &&
                          this.tournament.decks[activePlayer]
                      )
                  }
                : undefined,
            useGameTimeLimit: this.useGameTimeLimit
        };
    }

    getStartGameDetails() {
        const players = {};

        for (let playerDetails of Object.values(this.players)) {
            const { name, user, ...rest } = playerDetails;
            players[name] = {
                name,
                user: user.getDetails(),
                ...rest
            };
        }

        const spectators = {};
        for (let spectatorDetails of Object.values(this.spectators)) {
            const { name, user, ...rest } = spectatorDetails;
            spectators[name] = {
                name,
                user: user.getDetails(),
                ...rest
            };
        }

        return {
            adaptive: this.adaptive,
            allowSpectators: this.allowSpectators,
            // ARCHON (F9): tells the game node which table this is (and the
            // node's driver its turn cap); the bot seat itself travels on its
            // player record as `isBot`.
            botGame: this.botGame || undefined,
            botMaxTurns: this.botMaxTurns,
            // ARCHON (F9): rides along so the node's own save state can carry
            // it back on GAMEWIN - the supervisor's only signal that a
            // showcase table finished and needs replacing.
            showcaseGame: this.showcaseGame || undefined,
            createdAt: this.createdAt,
            gameFormat: this.gameFormat,
            gamePrivate: this.gamePrivate,
            gameTimeLimit: this.gameTimeLimit,
            hideDeckLists: this.hideDeckLists,
            id: this.id,
            luckyDice: this.luckyDice,
            muteSpectators: this.muteSpectators,
            name: this.name,
            needsPassword: !!this.password,
            owner: this.owner.getDetails(),
            players,
            previousWinner: this.previousWinner,
            sasBound: this.sasBound,
            showHand: this.showHand,
            spectators,
            // ARCHON (N1): how long the node should hold the board back from
            // spectators. Resolved once, here, at hand-off - so a mid-game
            // settings change cannot retime a game that is already running.
            spectatorDelaySeconds:
                Number(settings.getSectionWithDefaults('watch').broadcastDelaySeconds) || 0,
            started: this.started,
            startingChains: this.startingChains,
            swap: this.swap,
            tournament: this.tournament,
            useGameTimeLimit: this.useGameTimeLimit
        };
    }
}

module.exports = PendingGame;
