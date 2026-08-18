const AllPlayerPrompt = require('./allplayerprompt');

/**
 * Shared base for two-player "ask the opponent to agree to X" prompts
 * (continue past a soft win, rematch, etc.). Subclasses customize the
 * prompt copy via the abstract hooks; the request/cancel/accept/decline
 * flow is handled here so a fix to it only needs to land in one place.
 *
 * @abstract
 */
class AgreementPrompt extends AllPlayerPrompt {
    /**
     * @param {{onAccept?: () => void, onCancel?: () => void}} [callbacks]
     */
    constructor(game, requestingPlayer, callbacks = {}) {
        super(game);

        this.requestingPlayer = requestingPlayer;
        this.completedPlayers = new Set([requestingPlayer]);
        this.cancelled = false;
        this.callbacks = callbacks;
    }

    completionCondition(player) {
        if (player.left) {
            if (!this.cancelled) {
                this.cancelled = true;
                this.callbacks.onCancel?.();
            }
            return true;
        }
        return this.cancelled || this.completedPlayers.has(player);
    }

    activeCondition(player) {
        // Keep the requesting player active so they can see a Back button to
        // cancel the request if they clicked the wrong option.
        if (this.cancelled) {
            return false;
        }
        return player === this.requestingPlayer || !this.completedPlayers.has(player);
    }

    activePrompt(player) {
        if (player === this.requestingPlayer) {
            return {
                menuTitle: this.getWaitingTitle(),
                buttons: [{ arg: 'back', text: 'Back' }]
            };
        }
        return {
            menuTitle: this.getRequestMenuTitle(),
            buttons: [
                { arg: 'yes', text: 'Yes' },
                { arg: 'no', text: 'No' }
            ]
        };
    }

    waitingPrompt() {
        return {
            menuTitle: this.getWaitingTitle()
        };
    }

    /**
     * ARCHON: `menuCommand`, not `onMenuCommand`.
     *
     * `UiPrompt.onMenuCommand` is where a click is checked against the uuid of
     * the prompt it was drawn for, and this class used to override it - so the
     * check never ran, and this prompt answered clicks meant for the prompt
     * BEFORE it. That is not a rare case: the rematch request is raised from
     * the Game Won menu, and the opponent is looking at that menu, with its
     * four buttons, at the instant the request replaces it. Both players
     * reaching for "Rematch" at the same time is the normal way two people who
     * both want a rematch behave.
     *
     * What happened then was the worst available reading. The old code treated
     * anything that was not 'back' or 'yes' as a decline, so the opponent's
     * click on "Rematch: Same Decks" - a click asking FOR a rematch - was
     * taken as refusing one, and both players were dropped back to the menu
     * with no explanation. A second click on the button you had just pressed
     * cancelled your own request the same way.
     *
     * Going through `menuCommand` means a click for a prompt that is no longer
     * on screen is simply ignored, and the player sees the Yes/No they were
     * being shown all along.
     */
    menuCommand(player, arg) {
        if (arg === 'back') {
            // Only the player who asked can withdraw the question.
            if (player !== this.requestingPlayer) {
                return false;
            }

            this.addCancelAlert(player);
            this.cancelled = true;
            this.callbacks.onCancel?.();

            return true;
        }

        // The requester is shown Back and nothing else; an answer from them is
        // not an answer. Accepting one would let the request complete without
        // the opponent ever agreeing to it.
        if (player === this.requestingPlayer) {
            return false;
        }

        if (arg === 'yes') {
            this.addAcceptAlert(player);
            this.completedPlayers.add(player);
            this.callbacks.onAccept?.();

            return true;
        }

        if (arg === 'no') {
            this.addDeclineAlert(player);
            this.cancelled = true;
            this.callbacks.onCancel?.();

            return true;
        }

        // Not one of this prompt's buttons. Leave the request standing rather
        // than inventing an answer for it.
        return false;
    }

    /* --- abstract hooks --- */

    /** Title shown to the requester while waiting, and in waitingPrompt(). */
    getWaitingTitle() {
        throw new Error('getWaitingTitle() not implemented');
    }

    /** menuTitle object presented to the opponent being asked. */
    getRequestMenuTitle() {
        throw new Error('getRequestMenuTitle() not implemented');
    }

    /** Alert when the requester clicks Back. */
    addCancelAlert() {
        throw new Error('addCancelAlert() not implemented');
    }

    /** Alert when the opponent agrees. */
    addAcceptAlert() {
        throw new Error('addAcceptAlert() not implemented');
    }

    /** Alert when the opponent declines. */
    addDeclineAlert() {
        throw new Error('addDeclineAlert() not implemented');
    }
}

module.exports = AgreementPrompt;
