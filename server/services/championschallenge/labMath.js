const { expectedScore } = require('../rating/EloCalculator');

/**
 * ARCHON (N18): the arithmetic of the Champion’s Challenge, kept pure.
 *
 * Everything here is a function of its arguments - no IO, no clock - so the
 * claims the lab makes ("this deck is a hidden gem", "plays like SAS 74")
 * can be pinned by unit tests instead of trusted. The service does the
 * fetching; this file does the deciding.
 */

/** Games before the lab lets itself draw a conclusion about a deck. */
const MIN_CONFIDENT_GAMES = 20;

/** Games on one opening house before it is called that deck's best opening. */
const MIN_OPENING_GAMES = 5;

/**
 * ARCHON (N28): games under one of the three sparring pilots before that
 * pilot's verdict on a deck is worth comparing to the others.
 *
 * The comparison is the whole value of playing three pilots - "wins under the
 * Racer, loses under the Bruiser" is a fact about the deck - and comparing two
 * five-game records produces that sentence out of noise about half the time.
 * Lower than MIN_CONFIDENT_GAMES because each pilot only ever gets a third of a
 * deck's games, and a threshold a deck can never reach reports nothing forever.
 */
const MIN_STYLE_GAMES = 10;

/**
 * Lower bound of the 95% Wilson score interval for a win rate.
 *
 * The hidden-gem rule uses the LOWER bound rather than the observed rate on
 * purpose: "consistently outperforming its stats" is a claim about the true
 * rate, and a lucky 6-2 start should not earn a badge that a 40-game record
 * has to earn. Wilson rather than normal approximation because lab samples
 * are exactly the small-n regime the normal interval is bad at.
 *
 * @param {number} wins
 * @param {number} games
 * @param {number} [z] 1.96 = 95%
 * @returns {number} in [0, 1]; 0 when there are no games
 */
function wilsonLowerBound(wins, games, z = 1.96) {
    if (!games || games <= 0) {
        return 0;
    }

    const p = wins / games;
    const z2 = z * z;
    const centre = p + z2 / (2 * games);
    const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * games)) / games);

    return Math.max(0, (centre - spread) / (1 + z2 / games));
}

/**
 * ARCHON (N26): the whole 95% Wilson interval, not just its floor.
 *
 * A win rate printed as "62%" tells a member nothing about whether to believe
 * it, and the two decks in a roster whose records are 5-3 and 300-180 both print
 * the same headline. The interval is the honest form of the same number: it says
 * 62% and it says how far that could be wrong.
 *
 * @returns {{low: number, high: number, rate: number|null}}
 */
function wilsonInterval(wins, games, z = 1.96) {
    if (!games || games <= 0) {
        return { low: 0, high: 1, rate: null };
    }

    const p = wins / games;
    const z2 = z * z;
    const centre = p + z2 / (2 * games);
    const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * games)) / games);
    const denominator = 1 + z2 / games;

    return {
        rate: p,
        low: Math.max(0, (centre - spread) / denominator),
        high: Math.min(1, (centre + spread) / denominator)
    };
}

/**
 * ARCHON (N25): the sequential probability ratio test - "have we seen enough?"
 *
 * A fixed-N test has to decide its sample size before it knows anything, so it
 * spends the same 400 games on a candidate that is plainly stronger as on one
 * that is a coin flip. Wald's test instead accumulates the log-likelihood ratio
 * of two hypotheses and stops the moment the evidence crosses a bound in EITHER
 * direction - which is why engine-testing frameworks (fishtest and its
 * descendants) run on it. Here it means a clearly better bot takes the title in
 * tens of games instead of hundreds, a clearly worse one retires just as fast,
 * and only genuinely borderline candidates cost the full window.
 *
 * H0: the candidate is no better than the champion (`p0`, an even split).
 * H1: it is better by a margin worth having (`p1`).
 *
 * `p1` is the design decision here, and 0.60 is deliberate. Chess frameworks
 * test hypotheses a couple of Elo apart, because engines a decade into
 * refinement differ by that much - and they pay for it in tens of thousands of
 * games. A candidate here has just been trained on a fresh diary and is either
 * meaningfully better or not worth crowning, so the test is asked to prove a
 * meaningful edge: at 0.60 a 73% record over fifty games takes the title, where
 * proving "better than 55%" would still be waiting at game 150.
 *
 * The cost of a wide margin is honest and small: a candidate that is genuinely
 * but only slightly better retires as unproven. It is not lost - the diary keeps
 * growing and its successor is trained from more evidence - and the alternative
 * is spending hundreds of games per candidate to bank a fraction of a percent.
 *
 * Errors are bounded by construction, not by sample size: `alpha` is the chance
 * of crowning a candidate that is not better, `beta` the chance of retiring one
 * that is.
 *
 * @param {number} wins candidate wins
 * @param {number} losses candidate losses
 * @param {object} [options]
 * @returns {{llr: number, lower: number, upper: number,
 *           verdict: 'better'|'no-better'|'unproven'}}
 */
function sprt(wins, losses, { p0 = 0.5, p1 = 0.6, alpha = 0.05, beta = 0.05 } = {}) {
    // Each win multiplies the odds by p1/p0, each loss by (1-p1)/(1-p0); in log
    // space that is a running sum, which is what makes the test sequential.
    const llr = (wins || 0) * Math.log(p1 / p0) + (losses || 0) * Math.log((1 - p1) / (1 - p0));
    const lower = Math.log(beta / (1 - alpha));
    const upper = Math.log((1 - beta) / alpha);

    return {
        llr,
        lower,
        upper,
        verdict: llr >= upper ? 'better' : llr <= lower ? 'no-better' : 'unproven'
    };
}

/**
 * What SAS says this game should have been: the site's own rating model
 * (EloCalculator.expectedScore) evaluated with equal ratings, so the SAS
 * handicap term is the only input. With the default sasWeight of 4, 25
 * points of SAS is worth 100 Elo - the same exchange rate the Amber ladder
 * applies to real games.
 *
 * @param {number} sasSelf
 * @param {number} sasOpponent
 * @param {object} eloConfig a normalized elo config (needs `.sasWeight`)
 * @returns {number} P(win) in (0, 1)
 */
function sasExpectedScore(sasSelf, sasOpponent, eloConfig) {
    return expectedScore(0, 0, sasSelf - sasOpponent, eloConfig);
}

/**
 * Is this deck a hidden gem?
 *
 * The claim being made: with statistical confidence, the deck's true win
 * rate in the lab exceeds what SAS predicted for the games it played. Both
 * halves matter - enough games to mean anything, and the WHOLE confidence
 * interval clear of the expectation, not just the point estimate.
 *
 * @param {{games: number, wins: number, expectedWinRate: number|null}} deck
 * @returns {boolean}
 */
function isHiddenGem(deck) {
    if (!deck || deck.games < MIN_CONFIDENT_GAMES || deck.expectedWinRate == null) {
        return false;
    }

    return wilsonLowerBound(deck.wins, deck.games) > deck.expectedWinRate;
}

/** House display names, matching the Houses seed data. */
const HOUSE_NAMES = {
    brobnar: 'Brobnar',
    dis: 'Dis',
    ekwidon: 'Ekwidon',
    geistoid: 'Geistoid',
    logos: 'Logos',
    mars: 'Mars',
    ouboros: 'Ouboros',
    redemption: 'Redemption',
    sanctum: 'Sanctum',
    saurian: 'Saurian',
    shadows: 'Shadows',
    skyborn: 'Skyborn',
    staralliance: 'Star Alliance',
    unfathomable: 'Unfathomable',
    untamed: 'Untamed'
};

function houseName(code) {
    return HOUSE_NAMES[code] || code;
}

const pct = (value) => `${Math.round(value * 100)}%`;

/**
 * Turn a roster's aggregates into the sentences the page shows. Sentences,
 * not numbers: the numbers are already in the table, and the findings panel
 * exists to say which of them matter.
 *
 * Order is meaning: gems first (they are the product), then decks playing
 * over or under their rating, then how each deck wins - its best opening,
 * and any first-player split too large to ignore.
 *
 * @param {object[]} decks aggregated rows (see ChampionsChallengeService)
 * @param {number} [limit]
 * @returns {{deckId: number, text: string}[]}
 */
function buildFindings(decks, limit = 8) {
    const findings = [];
    const confident = decks.filter((deck) => deck.confident);

    for (const deck of confident.filter((candidate) => candidate.hiddenGem)) {
        findings.push({
            deckId: deck.deckId,
            text:
                `${deck.name} is a hidden gem: it wins ${pct(deck.winRate)} in the lab ` +
                `against a SAS-predicted ${pct(deck.expectedWinRate)}.`
        });
    }

    for (const deck of confident) {
        if (deck.hiddenGem || deck.delta == null) {
            continue;
        }

        if (deck.delta >= 0.08) {
            findings.push({
                deckId: deck.deckId,
                text:
                    `${deck.name} plays above its SAS: ${pct(deck.winRate)} in the lab, ` +
                    `${pct(deck.expectedWinRate)} expected.`
            });
        } else if (deck.delta <= -0.08) {
            findings.push({
                deckId: deck.deckId,
                text:
                    `${deck.name} plays below its SAS in the lab: ${pct(deck.winRate)} ` +
                    `against ${pct(deck.expectedWinRate)} expected.`
            });
        }
    }

    for (const deck of confident) {
        const opening = deck.bestOpening;

        if (opening && deck.winRate != null && opening.winRate - deck.winRate >= 0.1) {
            findings.push({
                deckId: deck.deckId,
                text:
                    `${deck.name} wins ${pct(opening.winRate)} of the games it opens on ` +
                    `${houseName(opening.house)} - its best first call.`
            });
        }
    }

    for (const deck of confident) {
        const first = deck.firstPlayerWinRate;
        const second = deck.secondPlayerWinRate;

        if (first != null && second != null && Math.abs(first - second) >= 0.15) {
            findings.push({
                deckId: deck.deckId,
                text:
                    `${deck.name} wins ${pct(first)} of its games going first but ` +
                    `${pct(second)} going second.`
            });
        }
    }

    return findings.slice(0, limit);
}

module.exports = {
    MIN_CONFIDENT_GAMES,
    MIN_OPENING_GAMES,
    MIN_STYLE_GAMES,
    wilsonLowerBound,
    wilsonInterval,
    sprt,
    sasExpectedScore,
    isHiddenGem,
    buildFindings,
    houseName
};
