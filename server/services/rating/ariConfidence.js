/**
 * ARCHON (N34): how much a deck's ARI is allowed to move, and how sure the
 * platform is of it.
 *
 * ARI's update was already comparative - Elo against the opponent's ARI, so
 * beating a stronger deck moves more than beating a weaker one. What it was
 * not was CONFIDENT: a deck three games in moved exactly as fast as one three
 * hundred games in, which is wrong in both directions at once. The new deck's
 * number stayed pinned near its card-math seed when the results were shouting
 * that the seed was wrong, and the established deck's number twitched at every
 * result when it had already earned the right to be stable.
 *
 * The fix is the oldest one in rating: move a provisional rating quickly and a
 * settled one slowly. This module is that rule, kept apart from AriService so
 * the arithmetic can be read and tested without a database.
 *
 * WHAT THIS IS NOT. It is not Glicko-2. There is no volatility term, no rating
 * period, no iterative solve - a deviation here is a plain function of how much
 * evidence a deck has and how long ago it earned it, not a posterior. It is
 * called a deviation because that is what it approximates and what it is used
 * for: scaling the step, and telling a player when a number is still settling.
 * Anything that needs a real confidence interval should not read this.
 *
 * Three properties the specs pin, because each one is a way this could go
 * quietly wrong:
 *
 *  - **A settled deck moves at exactly the configured K.** The multiplier
 *    decays TO one, never below it, so an operator's tuning of `gameK` keeps
 *    meaning what it meant before this existed.
 *  - **Sparring counts for less than real play.** A bot's opinion is evidence,
 *    but it is not the same evidence, and a deck cannot be made "established"
 *    by the lab grinding sparring games against it overnight.
 *  - **Certainty decays.** A deck rated in one meta and shelved for a year is
 *    not still known to that precision, so idle time gives deviation back -
 *    bounded, so a deck can never become less certain than an unrated one.
 */

/** The deviation a deck starts with: SAS is an estimate, not a measurement. */
const SEED_DEVIATION = 12;

/** The most certain a deck can ever be. Never zero: decks are not solved. */
const MIN_DEVIATION = 2.5;

/** Below this deviation a deck is no longer flagged as still settling. */
const PROVISIONAL_DEVIATION = 7;

/** Defaults for the knobs, mirrored in the settings registry. */
const DEFAULTS = {
    // Games of evidence at which deviation has closed half the distance from
    // the seed to the floor. Chosen so a deck that plays a normal week of
    // sparring stops being provisional, not so it settles in an evening.
    settlingGames: 30,
    // What one sparring game is worth against one rated game. The lab plays
    // hundreds of games a night; without this an overnight sweep would settle
    // a rating that no human had tested once.
    simGameWeight: 0.25,
    // Days of inactivity that give back one seed-to-floor step of deviation.
    // A year off should visibly loosen a rating; a fortnight should not.
    stalenessDays: 240
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * How much a deck's record is worth, in rated-game equivalents.
 *
 * @param {{ratedGames?: number, simGames?: number}} record
 * @param {object} [options] settings overrides
 * @returns {number}
 */
function evidenceOf(record, options = {}) {
    const simWeight = numberOr(options.simGameWeight, DEFAULTS.simGameWeight);
    const rated = Math.max(0, Number(record && record.ratedGames) || 0);
    const sim = Math.max(0, Number(record && record.simGames) || 0);

    return rated + sim * clamp(simWeight, 0, 1);
}

/**
 * How uncertain this deck's ARI is, on the ARI (SAS) scale.
 *
 * Hyperbolic in evidence rather than exponential: the first handful of games
 * should move a deck a long way and the hundredth should barely matter, and a
 * hyperbola has that shape without ever quite claiming certainty.
 *
 * @param {{ratedGames?: number, simGames?: number, lastGameAt?: Date|string|null}} record
 * @param {object} [options] settings overrides, plus `now` for tests
 * @returns {number} deviation, between MIN_DEVIATION and SEED_DEVIATION
 */
function deviationFor(record, options = {}) {
    const settling = Math.max(1, numberOr(options.settlingGames, DEFAULTS.settlingGames));
    const evidence = evidenceOf(record, options);
    const span = SEED_DEVIATION - MIN_DEVIATION;
    const settled = MIN_DEVIATION + span * (settling / (settling + evidence));

    return clamp(settled + stalenessOf(record, options) * span, MIN_DEVIATION, SEED_DEVIATION);
}

/**
 * How much of the seed-to-floor span idleness has given back, 0..1.
 *
 * Deliberately not applied to a deck that has never played: an unrated deck is
 * already at the seed deviation and cannot become less certain than unknown.
 */
function stalenessOf(record, options = {}) {
    const days = Math.max(1, numberOr(options.stalenessDays, DEFAULTS.stalenessDays));
    const last = record && record.lastGameAt ? new Date(record.lastGameAt) : null;

    if (!last || Number.isNaN(last.getTime())) {
        return 0;
    }

    const now = options.now ? new Date(options.now) : new Date();
    const idleDays = (now.getTime() - last.getTime()) / 86400000;

    return clamp(idleDays / days, 0, 1);
}

/**
 * What to multiply the configured K by for this deck. One for a settled deck,
 * up to SEED_DEVIATION/MIN_DEVIATION for one that has never played.
 *
 * @param {{ratedGames?: number, simGames?: number, lastGameAt?: Date|string|null}} record
 * @param {object} [options]
 * @returns {number} >= 1
 */
function kMultiplier(record, options = {}) {
    return deviationFor(record, options) / MIN_DEVIATION;
}

/**
 * Everything a reader needs about how firm a deck's rating is.
 *
 * @param {{ratedGames?: number, simGames?: number, lastGameAt?: Date|string|null}} record
 * @param {object} [options]
 * @returns {{deviation: number, provisional: boolean, evidence: number, kMultiplier: number}}
 */
function confidenceOf(record, options = {}) {
    const deviation = deviationFor(record, options);

    return {
        deviation: Math.round(deviation * 100) / 100,
        // The word a player sees. "Provisional" is a promise that the number
        // will move, which is more useful than a game count they have to
        // interpret against a threshold they were never told.
        provisional: deviation > PROVISIONAL_DEVIATION,
        evidence: Math.round(evidenceOf(record, options) * 100) / 100,
        kMultiplier: Math.round((deviation / MIN_DEVIATION) * 1000) / 1000
    };
}

function numberOr(value, fallback) {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
    evidenceOf,
    deviationFor,
    kMultiplier,
    confidenceOf,
    SEED_DEVIATION,
    MIN_DEVIATION,
    PROVISIONAL_DEVIATION,
    DEFAULTS
};
