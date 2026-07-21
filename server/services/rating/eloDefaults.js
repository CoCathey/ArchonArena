/**
 * Default configuration for the Archon Arena rating engine.
 *
 * Every value here is intended to be overridable at runtime by site admins
 * (via the settings service); these defaults apply when no override exists.
 * The calculator itself is pure and receives the effective config as an
 * argument, so it has no dependency on where the values come from.
 */
const DEFAULT_ELO_CONFIG = {
    // Rating assigned to a player's first rated game.
    defaultRating: 1200,

    // No rating can drop below this.
    ratingFloor: 100,

    // Standard K-factor once a player is established.
    kFactor: 32,

    // Higher K while a player is provisional so ratings converge quickly.
    provisionalKFactor: 64,

    // A player is provisional until they have completed this many rated games.
    provisionalGames: 10,

    // How many rating points of expectation shift one point of SAS (deck
    // power) difference is worth. With sasWeight 4, a 25-SAS stronger deck
    // gives the same expected-score shift as a 100-point rating advantage.
    // Set to 0 to ignore deck power entirely.
    sasWeight: 4,

    // Margin-of-victory multipliers keyed by key differential
    // (winner keys - loser keys, clamped to 1..3). A 3-0 forge-out moves
    // ratings more than a narrow 3-2 win. Applied to both players so the
    // exchange stays zero-sum.
    keyDiffMultipliers: {
        1: 1.0,
        2: 1.1,
        3: 1.25
    },

    // Multipliers by how the game ended. Applied on top of the key
    // differential multiplier. Admins may e.g. discount timeout wins.
    resultTypeMultipliers: {
        keys: 1.0, // won by forging the third key
        concede: 1.0,
        timeout: 1.0
    }
};

module.exports = { DEFAULT_ELO_CONFIG };
