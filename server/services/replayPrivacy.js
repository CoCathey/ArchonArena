/**
 * ARCHON (F3): who may read the hidden zones inside a recording.
 *
 * A version 4 recording carries each player's hand beside every board frame
 * (`snapshots[].hands`), and a version 6 one the owner's view of their
 * archives (`snapshots[].archives`), both indexing into a `handCards` table
 * that is separate from the public `cards` table on purpose: the public
 * table only ever learns about cards that showed in an open zone, so the
 * hidden zones can be removed without a trace by dropping their own keys.
 * (The facedown archives COUNT in the board frames is public - a live
 * spectator sees that much - and is untouched here.)
 *
 * The rules this module enforces at the point of serving:
 *
 *   - a share link never carries a hand. The promise printed on the share
 *     endpoint - "a link can never reveal more than watching the game would
 *     have" - predates hand recording and survives it.
 *   - a player reads only their OWN hand, and only while they hold the
 *     Archon tier's `advanced_replays`. The opponent's hand history stays
 *     theirs: a finished game does not turn what someone held into public
 *     record.
 *   - an admin reads both, because a report about what happened in a game
 *     (or about how improbably well someone drew) cannot be investigated
 *     without seeing it.
 *
 * Pure and defensive: recordings from before version 4 pass through untouched,
 * and a malformed hand entry is dropped rather than served.
 */

/**
 * A copy of `replay` in which only the named players' hands remain.
 *
 * The `handCards` table is rebuilt to hold nothing but the entries the kept
 * hands actually reference (indices remapped to match). Without that, keeping
 * one player's hand would still ship the other player's drawn-but-never-played
 * cards in the table - unlabelled, but present, which is exactly the sort of
 * leak the separate table exists to prevent.
 *
 * @param {object} replay a recording as stored in `GameReplays."Data"`
 * @param {string[]} [keepNames] players whose hands stay; empty removes all
 * @returns {object} a new recording; the input is not modified
 */
function stripReplayHands(replay, keepNames = []) {
    if (!replay || typeof replay !== 'object') {
        return replay;
    }

    const snapshots = Array.isArray(replay.snapshots) ? replay.snapshots : [];
    const table = Array.isArray(replay.handCards) ? replay.handCards : [];
    const keep = new Set((Array.isArray(keepNames) ? keepNames : []).filter(Boolean));

    // First-use order, so the kept table reads in the order the hands do.
    const remap = new Map();
    const keptTable = [];

    const remapped = (index) => {
        if (!Number.isInteger(index) || index < 0 || index >= table.length) {
            return null;
        }

        if (!remap.has(index)) {
            remap.set(index, keptTable.length);
            keptTable.push(table[index]);
        }

        return remap.get(index);
    };

    // Hands since v4, the owner's view of their archives since v6: one
    // side channel, one set of rules, one strip.
    const HIDDEN_ZONES = ['hands', 'archives'];

    const strippedSnapshots = snapshots.map((snapshot) => {
        if (
            !snapshot ||
            typeof snapshot !== 'object' ||
            !HIDDEN_ZONES.some((zone) => snapshot[zone])
        ) {
            return snapshot;
        }

        const rest = { ...snapshot };

        for (const zone of HIDDEN_ZONES) {
            const piles = rest[zone];

            delete rest[zone];

            if (keep.size === 0 || !piles || typeof piles !== 'object') {
                continue;
            }

            const kept = {};

            for (const [name, entries] of Object.entries(piles)) {
                if (!keep.has(name) || !Array.isArray(entries)) {
                    continue;
                }

                kept[name] = entries.map(remapped).filter((entry) => entry !== null);
            }

            if (Object.keys(kept).length > 0) {
                rest[zone] = kept;
            }
        }

        return rest;
    });

    const result = { ...replay, snapshots: strippedSnapshots };

    delete result.handCards;

    if (keptTable.length > 0) {
        result.handCards = keptTable;
    }

    return result;
}

/** Every player named in a recording's header, for the admin read. */
function replayPlayerNames(replay) {
    return ((replay && replay.players) || [])
        .map((player) => player && player.name)
        .filter(Boolean);
}

module.exports = { stripReplayHands, replayPlayerNames };
