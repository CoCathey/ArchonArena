/**
 * ARCHON (N52): make a fork forget what it is not allowed to know.
 *
 * A fork (N51) is an exact copy of the position, and exactness is the problem.
 * The engine deals its decks at setup, so an exact copy holds the real
 * remaining deck IN ITS REAL ORDER - and a planner that rolls that copy
 * forward is not planning, it is reading the answers. It would call the house
 * whose cards it happens to be about to draw, and it would look brilliant
 * doing it, right up until it met a game where it could not see.
 *
 * That is not a small effect. The end of every turn draws the hand back up, so
 * a one-turn search reaches the next three or four cards of its own deck on
 * every line it considers.
 *
 * The rule this restores is the one `labFeatures` already states for the
 * model's own inputs: the bot may read what a seated player could read - its
 * own hand, both boards, both amber pools, pile SIZES, and the COMPOSITION of
 * what is left in its own deck - and never a deck's ORDER, and never the
 * opponent's hand. So before a fork is searched, everything the deciding seat
 * cannot see is shuffled into a plausible arrangement consistent with
 * everything it can.
 *
 * ## What is actually hidden, and why the arithmetic is free
 *
 * KeyForge is unusually kind here. A deck is a published 36-card list, so the
 * opponent's remaining cards are not a mystery - only their ARRANGEMENT is.
 * Their play area, discard and purged pile are all face up, so whatever is not
 * in them is distributed among their hand, deck and archives in some order
 * nobody can see.
 *
 * A fork already holds exactly that multiset in exactly those three zones. So
 * a plausible world is one shuffle: pool the three, shuffle, deal back to the
 * same counts. Nothing has to be derived from the decklist, and the result
 * cannot be inconsistent with anything visible, because the visible zones are
 * never touched.
 *
 * The deciding seat gets its own deck shuffled and nothing else - its hand and
 * archives are cards it put there and is entitled to remember.
 *
 * ## One world is not a plan
 *
 * A single determinized world is one deal, and a line that wins in one deal
 * may win because of the deal. So a caller samples several and averages - and
 * uses the SAME worlds for every candidate it is comparing, which is the same
 * common-random-numbers trick DeepGame applies to its rollouts: sharing the
 * futures cancels the deal out of the comparison entirely, for free.
 */

/** The three zones a seat's opponent cannot see into. */
const HIDDEN_ZONES = ['hand', 'deck', 'archives'];

/**
 * Shuffle a list with the caller's own randomness.
 *
 * Deliberately NOT `secureRandom.shuffle`: a planner has to be able to hand
 * out one specific world by seed and get it back again, and a source scoped by
 * async context is the wrong shape for that. Fisher-Yates, so every
 * arrangement is equally likely - a biased shuffle here would be a planner
 * quietly preferring the futures the bias favours.
 */
function shuffled(cards, rng) {
    const result = [...cards];

    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));

        [result[i], result[j]] = [result[j], result[i]];
    }

    return result;
}

/**
 * Re-deal everything the deciding seat cannot see.
 *
 * Mutates the fork in place - it is a copy, and copying it again to shuffle it
 * would be the expensive half of the work done twice.
 *
 * @param {object} game a forked game (never a live one)
 * @param {object} seat the player whose knowledge is being respected
 * @param {function} rng () => [0, 1)
 * @returns {object} the same game
 */
function determinize(game, seat, rng) {
    // The deciding seat: its own deck's ORDER is the only thing it does not
    // know about itself. Composition it knows - it built the deck and has
    // watched its own cards leave it - and its hand and archives are its own.
    seat.deck = shuffled(seat.deck, rng);

    const opponent = seat.opponent;

    if (!opponent) {
        return game;
    }

    // The opponent's hidden three, pooled and re-dealt to the same counts.
    // Counts are what the seat can see (a hand is a number of cards held, an
    // archive pile has a size), so they are preserved exactly; which card is
    // where is what it cannot see, so that is what is re-rolled.
    const counts = HIDDEN_ZONES.map((zone) => (opponent[zone] || []).length);
    const pool = shuffled(
        HIDDEN_ZONES.flatMap((zone) => opponent[zone] || []),
        rng
    );

    let taken = 0;

    HIDDEN_ZONES.forEach((zone, index) => {
        const dealt = pool.slice(taken, taken + counts[index]);

        taken += counts[index];
        opponent[zone] = dealt;

        for (const card of dealt) {
            // `moveTo` rather than assigning `location`, because a card's
            // ability events are registered per location: a card that moved
            // from the deck to the hand in this world has to be listening the
            // way a card in hand listens, or the world plays by rules the real
            // game does not have.
            if (card.location !== zone) {
                card.moveTo(zone);
            }
        }
    });

    return game;
}

module.exports = { HIDDEN_ZONES, determinize, shuffled };
