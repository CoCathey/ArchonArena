const AllPlayerPrompt = require('./allplayerprompt');
const ContinuePrompt = require('./ContinuePrompt');
const RematchPrompt = require('./RematchPrompt');

const ButtonArgToMode = {
    'rematch-same-decks': 'same',
    'rematch-swap-decks': 'swap',
    'rematch-change-decks': 'change'
};

const ButtonArgToRequest = {
    continue: 'to continue',
    'rematch-same-decks': 'a rematch with the same decks',
    'rematch-swap-decks': 'a rematch with swapped decks',
    'rematch-change-decks': 'a rematch with different decks'
};

class GameWonPrompt extends AllPlayerPrompt {
    constructor(game, winner) {
        super(game);
        this.winner = winner;
        this.clickedButton = {};
    }

    completionCondition(player) {
        // A player who has left the game can't dismiss the post-game prompt,
        // so auto-complete it for them — otherwise the prompt would hang and
        // the opponent would be stuck on the "Waiting for opponent" screen.
        if (player.left) {
            return true;
        }
        return !!this.clickedButton[player.name];
    }

    /**
     * What a tournament player should do when this game ends.
     *
     * Deliberately derived from what the TABLE knows - its game number and the
     * series length - rather than from the match score, which lives in the
     * database and is not on this node. That makes it right about the only
     * thing it claims: whether more games are possible in this series. A series
     * that ends early (2-0 in a best of three) sends them back to the event
     * page, which is where they were going anyway.
     */
    whatHappensNext() {
        const { gameNumber, bestOf } = this.game.tournament || {};

        if (!bestOf || bestOf < 2) {
            return 'Leave the game to report back to the event - the result is already recorded.';
        }

        if (gameNumber && gameNumber >= bestOf) {
            return 'That is the last game of the series. Leave the game to see the result on the event page.';
        }

        return (
            'The result is recorded. Leave this game and your next table in this match is ' +
            'waiting on the event page - you do not need to report anything.'
        );
    }

    activePrompt(player) {
        const opponentLeft = this.game.getPlayers().some((other) => other !== player && other.left);
        const isAdaptive = this.game.gameFormat === 'adaptive-bo1';

        /**
         * ARCHON: a tournament table offers no rematch, because there is none.
         *
         * A rematch builds a fresh pending game carrying none of the event -
         * no match id, so its result could never be reported, and no deck pin,
         * so both players would get a free choice in an event that had locked
         * them. The lobby refuses to build it for exactly that reason, and the
         * chat command refuses too.
         *
         * This prompt did not. So the end of every tournament game offered
         * three rematch buttons, both players could agree to one, and then
         * nothing happened at all - the request reached a handler whose whole
         * body is a warning in a log. Reported from a live best-of-three, where
         * what the two players actually needed was game two, which the event
         * had already opened for them and nothing on this screen mentioned.
         */
        if (this.game.tournament) {
            return {
                promptTitle: 'Game Won',
                // Says what happens next, because at a tournament table
                // something does and it is not on this screen. The event opens
                // the next game of a series itself the moment this result is
                // recorded; all either player has to do is leave.
                menuTitle: {
                    text: '{{player}} has won the game! {{next}}',
                    values: { player: this.winner.name, next: this.whatHappensNext() }
                },
                buttons: [{ arg: 'continue', text: 'Continue Playing' }]
            };
        }

        // Show rematch options even when the opponent has left, but disable
        // them — a rematch requires both players to respond, so it can't
        // proceed without them. Continue Playing remains available so the
        // remaining player can dismiss the prompt.
        const buttons = [
            { arg: 'continue', text: 'Continue Playing' },
            { arg: 'rematch-same-decks', text: 'Rematch: Same Decks', disabled: opponentLeft }
        ];
        // Adaptive has its own deck-swap mechanic built into setup
        if (!isAdaptive) {
            buttons.push({
                arg: 'rematch-swap-decks',
                text: 'Rematch: Trade Decks',
                disabled: opponentLeft
            });
        }
        buttons.push({
            arg: 'rematch-change-decks',
            text: 'Rematch: Pick New Decks',
            disabled: opponentLeft
        });

        return {
            promptTitle: 'Game Won',
            menuTitle: {
                text: '{{player}} has won the game!',
                values: { player: this.winner.name }
            },
            buttons
        };
    }

    menuCommand(player, arg) {
        const description = ButtonArgToRequest[arg];
        if (!description) {
            return true;
        }

        this.game.addMessage('{0} would like {1}', player, description);
        this.clickedButton[player.name] = true;

        const callbacks = {
            // If the opponent agrees, the entire Game Won prompt is done.
            onAccept: () => {
                if (arg === 'continue') {
                    // Mark the game so a subsequent concede re-opens this menu.
                    this.game.continuePlaying = true;
                }
                for (const p of this.game.getPlayers()) {
                    this.clickedButton[p.name] = true;
                }
            },
            // If the opponent declines, reset the Game Won prompt so both
            // players see the full continue/rematch menu again.
            onCancel: () => {
                this.clickedButton = {};
            }
        };

        if (arg === 'continue') {
            this.game.queueStep(new ContinuePrompt(this.game, player, callbacks));
        } else {
            this.game.queueStep(
                new RematchPrompt(this.game, player, ButtonArgToMode[arg], callbacks)
            );
        }

        return true;
    }
}

module.exports = GameWonPrompt;
