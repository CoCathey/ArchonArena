const { DEFAULT_ELO_CONFIG } = require('./eloDefaults');

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
    const positive = ['kFactor', 'provisionalKFactor', 'defaultRating'];
    for (const key of positive) {
        if (typeof config[key] !== 'number' || config[key] <= 0) {
            throw new Error(`Elo config '${key}' must be a positive number`);
        }
    }

    const nonNegative = ['sasWeight', 'ratingFloor', 'provisionalGames'];
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
 * Margin-of-victory multiplier for a finished game. The key differential is
 * clamped into 1..3: a game can end with the loser ahead on keys (concede /
 * timeout while winning the race), which still counts as the narrowest
 * margin rather than an out-of-range lookup.
 *
 * @param {number} winnerKeys
 * @param {number} loserKeys
 * @param {string} resultType one of config.resultTypeMultipliers keys
 * @param {object} config normalized elo config
 */
function movMultiplier(winnerKeys, loserKeys, resultType, config) {
    const keyDiff = Math.max(1, Math.min(3, winnerKeys - loserKeys));
    const keyMultiplier = config.keyDiffMultipliers[keyDiff];
    const resultMultiplier =
        config.resultTypeMultipliers[resultType] ?? config.resultTypeMultipliers.keys;

    return keyMultiplier * resultMultiplier;
}

function kFactorFor(gamesPlayed, config) {
    return gamesPlayed < config.provisionalGames ? config.provisionalKFactor : config.kFactor;
}

/**
 * Calculate the rating changes for a completed rated game.
 *
 * @param {object} game
 * @param {object} game.winner { rating, gamesPlayed, deckSas }
 * @param {object} game.loser  { rating, gamesPlayed, deckSas }
 * @param {number} game.winnerKeys keys forged by the winner at game end
 * @param {number} game.loserKeys  keys forged by the loser at game end
 * @param {string} [game.resultType] 'keys' | 'concede' | 'timeout' (or any
 *                 configured type); defaults to 'keys'
 * @param {object} [configOverrides] admin overrides merged onto defaults
 * @returns {{winner: object, loser: object, movMultiplier: number}}
 *          per player: { newRating, change, expected, kFactor }
 */
function calculateGameResult(game, configOverrides = {}) {
    const config = normalizeConfig(configOverrides);
    const { winner, loser, winnerKeys, loserKeys } = game;
    const resultType = game.resultType || 'keys';

    const sasDiff = (winner.deckSas ?? 0) - (loser.deckSas ?? 0);
    const winnerExpected = expectedScore(winner.rating, loser.rating, sasDiff, config);
    const loserExpected = 1 - winnerExpected;

    const mov = movMultiplier(winnerKeys, loserKeys, resultType, config);

    const winnerK = kFactorFor(winner.gamesPlayed ?? 0, config);
    const loserK = kFactorFor(loser.gamesPlayed ?? 0, config);

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
    normalizeConfig,
    expectedScore,
    movMultiplier,
    kFactorFor,
    calculateGameResult
};
