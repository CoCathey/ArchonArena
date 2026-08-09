const _ = require('underscore');
const UiPrompt = require('./uiprompt.js');

/**
 * General purpose menu prompt. By specifying a context object, the buttons in
 * the active prompt can call the corresponding method on the context object.
 * Methods on the context object should return true in order to complete the
 * prompt.
 *
 * The properties option object may contain the following:
 * activePrompt       - the full prompt to display for the prompted player.
 * waitingPromptTitle - the title to display for opponents.
 * source             - what is at the origin of the user prompt, usually a card;
 *                      used to provide a default waitingPromptTitle, if missing
 */
class MenuPrompt extends UiPrompt {
    constructor(game, player, context, properties) {
        super(game);
        this.player = player;
        this.context = context;
        if (properties.source && !properties.waitingPromptTitle) {
            properties.waitingPromptTitle = 'Waiting for opponent';
        }

        this.properties = properties;
    }

    activeCondition(player) {
        return player === this.player;
    }

    activePrompt() {
        let promptTitle =
            this.properties.promptTitle ||
            (this.properties.source ? this.properties.source.name : undefined);
        let activePrompt = _.extend({ promptTitle: promptTitle }, this.properties.activePrompt);

        // Let the client attribute this prompt to the card that raised it,
        // even for control types (card-name, trait-name) that don't already
        // carry a source of their own.
        let source = this.properties.source;
        if (
            source &&
            typeof source !== 'string' &&
            source.type &&
            Array.isArray(activePrompt.controls)
        ) {
            let sourceSummary = source.getShortSummary();
            activePrompt.controls = activePrompt.controls.map((control) =>
                control.source ? control : _.extend({ source: sourceSummary }, control)
            );
        }

        return activePrompt;
    }

    waitingPrompt() {
        return { menuTitle: this.properties.waitingPromptTitle || 'Waiting for opponent' };
    }

    menuCommand(player, arg, method) {
        if (!this.context[method] || !this.hasMethodButtonOrControl(method)) {
            return false;
        }

        if (this.context[method](this.properties.activePrompt.context, player, arg, method)) {
            this.complete();
        }

        return true;
    }

    hasMethodButtonOrControl(method) {
        return (
            _.any(this.properties.activePrompt.buttons, (button) => button.method === method) ||
            this.properties.activePrompt.controls.some((control) => control.method === method)
        );
    }
}

module.exports = MenuPrompt;
