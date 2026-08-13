const AgreementPrompt = require('./AgreementPrompt');

/**
 * ARCHON: "play the next game of this match", asked at the table you are
 * already sitting at.
 *
 * The event opens the next game of a series itself the moment a result is
 * recorded, so the table has always existed - but reaching it meant leaving the
 * game, finding the event page, and finding the right table among the ones the
 * match had already used. Reported from a live best-of-three, where what the
 * two players wanted was a button, and what they found was a rematch offer that
 * led nowhere.
 *
 * An agreement rather than a single click, for the same reason a rematch is
 * one: the other player is a person who may not be ready to start again the
 * second the last game ended. Declining costs nothing - the next table is still
 * there, and either of them can walk to it whenever they like.
 */
class NextTournamentGamePrompt extends AgreementPrompt {
    constructor(game, requestingPlayer, callbacks = {}) {
        super(game, requestingPlayer, callbacks);

        this.gameNumber = (game.tournament && game.tournament.gameNumber) || 1;
        this.nextGameNumber = this.gameNumber + 1;
    }

    getWaitingTitle() {
        return `Waiting for your opponent to start game ${this.nextGameNumber}`;
    }

    getRequestMenuTitle() {
        return {
            text: '{{player}} wants to start game {{game}} of your match now. Ready?',
            values: { player: this.requestingPlayer.name, game: this.nextGameNumber }
        };
    }

    addCancelAlert(player) {
        this.game.addAlert('info', '{0} is not ready to start the next game yet', player);
    }

    addAcceptAlert(player) {
        this.game.addAlert('info', '{0} is ready - starting the next game of this match', player);
    }

    addDeclineAlert(player) {
        this.game.addAlert(
            'info',
            '{0} is not ready yet. Your next table is waiting on the event page whenever you both are.',
            player
        );
    }

    onCompleted() {
        if (this.cancelled) {
            return;
        }

        this.game.addAlert(
            'info',
            'Starting game {0} of this match - the same table, the same decks',
            this.nextGameNumber
        );
        this.game.nextTournamentGame();
    }
}

module.exports = NextTournamentGamePrompt;
