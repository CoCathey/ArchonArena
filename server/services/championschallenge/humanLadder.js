/**
 * ARCHON (N50): the rung that is a person.
 *
 * The calibration ladder (N39) measures the champion against opponents that
 * never learn - the plain bot, the three personas, the searching bot - and
 * that fixity is the whole point: a ladder whose rungs move measures nothing.
 *
 * It also means the ladder tops out at the lab's own ceiling. Every rung is
 * something the lab built, so the highest praise available is "as good as the
 * best bot we can make", and the question anybody actually asks about a game
 * bot - can it beat a person - was not on the page at all. It could not be
 * answered from anywhere else either: practice games are deliberately never
 * results (F9), so they touch no win rate, no rating and no statistic on this
 * site. A bot that had never once beaten a human being would look identical,
 * from every number the lab publishes, to one that always did.
 *
 * So the games already being played against people are counted. Not as a rung
 * on the fixed ladder - people learn, vary, and have evenings, which is the
 * exact opposite of a ruler - but as its own record, kept in the same table
 * and read with the same intervals.
 *
 * ## Why the band matters more than the average
 *
 * "The bot beats people 55% of the time" is a number about the site's
 * population, not about the bot. A site whose practice tables are mostly
 * joined by first-week players would report a strong bot for as long as it
 * kept beating first-week players, and the report would go on being true and
 * go on meaning nothing. Split by how strong the opponent is and the shape
 * shows: beats the newcomers, holds the middle, loses to the good ones - which
 * is the sentence that says what to work on.
 *
 * The thresholds are the RATING ENGINE'S OWN (`provisionalGames`,
 * `highRatingThreshold`), not numbers invented here. Those are the points the
 * platform already treats as meaningful about a player, and a second opinion
 * about where "strong" starts is a second thing to keep in step.
 */

/** The overall record: every practice game against a person. */
const HUMAN_OVERALL = 'human';

/** Band keys are stored as `human:<band>`, one row each. */
const HUMAN_PREFIX = 'human:';

/**
 * The bands, weakest first - which is also the order they read on the page.
 *
 * `key` is the storage identity and therefore a contract: a band renamed is a
 * band whose history is orphaned, exactly as with the ladder's own rung keys.
 * Add, don't rename.
 */
const HUMAN_BANDS = [
    {
        key: 'provisional',
        label: 'Still finding their level',
        note: 'fewer rated games than the engine calls established'
    },
    {
        key: 'established',
        label: 'Established players',
        note: 'rated, below the engine’s high-rating mark'
    },
    {
        key: 'strong',
        label: 'Strong players',
        note: 'at or above the engine’s high-rating mark'
    }
];

/**
 * Which band a seat belongs to.
 *
 * A player with no rating row at all is provisional, not unrated-and-excluded:
 * they played the game, the bot won or lost it, and dropping the result would
 * quietly make the record a record of rated players only - which on a young
 * site is almost nobody.
 *
 * @param {{rating: number, gamesPlayed: number}|null} standing
 * @param {{provisionalGames: number, highRatingThreshold: number}} eloConfig
 * @returns {string} one of HUMAN_BANDS' keys
 */
function bandFor(standing, eloConfig = {}) {
    const provisionalGames = Number.isFinite(eloConfig.provisionalGames)
        ? eloConfig.provisionalGames
        : 10;
    const highRating = Number.isFinite(eloConfig.highRatingThreshold)
        ? eloConfig.highRatingThreshold
        : 2100;

    if (!standing || !Number.isFinite(standing.gamesPlayed) || !Number.isFinite(standing.rating)) {
        return 'provisional';
    }

    if (standing.gamesPlayed < provisionalGames) {
        return 'provisional';
    }

    return standing.rating >= highRating ? 'strong' : 'established';
}

/**
 * The calibration keys one finished game writes.
 *
 * Two rows, deliberately: the overall record answers "can it beat people", the
 * band answers "which people". Summing the bands would give the overall back,
 * but only for as long as nobody ever adds a band - and the day somebody does,
 * every historic row would be missing from the new split. The total is kept
 * because it is the number that must never be wrong.
 *
 * @param {string} band
 * @returns {string[]}
 */
function calibrationKeys(band) {
    return [HUMAN_OVERALL, `${HUMAN_PREFIX}${band}`];
}

/** Is this calibration row part of the human record rather than the ladder? */
function isHumanKey(key) {
    return key === HUMAN_OVERALL || (typeof key === 'string' && key.startsWith(HUMAN_PREFIX));
}

/**
 * ARCHON (N50): which finished games count.
 *
 * A concession and an abandonment are thrown away, matching what N48 already
 * decided for the training diary - and it matters more here, because the
 * practice bot CONCEDES ITSELF past its interaction and turn caps
 * (gamenode/botdriver.js). Counting those would file the bot's own wedges as
 * wins for whoever was sitting across from it, and a bot that got worse at
 * finishing games would show up on this page as people getting better at
 * beating it.
 *
 * Games decided by the engine - a third key, or any of the timeout rules -
 * are the ones that measure play.
 *
 * @param {string} reason the win reason from Game.recordWinner
 */
function countsTowardLadder(reason) {
    return reason !== 'concede' && reason !== 'abandoned';
}

module.exports = {
    HUMAN_OVERALL,
    HUMAN_PREFIX,
    HUMAN_BANDS,
    bandFor,
    calibrationKeys,
    isHumanKey,
    countsTowardLadder
};
