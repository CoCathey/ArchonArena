/**
 * ARCHON (N1): derive the interesting moments of a recorded game from its
 * board snapshots.
 *
 * A key forge is the only event in KeyForge that always matters, and scrubbing
 * a 300-entry log to find the three of them is the main reason stepping through
 * a replay is tedious. The snapshots already carry each player's key count at
 * every log position, so the forges can be read straight off them - no second
 * source of truth, and nothing new to record.
 *
 * Derived from snapshots rather than parsed out of the message text: log
 * wording is localised and changes with the engine, key counts do not.
 *
 * Version 1 recordings have no snapshots at all. They yield no markers, and the
 * viewer simply shows no jump controls rather than showing wrong ones.
 *
 * @param {Array<{messageIndex: number, board?: object}>} snapshots
 * @returns {Array<{messageIndex: number, player: string, keys: number}>}
 */
/**
 * How many keys a player has forged, from a snapshot's `stats.keys`.
 *
 * ARCHON: this used to be `Number(stats.keys)`. `stats.keys` is the engine's
 * per-colour map - `{ red: false, blue: true, yellow: false }` (player.js
 * `getStats`) - and `Number({})` is NaN, so the finite check below rejected
 * every player and `findKeyForges` always returned an empty array. The jump
 * controls it feeds have therefore never appeared on any replay.
 *
 * The unit test did not catch it because its fixture passes a plain number,
 * which is a shape the engine never produces. Numbers are still accepted here
 * - defensively, for any recording or caller that has one - but the map is the
 * real format and is what the count is derived from.
 *
 * @param {object|number|null|undefined} keys
 * @returns {number|null} null when there is nothing countable
 */
export function keyCount(keys) {
    if (typeof keys === 'number') {
        return Number.isFinite(keys) ? keys : null;
    }

    if (!keys || typeof keys !== 'object') {
        return null;
    }

    return Object.values(keys).filter(Boolean).length;
}

export function findKeyForges(snapshots) {
    const forges = [];
    const previousKeys = new Map();

    for (const snapshot of snapshots || []) {
        const players = snapshot?.board?.players;

        if (!Array.isArray(players)) {
            continue;
        }

        for (const player of players) {
            const keys = keyCount(player?.stats?.keys);

            if (!player?.name || keys === null) {
                continue;
            }

            const before = previousKeys.get(player.name);

            // The first snapshot establishes the baseline rather than
            // reporting a forge - a game with pre-forged keys (or a recording
            // that started late) would otherwise open with a phantom forge.
            if (before !== undefined && keys > before) {
                forges.push({ messageIndex: snapshot.messageIndex, player: player.name, keys });
            }

            previousKeys.set(player.name, keys);
        }
    }

    return forges;
}

/**
 * Order a snapshot's players so `perspective` is rendered last - i.e. at the
 * bottom, where your own side of the table is in the live game.
 *
 * Returns the players untouched when the name is not in this game, so a
 * perspective left over from another replay cannot blank the board.
 */
export function orderPlayersForPerspective(players, perspective) {
    if (!Array.isArray(players) || !perspective) {
        return players;
    }

    if (!players.some((player) => player?.name === perspective)) {
        return players;
    }

    return [
        ...players.filter((player) => player?.name !== perspective),
        ...players.filter((player) => player?.name === perspective)
    ];
}
