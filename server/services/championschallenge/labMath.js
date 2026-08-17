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
    wilsonLowerBound,
    sasExpectedScore,
    isHiddenGem,
    buildFindings,
    houseName
};
