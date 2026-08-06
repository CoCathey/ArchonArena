const { DEFAULT_ELO_CONFIG } = require('./eloDefaults');

// A KeyForge game is won by forging three keys (player.keys is red/blue/yellow),
// and the margin tiers are expressed against that.
const WINNING_KEYS = 3;

/**
 * Pure rating calculator for Archon Arena's SAS-adjusted Elo.
 *
 * Chess Elo, modified two ways:
 *  1. Deck power handicap: the expected score is shifted by the SAS
 *     difference between the two decks (scaled by config.sasWeight), so
 *     winning with a much stronger deck earns less and upsetting with a
 *     weaker deck earns more.
 *  2. Margin of victory: the rating exchange is scaled by the key
 *     differential of the result (and by how the game ended), so a 3-0
 *     forge-out moves ratings more than a 3-2 squeaker.
 *
 * All functions are pure; the effective configuration is passed in so the
 * caller decides where settings come from (admin settings service, tests,
 * recalculation jobs with historical configs, etc.).
 */

function normalizeConfig(overrides = {}) {
    const config = {
        ...DEFAULT_ELO_CONFIG,
        ...overrides,
        keyDiffMultipliers: {
            ...DEFAULT_ELO_CONFIG.keyDiffMultipliers,
            ...(overrides.keyDiffMultipliers || {})
        },
        resultTypeMultipliers: {
            ...DEFAULT_ELO_CONFIG.resultTypeMultipliers,
            ...(overrides.resultTypeMultipliers || {})
        }
    };

    validateConfig(config);

    return config;
}

function validateConfig(config) {
    const positive = [
        'kFactor',
        'provisionalKFactor',
        'defaultRating',
        'highRatingKFactor',
        'topRatingKFactor',
        'tournamentKMultiplier'
    ];
    for (const key of positive) {
        if (typeof config[key] !== 'number' || config[key] <= 0) {
            throw new Error(`Elo config '${key}' must be a positive number`);
        }
    }

    const nonNegative = [
        'sasWeight',
        'ratingFloor',
        'provisionalGames',
        'highRatingThreshold',
        'topRatingThreshold'
    ];
    for (const key of nonNegative) {
        if (typeof config[key] !== 'number' || config[key] < 0) {
            throw new Error(`Elo config '${key}' must be a non-negative number`);
        }
    }

    for (const [keyDiff, multiplier] of Object.entries(config.keyDiffMultipliers)) {
        if (typeof multiplier !== 'number' || multiplier <= 0) {
            throw new Error(`Elo config keyDiffMultipliers['${keyDiff}'] must be positive`);
        }
    }

    for (const [resultType, multiplier] of Object.entries(config.resultTypeMultipliers)) {
        if (typeof multiplier !== 'number' || multiplier <= 0) {
            throw new Error(`Elo config resultTypeMultipliers['${resultType}'] must be positive`);
        }
    }
}

/**
 * Expected score (win probability plus half draw probability, per Elo) for
 * a player, given both ratings and the SAS difference between the decks.
 *
 * @param {number} playerRating
 * @param {number} opponentRating
 * @param {number} sasDifferential player deck SAS minus opponent deck SAS
 * @param {object} config normalized elo config
 * @returns {number} expected score in (0, 1)
 */
function expectedScore(playerRating, opponentRating, sasDifferential, config) {
    const effectiveDiff = playerRating - opponentRating + config.sasWeight * sasDifferential;

    return 1 / (1 + Math.pow(10, -effectiveDiff / 400));
}

/**
 * ARCHON: the margin tier for a finished game, measured on the LOSER.
 *
 * keyDiffMultipliers is labelled 1 = 3-2, 2 = 3-1, 3 = 3-0: the tiers assume a
 * winner who finished on three keys, and what varies between them is how close
 * the loser got. Deriving the tier from `winnerKeys - loserKeys` only agrees
 * with that when the winner actually forged three - which is every win BY KEYS
 * and no other kind.
 *
 * A concession ends the game before the winner forges their third key, so the
 * subtraction quietly demoted those games a tier or two: conceding to someone
 * on two keys with none of your own scored as a 3-1 rather than the 3-0 it
 * plainly was, and a player being beaten comprehensively earned their opponent
 * LESS by giving up early than by playing it out. Timeouts had the same
 * problem for the same reason.
 *
 * Measuring `3 - loserKeys` fixes both and changes nothing about a normal win:
 * when the winner has three keys the two expressions are identical, so only
 * games that ended some other way move. How the game ended is expressed by
 * resultTypeMultipliers, which is the correct lever for "a concession is worth
 * less" and is left alone here.
 *
 * Clamped into 1..3: the loser can finish on more keys than the winner (a
 * concession while ahead on the race), which is the narrowest margin rather
 * than an out-of-range lookup.
 *
 * A missing count reads as none forged, which is what the old subtraction did
 * with it too - so this is not a new assumption, and in practice the count is
 * always written before a game is rated.
 *
 * @param {number} loserKeys keys the losing player finished with
 */
function keyDifferential(loserKeys) {
    return Math.max(1, Math.min(3, WINNING_KEYS - (Number(loserKeys) || 0)));
}

/**
 * Margin-of-victory multiplier for a finished game.
 *
 * @param {number} keyDiff the margin tier, 1..3 (see keyDifferential)
 * @param {string} resultType one of config.resultTypeMultipliers keys
 * @param {object} config normalized elo config
 */
function movMultiplier(keyDiff, resultType, config) {
    const keyMultiplier = config.keyDiffMultipliers[Math.max(1, Math.min(3, keyDiff))];
    const resultMultiplier =
        config.resultTypeMultipliers[resultType] ?? config.resultTypeMultipliers.keys;

    return keyMultiplier * resultMultiplier;
}

/**
 * K-factor for one player. Provisional players converge fast regardless of
 * rating; established players use FIDE-style tiers - the higher the rating,
 * the smaller the K, so the top of the ladder is stable.
 *
 * @param {number} gamesPlayed
 * @param {number} rating the player's current rating
 * @param {object} config normalized elo config
 */
function kFactorFor(gamesPlayed, rating, config) {
    if (gamesPlayed < config.provisionalGames) {
        return config.provisionalKFactor;
    }

    if (rating >= config.topRatingThreshold) {
        return config.topRatingKFactor;
    }

    if (rating >= config.highRatingThreshold) {
        return config.highRatingKFactor;
    }

    return config.kFactor;
}

/**
 * Calculate the rating changes for a completed rated game.
 *
 * @param {object} game
 * @param {object} game.winner { rating, gamesPlayed, deckSas }
 * @param {object} game.loser  { rating, gamesPlayed, deckSas }
 * @param {number} [game.loserKeys] keys forged by the loser at game end; the
 *                 margin tier is measured from this alone, and the winner's
 *                 keys are deliberately not an input (see keyDifferential)
 * @param {number} [game.keyDiff] a pre-computed margin tier, used in place of
 *                 loserKeys when replaying a stored result
 * @param {string} [game.resultType] 'keys' | 'concede' | 'timeout' (or any
 *                 configured type); defaults to 'keys'
 * @param {boolean} [game.isTournament] tournament games move ratings more
 *                 (config.tournamentKMultiplier applied to both K-factors)
 * @param {object} [configOverrides] admin overrides merged onto defaults
 * @returns {{winner: object, loser: object, movMultiplier: number}}
 *          per player: { newRating, change, expected, kFactor }
 */
function calculateGameResult(game, configOverrides = {}) {
    const config = normalizeConfig(configOverrides);
    const { winner, loser, loserKeys } = game;
    const resultType = game.resultType || 'keys';

    // Only apply the SAS handicap when BOTH decks have a known SAS. Treating a
    // single missing SAS as 0 would model that deck as the weakest possible
    // (real SAS runs ~40-120) and skew the exchange badly - and missing SAS is
    // routine (DoK enrichment is async/rate-limited; a deleted deck nulls the
    // join). With one side unknown we fall back to an even (SAS-neutral) match.
    const bothSasKnown =
        winner.deckSas !== null &&
        winner.deckSas !== undefined &&
        loser.deckSas !== null &&
        loser.deckSas !== undefined;
    const sasDiff = bothSasKnown ? winner.deckSas - loser.deckSas : 0;
    const winnerExpected = expectedScore(winner.rating, loser.rating, sasDiff, config);
    const loserExpected = 1 - winnerExpected;

    // A caller replaying a historical game has the stored differential and not
    // the raw key counts, so it may pass keyDiff directly; everyone rating a
    // live game passes the keys and the tier is derived from the loser's.
    const keyDiff = game.keyDiff != null ? game.keyDiff : keyDifferential(loserKeys);
    const mov = movMultiplier(keyDiff, resultType, config);
    const tournamentMultiplier = game.isTournament ? config.tournamentKMultiplier : 1;

    const winnerK =
        kFactorFor(winner.gamesPlayed ?? 0, winner.rating, config) * tournamentMultiplier;
    const loserK = kFactorFor(loser.gamesPlayed ?? 0, loser.rating, config) * tournamentMultiplier;

    const winnerChange = winnerK * mov * (1 - winnerExpected);
    const loserChange = loserK * mov * (0 - loserExpected);

    const winnerNewRating = Math.max(config.ratingFloor, winner.rating + winnerChange);
    const loserNewRating = Math.max(config.ratingFloor, loser.rating + loserChange);

    return {
        winner: {
            newRating: Math.round(winnerNewRating),
            change: Math.round(winnerNewRating) - winner.rating,
            expected: winnerExpected,
            kFactor: winnerK
        },
        loser: {
            newRating: Math.round(loserNewRating),
            change: Math.round(loserNewRating) - loser.rating,
            expected: loserExpected,
            kFactor: loserK
        },
        movMultiplier: mov
    };
}

module.exports = {
    WINNING_KEYS,
    normalizeConfig,
    expectedScore,
    keyDifferential,
    movMultiplier,
    kFactorFor,
    calculateGameResult
};
