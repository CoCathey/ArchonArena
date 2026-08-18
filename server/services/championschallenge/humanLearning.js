const logger = require('../../log');
const { sectionDefaults } = require('../settings/registry');

/**
 * ARCHON (N45): whether the bot may learn from the people it plays, and how
 * hard those lessons pull.
 *
 * Read in two places that must agree - the lobby, deciding whether a table
 * captures at all, and the trainer, deciding what a captured row is worth -
 * so the reading lives here rather than being spelled out twice.
 *
 * ## Why a mode rather than a switch
 *
 * A practice table is the obvious place to learn: the human is deliberately
 * playing the bot, the bot is already the other seat, and nothing about the
 * game is a contest between people. Ordinary tables between two humans are
 * the BETTER data - two people trying to win produce sharper play than
 * anything the lab generates - and are also the ones somebody might
 * reasonably not want harvested. So they are separate settings rather than
 * one, and the default takes only the practice games, which is what was
 * asked for.
 *
 * Nothing captured identifies anybody. A row is the feature vector of a
 * position and the move taken from it - the same shape the lab's own
 * sparring writes - with no player, deck or game id attached. What survives
 * training is a number in a weight table.
 */

const MODES = {
    /** Learn from nobody. */
    OFF: 'off',
    /** Learn from the human seat at a practice table. The default. */
    BOT: 'bot',
    /** Learn from every human seat, practice tables and ordinary games alike. */
    ALL: 'all'
};

/**
 * The setting, composed over the registry defaults the way
 * getSectionWithDefaults does - so a stubbed settings service in a spec, or a
 * database that has never been written to, reads as the defaults rather than
 * as an error.
 *
 * @returns {{mode: string, weight: number}}
 */
function humanLearningConfig(settingsService = require('../settings')) {
    const fallback = sectionDefaults('championsChallenge');
    let section = fallback;

    try {
        section = {
            ...fallback,
            ...((settingsService &&
                settingsService.getSection &&
                settingsService.getSection('championsChallenge')) ||
                {})
        };
    } catch (err) {
        logger.error('Challenge bot: could not read the human learning setting', err);
    }

    const mode = Object.values(MODES).includes(section.humanLearning)
        ? section.humanLearning
        : fallback.humanLearning;
    const weight = Number(section.humanGameWeight);

    return {
        mode,
        // A negative pull would train the bot to play WORSE, so the floor is
        // zero - which is "captured, and worth nothing", the honest way to
        // park the rows without losing them.
        weight: Number.isFinite(weight) && weight >= 0 ? weight : fallback.humanGameWeight
    };
}

/**
 * Whether this table's human seats should be captured.
 *
 * @param {string} mode
 * @param {{botGame?: boolean}} table
 */
function learnsFromTable(mode, { botGame } = {}) {
    if (mode === MODES.ALL) {
        return true;
    }

    return mode === MODES.BOT && !!botGame;
}

module.exports = {
    MODES,
    humanLearningConfig,
    learnsFromTable
};
